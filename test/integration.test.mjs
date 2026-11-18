import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('一次 production 接收：家族、页码、图像页与原生/文本资源一起核对', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const intake = manifest => fetch(`${service.url}/productions`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
  try {
    const response = await intake('/production');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.deepEqual(record.delivery, { id: 'P-PRIVATE', visibility: 'restricted', declared: {} });
    assert.deepEqual(record.evidence.map(item => item.evidenceId).sort(), ['B0001', 'B0003']);
    assert.equal(record.evidence.find(item => item.evidenceId === 'B0001').role, 'primary');
    assert.equal(record.evidence.find(item => item.evidenceId === 'B0003').role, 'attachment');
    assert.deepEqual(record.pages.map(page => [page.pageId, page.role, page.image.status]),
      [['B0001', 'primary', 'received'], ['B0002', 'primary', 'received'],
        ['B0003', 'attachment', 'received']]);
    assert.deepEqual(record.resources.map(item => [item.role, item.path, item.status]),
      [['native', '/VOL1/native/parent.txt', 'received'],
        ['text', '/VOL1/text/parent.txt', 'received'],
        ['native', '/VOL2/native/child.txt', 'received'],
        ['text', '/VOL2/text/child.txt', 'received']]);
    assert.equal(record.complete, true);

    const reopened = await (await fetch(`${service.url}/deliveries/P-PRIVATE`)).json();
    assert.deepEqual(reopened, record);
    const images = record.pages.filter(page => page.role === 'primary').map(page => page.image.digest);
    assert.equal(new Set(images).size, images.length);
    const expected = { B0001: 'resource-06.bin', B0002: 'resource-07.bin', B0003: 'resource-08.bin' };
    for (const page of record.pages) {
      const bytes = Buffer.from(await (await fetch(`${service.url}/objects/${page.image.digest}`))
        .arrayBuffer());
      assert.deepEqual(bytes, await readFile(new URL(`../fixtures/${expected[page.pageId]}`,
        import.meta.url)));
    }
    assert.deepEqual((await (await fetch(`${service.url}/deliveries`)).json())
      .map(item => item.delivery.id), ['P-PRIVATE']);
    const byReceipt = await (await fetch(`${service.url}/receipts/${record.receiptId}`)).json();
    assert.equal(byReceipt.id, record.id);
    assert.equal(byReceipt.delivery.id, 'P-PRIVATE');
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('公开交付只按自己的声明链接，受限原件内容相同也不复用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const intake = manifest => fetch(`${service.url}/productions`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
  try {
    const privateRecord = await (await intake('/production')).json();
    const publicRecord = await (await intake('/public')).json();
    assert.notEqual(privateRecord.delivery.id, publicRecord.delivery.id);
    assert.equal(publicRecord.delivery.visibility, 'public');
    assert.equal(publicRecord.delivery.declared.native, null);
    assert.deepEqual(publicRecord.resources.map(item => [item.role, item.path]),
      [['text', '/PUBLIC/text/parent.txt']]);
    assert.deepEqual(publicRecord.evidence.map(item => [item.evidenceId, item.role]), [['B0001', 'declared']]);
    const privateNatives = privateRecord.resources.filter(item => item.role === 'native');
    assert.ok(privateNatives.every(item => !publicRecord.resources.some(publicItem =>
      publicItem.path === item.path)));
    const publicDigest = publicRecord.resources[0].digest;
    assert.ok(privateRecord.resources.every(item => item.digest !== publicDigest));
    assert.deepEqual((await (await fetch(`${service.url}/deliveries`)).json()).map(item => item.delivery.id)
      .sort(), ['P-PRIVATE', 'P-PUBLIC']);
    assert.notEqual(privateRecord.receiptId, publicRecord.receiptId);
    // 同一交付重复收件产生新的本次交付身份，旧收件仍可按 receiptId 查到。
    const repeated = await (await intake('/production')).json();
    assert.notEqual(repeated.receiptId, privateRecord.receiptId);
    assert.equal(repeated.delivery.id, privateRecord.delivery.id);
    assert.equal((await (await fetch(`${service.url}/receipts/${privateRecord.receiptId}`)).json()).complete,
      true);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('跨卷图像缺失时留下家族与页码问题，不按连续页码补齐', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const record = await (await fetch(`${service.url}/productions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: '/production' }) }))
      .json();
    assert.equal(record.complete, false);
    const missing = record.issues.filter(issue => issue.code === 'page_image_missing');
    assert.deepEqual(missing.map(issue => [issue.pageId, issue.path, issue.reason]),
      [['B0003', '/VOL2/images/3.tif', 'source_status_404']]);
    const family = record.issues.find(issue => issue.code === 'family_volume_incomplete');
    assert.deepEqual(family.family, { begin: 'B0001', end: 'B0003' });
    assert.deepEqual(family.missingPages, ['B0003']);
    assert.deepEqual(record.pages.map(page => page.pageId), ['B0001', 'B0002', 'B0003']);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('清单缺失或非法时不登记交付，读取仍是 GET', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const send = body => fetch(`${service.url}/productions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({})).status, 422);
    assert.equal((await send({ manifest: '/missing' })).status, 422);
    assert.equal((await fetch(`${service.url}/deliveries`, { method: 'POST' })).status, 404);
    assert.deepEqual(await (await fetch(`${service.url}/deliveries`)).json(), []);
    assert.equal((await fetch(`${service.url}/deliveries/P-PRIVATE`)).status, 404);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('公开交付收件不请求任何受限路径，也不把受限字节登记为本次资源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const record = await (await fetch(`${service.url}/productions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: '/public' }) }))
      .json();
    const requests = await (await fetch(`${provider.url}/_requests`)).json();
    const paths = requests.map(item => item.path);
    assert.ok(paths.includes('/public'));
    assert.ok(paths.includes('/PUBLIC/text/parent.txt'));
    for (const restricted of ['/primary', '/VOL1/native/parent.txt', '/VOL1/text/parent.txt',
      '/VOL2/native/child.txt', '/VOL2/text/child.txt', '/production']) {
      assert.ok(!paths.includes(restricted), `不应请求 ${restricted}`);
    }
    assert.deepEqual(record.resources.map(item => item.path), ['/PUBLIC/text/parent.txt']);
    assert.equal(record.delivery.declared.native, null);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('同一交付多次收件各自保留顺序，交付查询取最近一次', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const intake = manifest => fetch(`${service.url}/productions`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
  try {
    const first = await (await intake('/production')).json();
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const second = await (await intake('/production')).json();
    assert.equal(first.delivery.id, second.delivery.id);
    assert.notEqual(first.receiptId, second.receiptId);
    assert.equal(first.complete, true);
    assert.equal(second.complete, false);
    const stored = await (await fetch(`${service.url}/deliveries`)).json();
    assert.deepEqual(stored.map(record => record.receiptId), [first.receiptId, second.receiptId]);
    assert.equal((await (await fetch(`${service.url}/deliveries/P-PRIVATE`)).json()).receiptId,
      second.receiptId);
    assert.equal((await (await fetch(`${service.url}/receipts/${first.receiptId}`)).json()).complete, true);
    // 两个收件记录指向的来源路径相同，但交付字节与问题不同，不能合并成一条。
    assert.equal((await (await fetch(`${service.url}/receipts/${second.receiptId}`)).json()).complete, false);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
