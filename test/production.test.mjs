import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeFullProduction, analyzePublicDelivery, parseManifest, joinResource, volumeBase } from '../src/production.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const encDAT = rows => Buffer.from(rows.map(row => row.map(value => `þ${value}þ`).join('\u0014')).join('\r\n'));
const DAT_HEADER = ['BEGDOC', 'ENDDOC', 'BEGATTACH', 'ENDATTACH', 'NATIVE', 'TEXT', 'VOLUME'];

const fullManifest = {
  id: 'P-PRIVATE', visibility: 'restricted', dat: '/primary', opt: '/images.opt',
  volumes: { VOL1: '/VOL1/', VOL2: '/VOL2/' },
};
const publicManifest = {
  id: 'P-PUBLIC', visibility: 'public', evidenceIds: ['B0001'],
  resources: { text: '/PUBLIC/text/parent.txt' }, native: null,
};

function memoryLoader(store) {
  return async path => Object.hasOwn(store, path) && store[path] !== undefined
    ? { status: 'ok', bytes: store[path] }
    : { status: 'error', reason: 'source_status_404' };
}
const codes = result => result.problems.map(problem => problem.code);

async function buildStore(overrides = {}) {
  const base = {
    '/primary': await fixture('primary.bin'),
    '/images.opt': await fixture('resource-01.bin'),
    '/VOL1/native/parent.txt': await fixture('resource-02.bin'),
    '/VOL1/text/parent.txt': await fixture('resource-03.bin'),
    '/VOL2/native/child.txt': await fixture('resource-04.bin'),
    '/VOL2/text/child.txt': await fixture('resource-05.bin'),
    '/VOL1/images/1.tif': await fixture('resource-06.bin'),
    '/VOL1/images/2.tif': await fixture('resource-07.bin'),
    '/VOL2/images/3.tif': await fixture('resource-08.bin'),
    '/PUBLIC/text/parent.txt': await fixture('resource-09.bin'),
  };
  return { ...base, ...overrides };
}

test('完整 production 接收：家族、页码范围、图像页与原生/文本全部核对通过', async () => {
  const store = await buildStore();
  const manifestBytes = Buffer.from(JSON.stringify(fullManifest));
  const result = await analyzeFullProduction({ manifest: fullManifest, manifestPath: '/production',
    manifestBytes, datBytes: store['/primary'], optBytes: store['/images.opt'], loader: memoryLoader(store) });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.problems, []);
  assert.equal(result.productionId, 'P-PRIVATE');
  assert.deepEqual(result.evidenceIds, ['B0001', 'B0003']);
  assert.equal(result.families.length, 1);
  const family = result.families[0];
  assert.equal(family.familyId, 'B0001');
  assert.deepEqual(family.members, ['B0001', 'B0003']);
  assert.deepEqual(family.volumes, ['VOL1', 'VOL2']);
  assert.equal(family.complete, true);
  assert.deepEqual(result.documents.map(d => [d.documentId, d.role, d.familyId]),
    [['B0001', 'parent', 'B0001'], ['B0003', 'attachment', 'B0001']]);
  assert.equal(result.pages.length, 3);
  assert.ok(result.pages.every(page => page.image?.digest));
  assert.deepEqual(result.pages.map(page => [page.pageId, page.documentId, page.familyId]),
    [['B0001', 'B0001', 'B0001'], ['B0002', 'B0001', 'B0001'], ['B0003', 'B0003', 'B0001']]);
  for (const entry of result.evidenceResources) {
    assert.ok(entry.native?.digest, `${entry.documentId} 原生应已声明并领取`);
    assert.ok(entry.text?.digest, `${entry.documentId} 文本应已声明并领取`);
  }
  assert.equal(result.blobs.size, 7);
});

test('图像来源 404 留下准确收件问题，其余资源仍登记，不推测缺页', async () => {
  const store = await buildStore({ '/VOL2/images/3.tif': undefined });
  const manifestBytes = Buffer.from(JSON.stringify(fullManifest));
  const result = await analyzeFullProduction({ manifest: fullManifest, manifestPath: '/production',
    manifestBytes, datBytes: store['/primary'], optBytes: store['/images.opt'], loader: memoryLoader(store) });
  assert.equal(result.status, 'accepted_with_issues');
  const missing = result.problems.find(p => p.code === 'resource_unavailable');
  assert.ok(missing);
  assert.equal(missing.detail.resource, '/VOL2/images/3.tif');
  assert.equal(missing.detail.familyId, 'B0001');
  const page3 = result.pages.find(page => page.pageId === 'B0003');
  assert.equal(page3.image, null);
  // OPT 只明列 3 页，结果里也只有 3 页，没有任何按连续页码补出的页面
  assert.deepEqual(result.pages.map(page => page.pageId), ['B0001', 'B0002', 'B0003']);
  // 家族成员 B0003 的图像未到齐，跨卷家族标记为未齐
  assert.equal(result.families[0].complete, false);
});

test('OPT 声明页数与实际明列页数不符按问题登记，不反推缺失页', async () => {
  const opt = Buffer.from('B0001,VOL1,images/1.tif,Y,,,9\nB0002,VOL1,images/2.tif,,,,\n'
    + 'B0003,VOL2,images/3.tif,Y,,,1\n');
  const store = await buildStore();
  const result = await analyzeFullProduction({ manifest: fullManifest,
    manifestBytes: Buffer.from(JSON.stringify(fullManifest)),
    datBytes: store['/primary'], optBytes: opt, loader: memoryLoader(store) });
  const mismatch = result.problems.find(p => p.code === 'page_count_mismatch');
  assert.ok(mismatch);
  assert.deepEqual(mismatch.detail.declared, 9);
  assert.deepEqual(mismatch.detail.observed, 2);
  assert.equal(result.pages.length, 3);
});

test('同一页码被重复归属时准确记录 page_duplicate_attribution', async () => {
  const opt = Buffer.from('B0001,VOL1,images/1.tif,Y,,,2\nB0002,VOL1,images/2.tif,,,,\n'
    + 'B0002,VOL2,images/3.tif,Y,,,1\n');
  const store = await buildStore();
  const result = await analyzeFullProduction({ manifest: fullManifest,
    manifestBytes: Buffer.from(JSON.stringify(fullManifest)),
    datBytes: store['/primary'], optBytes: opt, loader: memoryLoader(store) });
  const dup = result.problems.find(p => p.code === 'page_duplicate_attribution');
  assert.ok(dup);
  assert.equal(dup.detail.pageId, 'B0002');
});

test('DAT 声明范围与 OPT 明列页不一致记录 page_range_mismatch，不推测缺失页', async () => {
  // DAT 声称 B0001 到 B0003 共 3 页；OPT 只明列 2 页且末页为 B0002
  const dat = encDAT([DAT_HEADER,
    ['B0001', 'B0003', 'B0001', 'B0003', 'native/parent.txt', 'text/parent.txt', 'VOL1']]);
  const opt = Buffer.from('B0001,VOL1,images/1.tif,Y,,,2\nB0002,VOL1,images/2.tif,,,,\n');
  const store = await buildStore();
  const result = await analyzeFullProduction({ manifest: fullManifest,
    manifestBytes: Buffer.from(JSON.stringify(fullManifest)),
    datBytes: dat, optBytes: opt, loader: memoryLoader(store) });
  const mismatch = result.problems.find(p => p.code === 'page_range_mismatch');
  assert.ok(mismatch);
  assert.deepEqual(mismatch.detail.declared, ['B0001', 'B0003']);
  assert.deepEqual(mismatch.detail.observed, ['B0001', 'B0002']);
  // B0003 从未在 OPT 出现，只登记事实，绝不补出图像或占位页
  assert.deepEqual(result.pages.map(page => page.pageId), ['B0001', 'B0002']);
  assert.ok(!result.pages.some(page => page.pageId === 'B0003'));
  assert.equal(result.families[0].complete, false);
});

test('家族跨卷未齐：成员在 OPT 缺失时家族标记不完整', async () => {
  const opt = Buffer.from('B0001,VOL1,images/1.tif,Y,,,2\nB0002,VOL1,images/2.tif,,,,\n');
  const store = await buildStore();
  const result = await analyzeFullProduction({ manifest: fullManifest,
    manifestBytes: Buffer.from(JSON.stringify(fullManifest)),
    datBytes: store['/primary'], optBytes: opt, loader: memoryLoader(store) });
  assert.ok(codes(result).includes('page_missing_from_opt'));
  assert.equal(result.families[0].complete, false);
  assert.deepEqual(result.families[0].volumes, ['VOL1', 'VOL2']);
});

test('未声明的卷不允许按同名路径私自领取', async () => {
  const manifest = { ...fullManifest, volumes: { VOL1: '/VOL1/' } };
  const store = await buildStore();
  const result = await analyzeFullProduction({ manifest,
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    datBytes: store['/primary'], optBytes: store['/images.opt'], loader: memoryLoader(store) });
  assert.ok(codes(result).includes('volume_undeclared'));
  const child = result.evidenceResources.find(entry => entry.documentId === 'B0003');
  assert.equal(child.native, null);
  assert.equal(child.text, null);
  assert.equal(result.pages.find(page => page.pageId === 'B0003').image, null);
});

test('DAT 空原生/文本字段等于未声明，不产生领取也不产生链接', async () => {
  const dat = encDAT([DAT_HEADER,
    ['B0001', 'B0001', 'B0001', 'B0001', '', '', 'VOL1']]);
  const opt = Buffer.from('B0001,VOL1,images/1.tif,Y,,,1\n');
  const store = await buildStore();
  const result = await analyzeFullProduction({ manifest: fullManifest,
    manifestBytes: Buffer.from(JSON.stringify(fullManifest)),
    datBytes: dat, optBytes: opt, loader: memoryLoader(store) });
  const entry = result.evidenceResources[0];
  assert.equal(entry.native, null);
  assert.equal(entry.text, null);
  assert.equal(result.status, 'accepted');
});

test('公开交付只链接清单声明的资源，native 为 null 且无任何原件引用', async () => {
  const store = await buildStore();
  const manifestBytes = Buffer.from(JSON.stringify(publicManifest));
  const result = await analyzePublicDelivery({ manifest: publicManifest, manifestPath: '/public',
    manifestBytes, loader: memoryLoader(store) });
  assert.equal(result.status, 'accepted');
  assert.equal(result.evidence[0].nativeLinked, false);
  assert.ok(result.resources.text?.digest);
  assert.deepEqual(result.evidence[0].resourceKinds, ['text']);
  assert.ok(!JSON.stringify(result).includes('/VOL1/native/parent.txt'));
});

test('即使底层字节与受限原件相同，公开交付也不自动复用原件链接', async () => {
  const restrictedNative = await fixture('resource-02.bin');
  // 公开文本与受限原件内容完全一致（同摘要）
  const store = await buildStore({ '/PUBLIC/text/parent.txt': Buffer.from(restrictedNative) });
  const manifestBytes = Buffer.from(JSON.stringify(publicManifest));
  const result = await analyzePublicDelivery({ manifest: publicManifest, manifestPath: '/public',
    manifestBytes, loader: memoryLoader(store) });
  assert.equal(result.evidence[0].nativeLinked, false);
  const kinds = Object.keys(result.resources);
  assert.deepEqual(kinds, ['text']);
  assert.equal(result.resources.text.sourcePath, '/PUBLIC/text/parent.txt');
});

test('公开清单声明的资源来源 404 记录收件问题而非伪造成功', async () => {
  const store = await buildStore({ '/PUBLIC/text/parent.txt': undefined });
  const manifestBytes = Buffer.from(JSON.stringify(publicManifest));
  const result = await analyzePublicDelivery({ manifest: publicManifest, manifestPath: '/public',
    manifestBytes, loader: memoryLoader(store) });
  assert.equal(result.status, 'accepted_with_issues');
  assert.equal(codes(result)[0], 'resource_unavailable');
  assert.equal(result.resources.text, null);
});

test('清单与路径结构非法时直接拒绝，不产生登记', () => {
  assert.throws(() => parseManifest(Buffer.from('not-json')), /manifest_json/);
  assert.throws(() => parseManifest(Buffer.from('{}')), /manifest_id/);
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify({ id: 'X' }))), /manifest_visibility/);
  const badNative = { ...publicManifest, native: '/secret/native.doc' };
  assert.rejects(() => analyzePublicDelivery({ manifest: badNative,
    manifestBytes: Buffer.from(JSON.stringify(badNative)), loader: async () => { throw new Error('unused'); } }),
    /public_native_must_be_null/);
});

test('卷映射与资源路径禁止跨目录逃逸', () => {
  assert.throws(() => volumeBase(fullManifest, 'VOL9'), /volume_undeclared/);
  const manifest = { ...fullManifest, volumes: { EVIL: '../etc/' } };
  assert.throws(() => volumeBase(manifest, 'EVIL'), /volume_base_invalid/);
  const remote = { ...fullManifest, volumes: { X: 'https://evil.example/v/' } };
  assert.throws(() => volumeBase(remote, 'X'), /volume_base_invalid/);
  assert.throws(() => joinResource('/VOL1/', '../escape.txt'), /resource_path_invalid/);
  assert.throws(() => joinResource('/VOL1/', '/absolute/path'), /resource_path_invalid/);
  assert.equal(joinResource('/VOL1/', 'images/1.tif'), '/VOL1/images/1.tif');
  assert.equal(volumeBase({ volumes: { VOL1: '/VOL1' } }, 'VOL1'), '/VOL1/');
});
