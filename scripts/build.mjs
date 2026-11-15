import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('dist', { recursive: true });
for (const name of await readdir('src')) {
  if (!name.endsWith('.mjs')) continue;
  const result = spawnSync(process.execPath, ['--check', `src/${name}`], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr);
  await copyFile(`src/${name}`, `dist/${name}`);
}
console.log('构建完成：已校验并复制运行模块');
