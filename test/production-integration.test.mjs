import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

async function withHarness(run) {
  const directory = await mkdtemp(join(tmpdir(), 'production-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try { await run({ provider, service, directory }); }
  finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
}
const postProduction = (service, path) => fetch(`${service.url}/productions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });

test('受限 production 一次性接收：家族、页码、资源核对通过并持久化', async () => {
  await withHarness(async ({ service }) => {
    const response = await postProduction(service, '/production');
    assert.equal(response.status, 201);
    const intake = await response.json();
    assert.equal(intake.productionId, 'P-PRIVATE');
    assert.equal(intake.visibility, 'restricted');
    assert.equal(intake.status, 'accepted');
    assert.equal(intake.problems.length, 0);
    assert.equal(intake.kind, 'full');
    assert.equal(intake.families.length, 1);
    assert.deepEqual(intake.families[0].members, ['B0001', 'B0003']);
    assert.deepEqual(intake.families[0].volumes, ['VOL1', 'VOL2']);
    assert.equal(intake.families[0].complete, true);
    assert.deepEqual(intake.evidenceIds, ['B0001', 'B0003']);
    assert.equal(intake.pages.length, 3);
    assert.ok(intake.pages.every(page => page.image?.digest));
    assert.ok(intake.evidenceResources.every(entry => entry.native?.digest && entry.text?.digest));
    // 交付身份与证据身份同时保留且不同
    assert.ok(intake.intakeId);
    assert.notEqual(intake.intakeId, intake.productionId);

    const listed = await (await fetch(`${service.url}/productions`)).json();
    assert.equal(listed.length, 1);
    const fetched = await (await fetch(`${service.url}/productions/${intake.intakeId}`)).json();
    assert.equal(fetched.intakeId, intake.intakeId);

    // 保存的交付字节可按摘要取回，且与来源一致
    const imageDigest = intake.pages[0].image.digest;
    const saved = Buffer.from(await (await fetch(`${service.url}/production-objects/${imageDigest}`)).arrayBuffer());
    assert.deepEqual(saved, await readFile(new URL('../fixtures/resource-06.bin', import.meta.url)));
  });
});

test('缺页场景（来源 phase 1 图像 404）仍登记收件并准确记录问题，不补页', async () => {
  await withHarness(async ({ provider, service }) => {
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const response = await postProduction(service, '/production');
    assert.equal(response.status, 201);
    const intake = await response.json();
    assert.equal(intake.status, 'accepted_with_issues');
    const problem = intake.problems.find(item => item.code === 'resource_unavailable');
    assert.ok(problem);
    assert.equal(problem.detail.resource, '/VOL2/images/3.tif');
    assert.equal(problem.detail.familyId, 'B0001');
    assert.equal(intake.families[0].complete, false);
    assert.deepEqual(intake.pages.map(page => page.pageId), ['B0001', 'B0002', 'B0003']);
    assert.equal(intake.pages[2].image, null);
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
  });
});

test('公开交付只登记声明的文本；同证据的受限原件不被链接，身份分别保留', async () => {
  await withHarness(async ({ service }) => {
    const restricted = await (await postProduction(service, '/production')).json();
    const publicResponse = await postProduction(service, '/public');
    assert.equal(publicResponse.status, 201);
    const publicIntake = await publicResponse.json();
    assert.equal(publicIntake.visibility, 'public');
    assert.equal(publicIntake.productionId, 'P-PUBLIC');
    assert.notEqual(publicIntake.productionId, restricted.productionId);
    assert.equal(publicIntake.evidence[0].nativeLinked, false);
    assert.ok(!JSON.stringify(publicIntake).includes('native/parent.txt'));
    const textDigest = publicIntake.resources.text.digest;
    const publicText = Buffer.from(await (await fetch(`${service.url}/production-objects/${textDigest}`)).arrayBuffer());
    assert.deepEqual(publicText, await readFile(new URL('../fixtures/resource-09.bin', import.meta.url)));

    // 证据 B0001 跨两次交付分别可查：1 次受限 + 1 次公开，不合并、不互授可见性
    const evidence = await (await fetch(`${service.url}/evidence/B0001`)).json();
    assert.equal(evidence.length, 2);
    assert.deepEqual(evidence.map(item => item.visibility).sort(), ['public', 'restricted']);
    assert.equal(new Set(evidence.map(item => item.intakeId)).size, 2);

    // 每次接收独立留痕：重复接收生成新的 intake 记录，但链接仍只来自各自清单
    const again = await (await postProduction(service, '/public')).json();
    assert.notEqual(again.intakeId, publicIntake.intakeId);
    assert.equal(again.evidence[0].nativeLinked, false);
    assert.equal((await (await fetch(`${service.url}/productions`)).json()).length, 3);
    const evidenceAfter = await (await fetch(`${service.url}/evidence/B0001`)).json();
    assert.equal(evidenceAfter.length, 3);
    assert.deepEqual(evidenceAfter.map(item => item.visibility).sort(),
      ['public', 'public', 'restricted']);

    // 不存在的 intake 与 GET 写操作边界
    assert.equal((await fetch(`${service.url}/productions/nonexistent-id`)).status, 422);
  });
});

test('清单结构非法与来源缺失拒收，不产生收件登记', async () => {
  await withHarness(async ({ service }) => {
    assert.equal((await postProduction(service, '/missing')).status, 422);
    const foreign = await fetch(`${service.url}/productions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'https://example.invalid/foreign' }) });
    assert.equal(foreign.status, 422);
    assert.deepEqual(await (await fetch(`${service.url}/productions`)).json(), []);
  });
});

test('重启后 production 收件与证据索引仍可查询', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'restart-test-'));
  const provider = await startProvider();
  const first = await startService({ source: provider.url, directory });
  const intake = await (await postProduction(first, '/production')).json();
  await first.close();
  const reopened = await startService({ source: provider.url, directory });
  try {
    const fetched = await (await fetch(`${reopened.url}/productions/${intake.intakeId}`)).json();
    assert.equal(fetched.intakeId, intake.intakeId);
    assert.equal(fetched.families[0].familyId, 'B0001');
    const evidence = await (await fetch(`${reopened.url}/evidence/B0003`)).json();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].productionId, 'P-PRIVATE');
  } finally {
    await reopened.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});
