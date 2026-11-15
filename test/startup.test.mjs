import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProvider } from '../src/provider.mjs';

async function launch(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'startup-test-'));
  const environment = { ...process.env, PORT: '0', DATA_DIR: directory };
  delete environment.SOURCE_URL;
  if (source) environment.SOURCE_URL = source;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/service.mjs', import.meta.url))],
    { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    child.kill('SIGTERM');
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(watchdog); }
    await rm(directory, { recursive: true, force: true });
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const address = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`startup_timeout: ${errors}`)), 8000);
    const fail = error => { clearTimeout(deadline); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`startup_exit_${code}: ${errors}`)));
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(deadline);
      try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
    });
  });
  assert.deepEqual(await (await fetch(`${address.product}/health`)).json(), { ready: true });
  const response = await fetch(`${address.product}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  assert.equal(response.status, 201);
  const record = await response.json();
  assert.equal((await (await fetch(`${address.product}/records`)).json())[0].id, record.id);
  return { ...address, stop: async () => { child.kill('SIGTERM'); await exited; } };
}

test('干净环境启动会创建可真实领取的本地来源', async t => {
  const address = await launch(t);
  assert.ok((await (await fetch(`${address.source}/_requests`)).json()).length > 0);
});

test('显式来源仍用于领取，关闭产品不关闭外部来源', async t => {
  const provider = await startProvider();
  try {
    const address = await launch(t, provider.url);
    assert.equal(address.source, provider.url);
    await address.stop();
    assert.equal((await fetch(`${provider.url}/catalog`)).status, 200);
  } finally { t.after(() => provider.close()); }
});
