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
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
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
  async put(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      await writeFile(join(this.directory, 'objects', digest), bytes);
      return digest;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async saveDelivery(record) {
    const operation = this.pending.then(async () => {
      const directory = join(this.directory, 'deliveries');
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `receipt-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record));
      await rename(temporary, join(directory, `${record.receiptId}.json`));
      // 追加顺序就是收件顺序；按 id 命名文件无法区分同一毫秒的多次收件。
      const index = await this.deliveryIndex();
      index.push(record.receiptId);
      const indexTemporary = join(directory, `index-${randomUUID()}.tmp`);
      await writeFile(indexTemporary, JSON.stringify(index));
      await rename(indexTemporary, join(directory, 'index.json'));
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async deliveryIndex() {
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'deliveries', 'index.json'), 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async deliveries() {
    const index = await this.deliveryIndex();
    const records = [];
    for (const receiptId of index) {
      try {
        records.push(JSON.parse(await readFile(
          join(this.directory, 'deliveries', `${receiptId}.json`), 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return records;
  }
  // 按交付 id 查询返回该交付最近一次收件；每次收件的精确记录用 receiptId 查。
  async delivery(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid_delivery_id');
    const records = await this.deliveries();
    return records.filter(record => record.delivery.id === id).at(-1) ?? null;
  }
  async receipt(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid_receipt_id');
    const records = await this.deliveries();
    return records.find(record => record.receiptId === id) ?? null;
  }
}
