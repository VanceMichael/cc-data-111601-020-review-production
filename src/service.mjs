import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect, inspectOpt } from './reader.mjs';
import { readManifest, planProduction, finalizeProduction, digestOf } from './delivery.mjs';
import { startProvider } from './provider.mjs';

async function readJson(request, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function receipt(store, source, manifestPath) {
  const manifestResult = await acquire(source, manifestPath);
  let manifestValue;
  try { manifestValue = JSON.parse(manifestResult.bytes.toString('utf8')); }
  catch { throw new Error('production_manifest_json'); }
  const manifest = readManifest(manifestValue);

  let dat = null; let datIssue = null;
  let opt = null; let optIssue = null;
  if (manifest.dat) {
    try { dat = inspect((await acquire(source, manifest.dat)).bytes); }
    catch (error) { datIssue = { code: 'dat_unavailable', path: manifest.dat, reason: error.message }; }
  }
  if (manifest.opt) {
    try { opt = inspectOpt((await acquire(source, manifest.opt)).bytes); }
    catch (error) { optIssue = { code: 'opt_unavailable', path: manifest.opt, reason: error.message }; }
  }

  const planned = planProduction({ manifest, manifestPath, dat, opt, datIssue, optIssue });

  // 每个唯一路径只领取一次；声明本身保留在各自条目上。
  const fetched = new Map();
  const retrieve = async path => {
    if (fetched.has(path)) return fetched.get(path);
    let outcome;
    try {
      const result = await acquire(source, path);
      outcome = { status: 'received', digest: digestOf(result.bytes), bytes: result.bytes };
    } catch (error) { outcome = { status: 'missing', error: error.message }; }
    fetched.set(path, outcome);
    return outcome;
  };
  const outcomes = new Map();
  for (const entry of planned.declarations) {
    const outcome = await retrieve(entry.path);
    outcomes.set(entry.key, outcome);
    if (outcome.status === 'received') await store.put(outcome.bytes);
  }

  const record = finalizeProduction(planned, outcomes);
  return store.saveDelivery(record);
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname === '/deliveries' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.deliveries()));
      }
      if (url.pathname.startsWith('/deliveries/') && request.method === 'GET') {
        const record = await store.delivery(decodeURIComponent(url.pathname.slice(12)));
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(record));
      }
      if (url.pathname.startsWith('/receipts/') && request.method === 'GET') {
        const record = await store.receipt(decodeURIComponent(url.pathname.slice(10)));
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(record));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/productions' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.manifest !== 'string') throw new Error('manifest_required');
        const record = await receipt(store, source, payload.manifest);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
