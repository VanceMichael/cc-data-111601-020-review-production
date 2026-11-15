import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function startProvider({ port = 0 } = {}) {
  const contract = JSON.parse(await readFile(join(root, 'fixtures/upstream.json'), 'utf8'));
  const requests = [];
  const callbacks = [];
  let phase = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/_requests') return response.end(JSON.stringify(requests));
      if (url.pathname === '/_callbacks') return response.end(JSON.stringify(callbacks));
      if (url.pathname === '/_phase' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const next = JSON.parse(Buffer.concat(chunks).toString());
        if (!Number.isInteger(next.phase) || next.phase < 0 || next.phase > 8) {
          response.writeHead(400); return response.end('invalid_phase');
        }
        phase = next.phase; return response.end(JSON.stringify({ phase }));
      }
      requests.push({ method: request.method, path: request.url, headers: request.headers, phase });
      if (url.pathname === '/receipts' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        callbacks.push({ body: Buffer.concat(chunks).toString('base64'), phase });
        response.writeHead(phase === 1 ? 503 : 202); return response.end();
      }
      if (url.pathname === '/catalog') {
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify(contract.catalog));
      }
      const resource = contract.resources[url.pathname];
      if (!resource) { response.writeHead(404); return response.end('not_found'); }
      const selected = { ...resource, ...(resource.phases?.[String(phase)] ?? {}) };
      if (selected.status && selected.status !== 200) {
        response.writeHead(selected.status); return response.end(selected.body ?? 'unavailable');
      }
      let bytes = selected.file ? await readFile(join(root, 'fixtures', selected.file)) : Buffer.from(selected.body ?? '');
      if (selected.protocol === 'entity' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const query = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(query.representations) || !Array.isArray(query.fields)) {
          response.writeHead(400); return response.end('entity_query');
        }
        const supplied = JSON.parse(bytes.toString());
        const key = entity => JSON.stringify([entity.__typename, Object.entries(entity.key).sort()]);
        const entities = query.representations.map(representation => {
          const found = supplied.data.entities.find(entity => key(entity) === key(representation));
          return found ? { ...found, fields: Object.fromEntries(Object.entries(found.fields)
            .filter(([field]) => query.fields.includes(field))) } : null;
        });
        bytes = Buffer.from(JSON.stringify({ data: { entities }, errors: supplied.errors ?? [] }));
      }
      if (selected.protocol === 'symbol' && url.searchParams.has('addresses')) {
        const addresses = [...new Set(url.searchParams.get('addresses').split(','))];
        if (addresses.length > 2 || addresses.some(address => !/^\d+$/.test(address))) {
          response.writeHead(413); return response.end('symbol_batch_limit');
        }
        const supplied = JSON.parse(bytes.toString());
        bytes = Buffer.from(JSON.stringify({ buildId: supplied.buildId,
          addresses: Object.fromEntries(addresses.filter(address => Object.hasOwn(supplied.addresses, address))
            .map(address => [address, supplied.addresses[address]])),
          missing: addresses.filter(address => !Object.hasOwn(supplied.addresses, address)) }));
      }
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
      response.setHeader('ETag', etag);
      response.setHeader('Content-Type', selected.type ?? 'application/octet-stream');
      response.setHeader('Accept-Ranges', 'bytes');
      if (request.headers['if-match'] && request.headers['if-match'] !== etag) {
        response.writeHead(412); return response.end('version_changed');
      }
      if (request.headers['if-none-match'] === etag) { response.writeHead(304); return response.end(); }
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        const begin = match ? Number(match[1]) : -1;
        const end = match?.[2] ? Number(match[2]) : bytes.length - 1;
        if (!match || begin > end || end >= bytes.length || begin < 0) {
          response.writeHead(416); return response.end('invalid_range');
        }
        response.setHeader('Content-Range', `bytes ${begin}-${end}/${bytes.length}`);
        response.statusCode = 206;
        bytes = bytes.subarray(begin, end + 1);
      }
      if (request.method === 'HEAD') return response.end();
      const width = Math.max(1, selected.chunkSize ?? bytes.length);
      for (let offset = 0; offset < bytes.length; offset += width) response.write(bytes.subarray(offset, offset + width));
      response.end();
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, contract,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = await startProvider({ port: Number(process.env.PORT ?? 4101) });
  console.log(JSON.stringify({ source: provider.url }));
}
