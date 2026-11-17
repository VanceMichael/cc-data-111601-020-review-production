import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'production-objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listProductions(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveProductionIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async saveProductionIndex(records) {
    const temporary = join(this.directory, `productions-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'productions.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async listProductions() {
    return JSON.parse(await readFile(join(this.directory, 'productions.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  // 按一次 production 交付登记。链接只来自本交付分析结果，blobs 按摘要存入独立目录；
  // 每次接收独立留痕（不同时间点来源状态可能不同，问题必须各自准确登记），
  // 绝不跨交付复用链接。
  async acceptProduction({ source, intake }) {
    const operation = this.pending.then(async () => {
      const records = await this.listProductions();
      for (const [digest, bytes] of intake.blobs) {
        await writeFile(join(this.directory, 'production-objects', digest), bytes);
      }
      const stored = { ...intake, blobs: undefined, intakeId: randomUUID(),
        source, receivedAt: new Date().toISOString() };
      delete stored.blobs;
      records.push(stored);
      await this.saveProductionIndex(records);
      return stored;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async production(intakeId) {
    if (!/^[a-f0-9-]{36}$/.test(intakeId)) throw new Error('invalid_intake_id');
    const records = await this.listProductions();
    const record = records.find(item => item.intakeId === intakeId);
    if (!record) throw new Error('intake_not_found');
    return record;
  }
  async productionObject(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'production-objects', digest));
  }
  // 证据身份（Bates）跨交付查询：分别列出每次交付对该证据的登记，不合并、不互授可见性。
  async evidence(evidenceId) {
    if (typeof evidenceId !== 'string' || !evidenceId) throw new Error('evidence_id_required');
    const records = await this.listProductions();
    return records.filter(record => record.evidenceIds.includes(evidenceId))
      .map(record => ({ intakeId: record.intakeId, productionId: record.productionId,
        visibility: record.visibility, status: record.status, source: record.source }));
  }
}
