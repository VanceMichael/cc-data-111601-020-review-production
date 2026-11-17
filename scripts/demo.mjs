import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const post = (base, path) => fetch(`${base}/productions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));

  // 1) 缺页阶段接收：来源 B0003 图像 404，问题须准确登记且不推测页面
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const missing = await (await post(service.url, '/production')).json();
  console.log('缺页交付收件', JSON.stringify({
    intakeId: missing.intakeId, productionId: missing.productionId, status: missing.status,
    problems: missing.problems.map(p => ({ code: p.code, resource: p.detail.resource, familyId: p.detail.familyId })),
    listedPages: missing.pages.map(p => p.pageId), familyComplete: missing.families[0].complete }));
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });

  // 2) 来源恢复后按同一次 production 正常接收：家族、页码范围、图像页与原生/文本整体核对
  const full = await (await post(service.url, '/production')).json();
  console.log('完整交付收件', JSON.stringify({
    intakeId: full.intakeId, productionId: full.productionId, visibility: full.visibility,
    status: full.status, families: full.families, pages: full.pages.length,
    evidenceIds: full.evidenceIds, problems: full.problems.length }));

  // 3) 接收脱敏公开交付：只链接清单声明的文本，原件保持未链接
  const publicIntake = await (await post(service.url, '/public')).json();
  console.log('公开交付收件', JSON.stringify({
    intakeId: publicIntake.intakeId, productionId: publicIntake.productionId,
    nativeLinked: publicIntake.evidence[0].nativeLinked,
    declaredResources: Object.keys(publicIntake.resources), problems: publicIntake.problems.length }));

  // 4) 证据身份跨交付查询：同一 Bates 证据的两次交付身份分别保留
  const evidence = await (await fetch(`${service.url}/evidence/B0001`)).json();
  console.log('证据 B0001 的跨交付登记', JSON.stringify(evidence));

  // 5) 兼容的单件 load file 接收仍可用
  const legacy = await fetch(`${service.url}/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  console.log('兼容单件接口', legacy.status);
} finally {
  await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
}
