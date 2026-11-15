import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, datRows } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('DAT 特殊分隔与家族列不丢失',()=>{
  const result=inspect(primary);assert.equal(result.rows.length,2);assert.equal(result.columns[0],'BEGDOC');
  assert.equal(result.rows[1][2],'B0001');assert.equal(result.rows[1][6],'VOL2');
});
test('字段内换行及空末列保持',()=>{
  assert.deepEqual(datRows('þAþ\x14þBþ\r\nþline®nextþ\x14þþ\r\n'),[['A','B'],['line\nnext','']]);
  assert.throws(()=>datRows('þunclosed'));
});
test('公开 production 不声明受限原件链接',async()=>{
  const privateSet=JSON.parse(await resource('/production'));const publicSet=JSON.parse(await resource('/public'));
  assert.equal(privateSet.visibility,'restricted');assert.equal(publicSet.native,null);
  assert.notEqual(privateSet.id,publicSet.id);assert.match((await resource('/images.opt')).toString(),/VOL2/);
});
