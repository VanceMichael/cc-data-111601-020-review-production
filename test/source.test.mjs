import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startProvider } from '../src/provider.mjs';

test('来源全部资源与已声明阶段均可真实请求，不读取宿主资料', async () => {
  const manifest = JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
  const provider = await startProvider();
  try {
    for (const phase of [0,1,2]) {
      const changed = await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({phase}) });
      assert.equal(changed.status,200);
      for (const [path,resource] of Object.entries(manifest.resources)) {
        const expected={...resource,...(resource.phases?.[String(phase)]??{})};
        const response=await fetch(`${provider.url}${path}`);
        assert.equal(response.status,expected.status??200,`${path} phase=${phase}`);
        const bytes=Buffer.from(await response.arrayBuffer());
        if (response.ok && expected.file) assert.deepEqual(bytes,
          await readFile(new URL(`../fixtures/${expected.file}`,import.meta.url)));
      }
    }
  } finally { await provider.close(); }
});
