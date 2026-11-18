import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  for (const manifest of ['/production', '/public']) {
    const response = await fetch(`${service.url}/productions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
    if (response.status !== 201) throw new Error(await response.text());
    const record = await response.json();
    console.log('接收结果', manifest, {
      delivery: record.delivery,
      evidence: record.evidence.map(item => [item.evidenceId, item.role]),
      pages: record.pages.map(page => [page.pageId, page.role, page.image.status]),
      resources: record.resources.map(item => [item.role, item.path, item.status]),
      issues: record.issues,
    });
  }
  console.log('已保存交付', (await (await fetch(`${service.url}/deliveries`)).json())
    .map(record => record.delivery));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
