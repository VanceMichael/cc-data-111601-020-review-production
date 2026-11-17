import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { parseManifest, analyzeFullProduction, analyzePublicDelivery } from './production.mjs';

async function readJson(request, limit = 16384) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

// 交付资源加载器：来源不可达属于收件问题（resource_unavailable），
// 不伪造字节、不推测页面，让分析流程把问题准确登记进 intake。
function makeLoader(source) {
  return async path => {
    try {
      const result = await acquire(source, path);
      return { status: 'ok', bytes: result.bytes };
    } catch (error) {
      return { status: 'error', reason: error.message };
    }
  };
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname.startsWith('/production-objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.productionObject(url.pathname.slice(20)));
      }
      if (url.pathname === '/productions' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.listProductions()));
      }
      if (url.pathname.startsWith('/productions/') && request.method === 'GET') {
        return response.end(JSON.stringify(await store.production(url.pathname.slice(13))));
      }
      if (url.pathname.startsWith('/evidence/') && request.method === 'GET') {
        const evidenceId = decodeURIComponent(url.pathname.slice(10));
        return response.end(JSON.stringify(await store.evidence(evidenceId)));
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
      // 按一次 production 交付接收：清单结构非法（422）与收件问题（201，问题登记在案）分层处理
      if (url.pathname === '/productions' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const loader = makeLoader(source);
        const manifestAcquired = await loader(payload.path);
        if (manifestAcquired.status !== 'ok') throw new Error(manifestAcquired.reason);
        const manifestBytes = manifestAcquired.bytes;
        const manifest = parseManifest(manifestBytes);
        let intake;
        if (manifest.visibility === 'restricted' || typeof manifest.dat === 'string') {
          if (typeof manifest.dat !== 'string' || typeof manifest.opt !== 'string') throw new Error('manifest_load_files');
          const datAcquired = await loader(manifest.dat);
          if (datAcquired.status !== 'ok') throw new Error(datAcquired.reason);
          const optAcquired = await loader(manifest.opt);
          if (optAcquired.status !== 'ok') throw new Error(optAcquired.reason);
          intake = await analyzeFullProduction({ manifest, manifestPath: payload.path,
            manifestBytes, datBytes: datAcquired.bytes, optBytes: optAcquired.bytes, loader });
        } else {
          intake = await analyzePublicDelivery({ manifest, manifestPath: payload.path,
            manifestBytes, loader });
        }
        const record = await store.acceptProduction({
          source: new URL(payload.path, source).href, intake });
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
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
