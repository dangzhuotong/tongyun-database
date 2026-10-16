import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeError } from '../change-control/core.mjs';

export const requireValue = (condition, code) => { if (!condition) throw new ChangeError(code); };
export class ConnectionStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, 'connections.private.json');
    const keyPath = join(directory, 'connection-key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    requireValue(this.key.length === 32, 'CONNECTION_STORE_INVALID');
  }
  read() {
    if (!existsSync(this.path)) return [];
    const { iv, tag, data } = JSON.parse(readFileSync(this.path, 'utf8'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'hex'));
    cipher.setAuthTag(Buffer.from(tag, 'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString());
  }
  write(records) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(records)), cipher.final()]);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') }), { mode: 0o600 });
    renameSync(temporary, this.path); chmodSync(this.path, 0o600);
  }
  public(record) {
    const { password, ...safe } = record;
    return { ...safe, hasPassword: Boolean(password) };
  }
  list() { return this.read().map(record => this.public(record)); }
  get(id) {
    const record = this.read().find(c => c.id === id);
    requireValue(record, 'CONNECTION_NOT_FOUND');
    return record;
  }
  add(input) {
    requireValue(input && ['mysql', 'redis'].includes(input.engine), 'INVALID_ENGINE');
    requireValue(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 100, 'CONNECTION_NAME_REQUIRED');
    requireValue(typeof input.host === 'string' && /^[a-zA-Z0-9.:[\]_-]{1,253}$/.test(input.host), 'INVALID_HOST');
    requireValue(Number.isInteger(input.port) && input.port > 0 && input.port <= 65535, 'INVALID_PORT');
    requireValue(['local', 'development', 'test', 'staging', 'production'].includes(input.environment), 'INVALID_ENVIRONMENT');
    requireValue(typeof input.username === 'string' && input.username.length <= 200 && typeof input.password === 'string' && input.password.length <= 4096, 'INVALID_CREDENTIALS');
    requireValue(typeof input.database === 'string' && input.database.length <= 64, 'INVALID_DATABASE');
    if (input.engine === 'mysql') requireValue(input.database.length > 0 && input.username.length > 0, 'MYSQL_DATABASE_REQUIRED');
    else requireValue(/^\d{1,3}$/.test(input.database) && Number(input.database) <= 255, 'INVALID_REDIS_DATABASE');
    requireValue(!(input.allowWrites && input.environment === 'production'), 'PRODUCTION_WRITES_DISABLED');
    const record = {
      id: randomUUID(), revision: randomUUID(), name: input.name.trim(), engine: input.engine,
      host: input.host, port: input.port, database: input.database, username: input.username, password: input.password,
      tls: input.tls === true, allowWrites: input.allowWrites === true, environment: input.environment,
    };
    const records = this.read();
    requireValue(records.length < 100, 'CONNECTION_LIMIT');
    records.push(record); this.write(records);
    return this.public(record);
  }
}
