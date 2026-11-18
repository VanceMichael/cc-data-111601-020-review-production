import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, inspectOpt } from '../src/reader.mjs';
import { readManifest, planProduction, finalizeProduction } from '../src/delivery.mjs';

const restricted = {
  id: 'P-1', visibility: 'restricted',
  dat: '/p.dat', opt: '/p.opt',
  volumes: { VOL1: '/VOL1/' },
};
const row = (...values) => values.map(value => `þ${value}þ`).join('\u0014');
const dat = (rows, columns = ['BEGDOC', 'ENDDOC', 'BEGATTACH', 'ENDATTACH', 'NATIVE', 'TEXT', 'VOLUME']) =>
  inspect(Buffer.from([`þ${columns.join('þ\u0014þ')}þ`, ...rows.map(values => row(...values))].join('\r\n')));
const opt = (...rows) => inspectOpt(Buffer.from(rows.flat().join('\r\n')));

function plan(manifest, datRows, optRows, extra = {}) {
  const value = planProduction({ manifest: readManifest(manifest),
    dat: datRows ? datRows : null, opt: optRows ? optRows : null, ...extra });
  const outcomes = new Map(value.declarations.map(item =>
    [item.key, { status: 'received', digest: 'a'.repeat(64), bytes: Buffer.alloc(4) }]));
  return finalizeProduction(value, outcomes);
}
const codes = record => record.issues.map(issue => issue.code);

test('重复页码与跨文档归属都留下准确问题，不补出不存在的页', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0002', 'B0001', 'B0002', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,3', 'B0002,VOL1,images/2.tif,,, ,',
      'B0002,VOL1,images/2b.tif,,, ,']));
  assert.ok(codes(record).includes('duplicate_page_number'));
  const duplicate = record.issues.find(issue => issue.code === 'duplicate_page_number');
  assert.equal(duplicate.pageId, 'B0002');
  assert.equal(duplicate.occurrences, 2);
  assert.deepEqual(duplicate.paths.sort(), ['images/2.tif', 'images/2b.tif']);
  // 文档声明 3 页，OPT 只给出 2 个页码；只报告数量差异。
  const mismatch = record.issues.find(issue => issue.code === 'page_count_mismatch');
  assert.deepEqual({ declared: mismatch.declared, observed: mismatch.observed }, { declared: 3, observed: 2 });
  assert.ok(!('missing' in mismatch));
});

test('同一页码落在两份文档时归属不唯一', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0001', '', '', 'VOL1'],
      ['B0001', 'B0002', 'B0001', 'B0002', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,1']));
  const duplicate = record.issues.find(issue => issue.code === 'duplicate_page_ownership');
  assert.deepEqual(duplicate.owners, ['B0001', 'B0001']);
  assert.equal(record.pages[0].document, null);
  assert.deepEqual(record.pages[0].documents.map(item => item.evidenceId), ['B0001', 'B0001']);
});

test('DAT 区间重叠或不可比时报告而不是猜测', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0003', 'B0001', 'B0003', '', '', 'VOL1'],
      ['B0002', 'B0004', 'B0002', 'B0004', '', '', 'VOL1']]), null);
  assert.ok(codes(record).includes('document_range_overlap'));
  const unordered = plan(restricted,
    dat([['B0009', 'B0001', 'B0009', 'B0001', '', '', 'VOL1']]), null);
  assert.ok(codes(unordered).includes('document_range_invalid'));
  assert.ok(codes(unordered).includes('family_range_invalid'));
});

test('家族跨卷缺件时报告家族与卷，且缺页只列实际缺失的页', () => {
  const value = planProduction({
    manifest: readManifest({ ...restricted, volumes: { VOL1: '/VOL1/', VOL2: '/VOL2/' } }),
    dat: dat([['B0001', 'B0002', 'B0001', 'B0003', '', '', 'VOL1'],
      ['B0003', 'B0003', 'B0001', 'B0003', '', '', 'VOL2']]),
    opt: opt(['B0001,VOL1,images/1.tif,Y,,,2', 'B0002,VOL1,images/2.tif,,,,',
      'B0003,VOL2,images/3.tif,Y,,,1']),
  });
  const outcomes = new Map(value.declarations.map(item => [item.key,
    item.path === '/VOL2/images/3.tif'
      ? { status: 'missing', error: 'source_status_404' }
      : { status: 'received', digest: 'b'.repeat(64), bytes: Buffer.alloc(1) }]));
  const record = finalizeProduction(value, outcomes);
  const family = record.issues.find(issue => issue.code === 'family_volume_incomplete');
  assert.deepEqual(family.volumes, ['VOL1', 'VOL2']);
  assert.deepEqual(family.missingPages, ['B0003']);
  const missing = record.issues.find(issue => issue.code === 'page_image_missing');
  assert.equal(missing.pageId, 'B0003');
  assert.equal(record.complete, false);
});

test('家族声明端点未实际交付时报告声明端点，不补齐中间页', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0005', '', '', 'VOL1'],
      ['B0004', 'B0004', 'B0001', 'B0005', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,1', 'B0004,VOL1,images/4.tif,Y,,,1']));
  const gap = record.issues.find(issue => issue.code === 'family_document_missing');
  assert.deepEqual(gap.family, { begin: 'B0001', end: 'B0005' });
  assert.equal(gap.declaredEnd, 'B0005');
  assert.equal(gap.deliveredEnd, 'B0004');
  assert.ok(!record.pages.some(page => ['B0002', 'B0003', 'B0005'].includes(page.pageId)));
});

test('公开交付不因内容相同复用受限原件，未声明就记问题', () => {
  const privateRecord = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0001', 'native/a.txt', 'text/a.txt', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,1']));
  assert.deepEqual(privateRecord.resources.map(item => item.role).sort(), ['native', 'text']);

  const publicRecord = plan({ id: 'P-2', visibility: 'public', dat: '/p.dat', opt: '/p.opt',
    volumes: { VOL1: '/VOL1/' }, resources: { text: '/PUBLIC/text/a.txt' } },
  dat([['B0001', 'B0001', 'B0001', 'B0001', 'native/a.txt', 'text/a.txt', 'VOL1']]),
  opt(['B0001,VOL1,images/1.tif,Y,,,1']));
  assert.deepEqual(publicRecord.resources.map(item => [item.role, item.path]),
    [['text', '/PUBLIC/text/a.txt']]);
  const undeclared = publicRecord.issues.find(issue => issue.code === 'resource_not_declared');
  assert.equal(undeclared.role, 'native');
  assert.equal(undeclared.path, 'native/a.txt');
  assert.equal(undeclared.evidenceId, 'B0001');
  assert.equal(publicRecord.delivery.id, 'P-2');
  assert.notEqual(publicRecord.delivery.id, privateRecord.delivery.id);
  assert.notEqual(publicRecord.receiptId, privateRecord.receiptId);

  // 显式 null 表示本次公开交付明确不提供原件，不应误报为未声明。
  const explicit = plan({ id: 'P-4', visibility: 'public', dat: '/p.dat', opt: '/p.opt',
    volumes: { VOL1: '/VOL1/' }, resources: { text: '/PUBLIC/text/a.txt' }, native: null },
  dat([['B0001', 'B0001', 'B0001', 'B0001', 'native/a.txt', 'text/a.txt', 'VOL1']]),
  opt(['B0001,VOL1,images/1.tif,Y,,,1']));
  assert.equal(explicit.delivery.declared.native, null);
  assert.ok(!explicit.issues.some(issue => issue.code === 'resource_not_declared'));
  assert.deepEqual(explicit.resources.map(item => item.path), ['/PUBLIC/text/a.txt']);
});

test('公开交付声明受限路径时仍按自己的清单路径领取，不改成受限链接', () => {
  const record = plan({ id: 'P-3', visibility: 'public', volumes: { VOL1: '/VOL1/' },
    resources: { native: '/PUBLIC/native/a.txt' }, evidenceIds: ['B0001'] }, null, null);
  assert.deepEqual(record.resources.map(item => [item.role, item.path, item.declaredBy]),
    [['native', '/PUBLIC/native/a.txt', 'manifest']]);
  assert.deepEqual(record.evidence[0].evidenceId, 'B0001');
  assert.equal(record.evidence[0].role, 'declared');
});

test('清单非法、卷外路径与未声明卷都被拒绝或记录', () => {
  assert.throws(() => readManifest({ id: 'P', visibility: 'secret' }), /production_visibility/);
  assert.throws(() => readManifest({ id: '', visibility: 'public' }), /production_id/);
  assert.throws(() => readManifest({ id: 'P', visibility: 'public', volumes: { VOL1: 'https://x/' } }),
    /production_volumes/);
  assert.throws(() => readManifest({ id: 'P', visibility: 'public', resources: { other: '/x' } }),
    /production_resources/);

  const record = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0001', 'native/../x.txt', 'text/a.txt', 'VOL9']]),
    opt(['B0001,VOL9,images/1.tif,Y,,,1']));
  assert.ok(codes(record).includes('volume_undeclared'));
  assert.equal(record.pages[0].image.status, 'undeclared');
  assert.equal(record.resources.length, 0);

  const traversing = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0001', 'native/../x.txt', 'text/a.txt', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,1']));
  assert.ok(codes(traversing).includes('resource_path_invalid'));
  assert.deepEqual(traversing.resources.map(item => [item.role, item.path]), [['text', '/VOL1/text/a.txt']]);
});

test('OPT 宽度、页码与 page-count 结构错误被拒绝', () => {
  assert.throws(() => inspectOpt(Buffer.from('B0001,VOL1\n')), /opt_width/);
  assert.throws(() => inspectOpt(Buffer.from(',VOL1,a.tif,Y,,,1\n')), /opt_page_id/);
  assert.throws(() => inspectOpt(Buffer.from('B0001,VOL1,a.tif,N,,,1\n')), /opt_document_break/);
  assert.throws(() => inspectOpt(Buffer.from('B0001,VOL1,a.tif,Y,,,x\n')), /opt_page_count/);
  assert.throws(() => inspectOpt(Buffer.from('')), /opt_empty/);
});

test('DAT 或 OPT 缺失时保留可定位的收件问题，不写空结果', () => {
  const record = plan(restricted, null, null, {
    datIssue: { code: 'dat_unavailable', path: '/p.dat', reason: 'source_status_404' },
    optIssue: { code: 'opt_unavailable', path: '/p.opt', reason: 'source_status_404' } });
  assert.deepEqual(codes(record).sort(), ['dat_unavailable', 'opt_unavailable']);
  const partial = planProduction({ manifest: readManifest(restricted), dat: null, opt: null,
    datIssue: { code: 'dat_unavailable', path: '/missing.dat', reason: 'source_status_404' },
    optIssue: { code: 'opt_unavailable', path: '/missing.opt', reason: 'source_status_404' } });
  assert.equal(partial.issues[0].path, '/missing.dat');
  assert.equal(partial.documents.length, 0);
});

test('重开目录后交付身份与证据身份仍分开保存', async () => {
  const record = plan({ ...restricted, evidenceIds: ['B0009'] },
    dat([['B0001', 'B0001', 'B0001', 'B0002', '', '', 'VOL1'],
      ['B0002', 'B0002', 'B0001', 'B0002', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,2', 'B0002,VOL1,images/2.tif,,,,']));
  assert.equal(record.delivery.id, 'P-1');
  assert.match(record.receiptId, /^[0-9a-f-]{36}$/);
  assert.notEqual(record.receiptId, record.delivery.id);
  assert.deepEqual(record.evidence.map(item => item.evidenceId).sort(), ['B0001', 'B0002', 'B0009']);
  const declared = record.evidence.find(item => item.evidenceId === 'B0009');
  assert.equal(declared.role, 'declared');
  assert.deepEqual(declared.ranges, []);
  const attachment = record.evidence.find(item => item.evidenceId === 'B0002');
  assert.equal(attachment.role, 'attachment');
  assert.deepEqual(attachment.family, { begin: 'B0001', end: 'B0002' });
});

test('同一图像文件被多页声明时报告复用，不让多页静默共享一张图', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0002', 'B0001', 'B0002', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,2', 'B0002,VOL1,images/1.tif,,,,']));
  const reused = record.issues.find(issue => issue.code === 'page_image_reused');
  assert.equal(reused.path, '/VOL1/images/1.tif');
  assert.deepEqual(reused.pageIds, ['B0001', 'B0002']);
});

test('文档区间落在家族声明之外时报告', () => {
  const record = plan(restricted,
    dat([['B0002', 'B0004', 'B0001', 'B0003', '', '', 'VOL1']]), null);
  const outside = record.issues.find(issue => issue.code === 'document_outside_family');
  assert.equal(outside.evidenceId, 'B0002');
  assert.deepEqual(outside.family, { begin: 'B0001', end: 'B0003' });
});

test('文档起始页未被 OPT 标为 document-break 时报告', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0002', 'B0001', 'B0002', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,,,,', 'B0002,VOL1,images/2.tif,Y,,,']));
  assert.ok(codes(record).includes('document_break_missing'));
  const mismatched = plan(restricted,
    dat([['B0001', 'B0002', 'B0001', 'B0002', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,2', 'B0002,VOL1,images/2.tif,Y,,,']));
  assert.ok(codes(mismatched).includes('document_break_mismatch'));
  const unowned = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0001', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,1', 'B0002,VOL1,images/2.tif,Y,,,1']));
  assert.ok(codes(unowned).includes('document_break_unowned'));
  assert.ok(codes(unowned).includes('page_unowned'));
});

test('DAT 缺失时不把页码判成无归属，也不推断极数', () => {
  const record = plan(restricted, null,
    opt(['B0001,VOL1,images/1.tif,Y,,,1']), {
      datIssue: { code: 'dat_unavailable', path: '/p.dat', reason: 'source_status_404' } });
  assert.deepEqual(codes(record).sort(), ['dat_unavailable']);
  assert.equal(record.pages[0].document, null);
  assert.deepEqual(record.pages[0].image, {
    status: 'received', path: '/VOL1/images/1.tif', digest: 'a'.repeat(64), bytes: 4 });
  assert.deepEqual(record.evidence, []);
});

test('OPT 缺失时不因集合为空而判定文档缺页', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0001', '', '', 'VOL1']]), null, {
      optIssue: { code: 'opt_unavailable', path: '/p.opt', reason: 'source_status_404' } });
  assert.deepEqual(codes(record), ['opt_unavailable']);
  assert.deepEqual(record.pages, []);
  assert.deepEqual(record.evidence.map(item => item.evidenceId), ['B0001']);
  assert.deepEqual(record.evidence[0].pages, []);
});

test('家族声明端点未交付时只报告端点，不补齐中间页码', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0001', 'B0001', 'B0003', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,1']));
  const gap = record.issues.find(issue => issue.code === 'family_document_missing');
  assert.deepEqual(gap.family, { begin: 'B0001', end: 'B0003' });
  assert.equal(gap.deliveredEnd, 'B0001');
  assert.ok(!record.issues.some(issue => issue.code === 'family_volume_incomplete'));
  assert.deepEqual(record.pages.map(page => page.pageId), ['B0001']);
});

test('跨卷家族中声明页数不足时，家族问题只指出证据号', () => {
  const record = plan({ ...restricted, volumes: { VOL1: '/VOL1/', VOL2: '/VOL2/' } },
    dat([['B0001', 'B0002', 'B0001', 'B0003', '', '', 'VOL1'],
      ['B0003', 'B0003', 'B0001', 'B0003', '', '', 'VOL2']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,3', 'B0003,VOL2,images/3.tif,Y,,,1']));
  const family = record.issues.find(issue => issue.code === 'family_volume_incomplete');
  assert.deepEqual(family.incompleteDocuments, ['B0001']);
  assert.deepEqual(family.missingPages, []);
  assert.deepEqual(record.pages.map(page => page.pageId), ['B0001', 'B0003']);
});

test('家族内两份已交付文档之间缺号时只报两侧端点，不列出中间编号', () => {
  const record = plan(restricted,
    dat([['B0001', 'B0002', 'B0001', 'B0006', '', '', 'VOL1'],
      ['B0005', 'B0006', 'B0001', 'B0006', '', '', 'VOL1']]),
    opt(['B0001,VOL1,images/1.tif,Y,,,2', 'B0002,VOL1,images/2.tif,,,,',
      'B0005,VOL1,images/5.tif,Y,,,2', 'B0006,VOL1,images/6.tif,,,,']));
  const gap = record.issues.find(issue => issue.code === 'family_document_gap');
  assert.deepEqual(gap.previous, { evidenceId: 'B0001', end: 'B0002' });
  assert.deepEqual(gap.next, { evidenceId: 'B0005', begin: 'B0005' });
  assert.ok(!JSON.stringify(gap).includes('B0003'));
  assert.ok(!record.pages.some(page => ['B0003', 'B0004'].includes(page.pageId)));
});

test('清单两个位置对同一角色声明不同路径时报告冲突，不静默择一', () => {
  const record = plan({ id: 'P-5', visibility: 'public', volumes: { VOL1: '/VOL1/' },
    resources: { text: '/PUBLIC/a.txt' }, text: '/PUBLIC/b.txt' }, null, null);
  const conflict = record.issues.find(issue => issue.code === 'resource_declaration_conflict');
  assert.equal(conflict.role, 'text');
  assert.deepEqual(conflict.paths, ['/PUBLIC/a.txt', '/PUBLIC/b.txt']);
});

test('Bates 前缀或位数不可比时明确说明无法核对，不推断越界或相等', () => {
  const record = plan(restricted,
    dat([['X0001', 'X0001', 'A0001', 'A0009', '', '', 'VOL1']]), null);
  const incomparable = record.issues.filter(issue => issue.code === 'document_family_incomparable');
  assert.deepEqual(incomparable.map(issue => issue.side).sort(), ['begin', 'end']);
  assert.ok(!record.issues.some(issue => issue.code === 'document_outside_family'));
  const padded = plan(restricted,
    dat([['B0001', 'B0001', 'B00001', 'B00009', '', '', 'VOL1']]), null);
  assert.ok(codes(padded).includes('document_family_incomparable'));
  assert.ok(!codes(padded).includes('document_outside_family'));
});
