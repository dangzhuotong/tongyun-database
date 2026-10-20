import { createClient, RESP_TYPES } from 'redis';
import { ChangeError } from '../change-control/core.mjs';
import { requireValue } from './store.mjs';
import { mapInChunks } from './redis-scan.mjs';

const maxBytes = 1048576;
const options = { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } };
function text(value) {
  if (!Buffer.isBuffer(value)) return value;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { throw new ChangeError('BINARY_VALUE_UNSUPPORTED'); }
}
const snapshotLua = `
local t=redis.call('TYPE',KEYS[1]).ok
if t=='none' then return redis.error_reply('KEY_NOT_FOUND') end
if t~='string' and t~='hash' and t~='list' and t~='set' and t~='zset' then return redis.error_reply('TYPE_UNSUPPORTED') end
local memory=redis.call('MEMORY','USAGE',KEYS[1])
if memory>${maxBytes} then return redis.error_reply('KEY_TOO_LARGE') end
local count=0
if t=='string' then count=redis.call('STRLEN',KEYS[1])
elseif t=='hash' then count=redis.call('HLEN',KEYS[1])
elseif t=='list' then count=redis.call('LLEN',KEYS[1])
elseif t=='set' then count=redis.call('SCARD',KEYS[1])
else count=redis.call('ZCARD',KEYS[1]) end
if t~='string' and count>1000 then return redis.error_reply('KEY_TOO_LARGE') end
local dump=redis.call('DUMP',KEYS[1])
if string.len(dump)>${maxBytes} then return redis.error_reply('KEY_TOO_LARGE') end
local value
if t=='string' then value=redis.call('GET',KEYS[1])
elseif t=='hash' then value=redis.call('HGETALL',KEYS[1])
elseif t=='list' then value=redis.call('LRANGE',KEYS[1],0,999)
elseif t=='set' then value=redis.call('SMEMBERS',KEYS[1])
else value=redis.call('ZRANGE',KEYS[1],0,999,'WITHSCORES') end
local now=redis.call('TIME')
return {t,dump,redis.call('PEXPIRETIME',KEYS[1]),memory,tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000),value}
`;
const applyLua = `
local current=redis.call('DUMP',KEYS[1])
if not current or current~=ARGV[1] or redis.call('PEXPIRETIME',KEYS[1])~=tonumber(ARGV[2]) then return redis.error_reply('ROW_CONFLICT') end
local command=cjson.decode(ARGV[3])
local args={command[1],KEYS[1]}
for i=2,#command do args[#args+1]=command[i] end
local result=redis.pcall(unpack(args))
if type(result)=='table' and result.err then return redis.error_reply('MUTATION_REJECTED') end
local dump=redis.call('DUMP',KEYS[1])
return {dump or '',redis.call('PEXPIRETIME',KEYS[1])}
`;
const rollbackLua = `
local current=redis.call('DUMP',KEYS[1])
local expected=ARGV[1]
if (current or '')~=expected or redis.call('PEXPIRETIME',KEYS[1])~=tonumber(ARGV[2]) then return redis.error_reply('ROW_CONFLICT') end
local expiry=tonumber(ARGV[4])
local now=redis.call('TIME')
if expiry>0 and expiry<=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000) then return redis.error_reply('ROLLBACK_EXPIRED') end
if expiry==-1 then redis.call('RESTORE',KEYS[1],0,ARGV[3],'REPLACE')
else redis.call('RESTORE',KEYS[1],expiry,ARGV[3],'REPLACE','ABSTTL') end
return {redis.call('DUMP',KEYS[1]),redis.call('PEXPIRETIME',KEYS[1])}
`;

export class RedisAdapter {
  constructor(config) { this.config = config; }
  async using(fn, budget = 5000) {
    const client = createClient({ socket: { host: this.config.host, port: this.config.port, tls: this.config.tls || undefined,
      connectTimeout: Math.max(1,Math.min(3000,budget)), reconnectStrategy: false }, username: this.config.username || undefined,
      password: this.config.password || undefined, database: Number(this.config.database), commandsQueueMaxLength: 1000 });
    client.on('error', () => {});
    const timer = setTimeout(() => { if (client.isOpen) client.destroy(); }, Math.max(1,budget));
    let connected=false;
    try { await client.connect(); connected=true; return await fn(client); }
    catch (error) {
      if (error instanceof ChangeError) throw error;
      const known = ['KEY_NOT_FOUND','KEY_TOO_LARGE','TYPE_UNSUPPORTED','ROW_CONFLICT','ROLLBACK_EXPIRED','MUTATION_REJECTED'];
      throw new ChangeError(known.find(code => String(error.message).includes(code)) ?? (connected?'REDIS_ERROR':'CONNECTION_FAILED'));
    } finally { clearTimeout(timer); if (client.isOpen) client.destroy(); }
  }
  async test() { return this.using(async c => { await c.ping(); const info = await c.info('server'); const version = /redis_version:([^\r\n]+)/.exec(info)?.[1]; requireValue(Number(version?.split('.')[0]) >= 7, 'REDIS_7_REQUIRED'); return { engine: 'redis', version }; }); }
  async scan({ cursor = '0', pattern = '*' }, budget = 5000, signal) {
    requireValue(typeof cursor === 'string' && /^\d{1,20}$/.test(cursor), 'INVALID_CURSOR');
    requireValue(typeof pattern === 'string' && pattern.length <= 200, 'INVALID_PATTERN');
    if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
    return this.using(async c => {
      if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
      // COUNT is a hint, not a hard page size. A bounded spill cursor retains oversized batches.
      const [next, batch] = await c.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000'], options);
      const keys = [...new Set(batch.map(text))];
      requireValue(keys.length <= 10000, 'SCAN_BATCH_TOO_LARGE');
      requireValue(keys.every(key=>Buffer.byteLength(key)<=2048), 'KEY_TOO_LARGE');
      const rows = await mapInChunks(keys, 50, signal, async chunk => {
        const loaded = await Promise.all(chunk.map(async key => {
          if (signal?.aborted) throw new ChangeError('QUERY_CANCELLED');
          const [type, ttl, memory] = await Promise.all([c.type(key), c.pTTL(key), c.memoryUsage(key)]);
          return { key, type, ttlMs: ttl, memoryBytes: memory ?? 0 };
        }));
        return loaded.filter(row => row.type !== 'none');
      });
      return { rows, cursor: text(next), scanHint: 1000 };
    },budget);
  }
  async snapshot(c, key) {
    requireValue(typeof key === 'string' && Buffer.byteLength(key) > 0 && Buffer.byteLength(key) <= 2048, 'INVALID_KEY');
    const [kind, dump, expiry, memory, now, raw] = await c.sendCommand(['EVAL_RO', snapshotLua, '1', key], options);
    const type = text(kind);
    let value;
    if (type === 'string') value = text(raw);
    else if (type === 'hash') value = Object.fromEntries(Array.from({ length: raw.length / 2 }, (_, i) => [text(raw[i * 2]), text(raw[i * 2 + 1])]));
    else if (type === 'zset') value = Array.from({ length: raw.length / 2 }, (_, i) => ({ value: text(raw[i * 2]), score: text(raw[i * 2 + 1]) }));
    else value = raw.map(text);
    return { type, dump: dump.toString('base64'), expiry, memory, now, value };
  }
  public(snapshot, key) { const { dump, now, ...safe } = snapshot; return { key, ...safe, ttlMs: snapshot.expiry === -1 ? -1 : Math.max(0, snapshot.expiry - now) }; }
  async read(key) { return this.using(async c => this.public(await this.snapshot(c, key), key)); }
  command(before, input) {
    const string = value => typeof value === 'string' && Buffer.byteLength(value) <= 32768;
    const action = input.action;
    if (action === 'set') { requireValue(before.type === 'string' && string(input.value), 'INVALID_REDIS_VALUE'); return ['SET', input.value, 'KEEPTTL']; }
    if (action === 'hash_set') {
      requireValue(before.type === 'hash' && input.fields && Object.getPrototypeOf(input.fields) === Object.prototype, 'INVALID_REDIS_VALUE');
      const entries = Object.entries(input.fields); requireValue(entries.length > 0 && entries.length <= 100 && entries.every(([k,v]) => string(k) && string(v)), 'INVALID_REDIS_VALUE');
      return ['HSET', ...entries.flat()];
    }
    if (action === 'list_set') { requireValue(before.type === 'list' && Number.isSafeInteger(input.index) && input.index >= 0 && input.index < before.value.length && string(input.value), 'INVALID_REDIS_VALUE'); return ['LSET', String(input.index), input.value]; }
    if (action === 'set_add' || action === 'set_remove') { requireValue(before.type === 'set' && Array.isArray(input.members) && input.members.length > 0 && input.members.length <= 100 && input.members.every(string), 'INVALID_REDIS_VALUE'); return [action === 'set_add' ? 'SADD' : 'SREM', ...input.members]; }
    if (action === 'zset_add') {
      requireValue(before.type === 'zset' && Array.isArray(input.members) && input.members.length > 0 && input.members.length <= 100 && input.members.every(m => string(m.value) && Number.isFinite(Number(m.score))), 'INVALID_REDIS_VALUE');
      return ['ZADD', ...input.members.flatMap(m => [String(m.score), m.value])];
    }
    if (action === 'ttl') { requireValue(Number.isInteger(input.seconds) && input.seconds >= -1 && input.seconds <= 31536000, 'INVALID_TTL'); return input.seconds === -1 ? ['PERSIST'] : ['PEXPIREAT', String(before.now + input.seconds * 1000)]; }
    if (action === 'delete') return ['DEL'];
    throw new ChangeError('REDIS_ACTION_UNSUPPORTED');
  }
  async prepare({ key, changes }) {
    requireValue(changes && typeof changes === 'object', 'CHANGES_REQUIRED');
    return this.using(async c => {
      const beforeSnapshot = await this.snapshot(c, key);
      if(beforeSnapshot.type==='hash'){
        const info=await c.info('server');const version=/redis_version:(\d+)\.(\d+)/.exec(info);
        requireValue(version,'REDIS_7_REQUIRED');
        if(Number(version[1])>7||(Number(version[1])===7&&Number(version[2])>=4)){
          const fields=Object.keys(beforeSnapshot.value);
          if(fields.length){const expiries=await c.sendCommand(['HPEXPIRETIME',key,'FIELDS',String(fields.length),...fields]);requireValue(expiries.every(expiry=>expiry===-1),'HASH_FIELD_TTL_UNSUPPORTED');}
        }
      }
      const command = this.command(beforeSnapshot, changes);
      requireValue(beforeSnapshot.memory + Buffer.byteLength(JSON.stringify(changes)) < maxBytes, 'KEY_TOO_LARGE');
      const before={type:beforeSnapshot.type,value:beforeSnapshot.value,expiresAt:beforeSnapshot.expiry};
      const after=structuredClone(before);
      if(changes.action==='set') after.value=changes.value;
      if(changes.action==='hash_set') after.value={...after.value,...changes.fields};
      if(changes.action==='list_set') after.value[changes.index]=changes.value;
      if(changes.action==='set_add') after.value=[...new Set([...after.value,...changes.members])];
      if(changes.action==='set_remove') after.value=after.value.filter(v=>!changes.members.includes(v));
      if(changes.action==='zset_add') { const entries=new Map(after.value.map(m=>[m.value,m.score]));for(const m of changes.members) entries.set(m.value,String(Number(m.score)));after.value=[...entries].map(([value,score])=>({value,score})).sort((a,b)=>Number(a.score)-Number(b.score)||Buffer.compare(Buffer.from(a.value),Buffer.from(b.value))); }
      if(changes.action==='ttl') after.expiresAt=changes.seconds===-1?-1:Number(command[1]);
      if(changes.action==='delete'||(changes.action==='set_remove'&&!after.value.length)||(changes.action==='ttl'&&changes.seconds===0)) Object.assign(after,{type:'none',value:null,expiresAt:-2});
      if(after.type==='hash') requireValue(Object.keys(after.value).length<=1000,'KEY_TOO_LARGE');
      if(['list','set','zset'].includes(after.type)) requireValue(after.value.length<=1000,'KEY_TOO_LARGE');
      requireValue(JSON.stringify(before)!==JSON.stringify(after),'NO_CHANGE');
      return { engine: 'redis', key, table: key, keyValue: key, connectionRevision: this.config.revision,
        beforeSnapshot, command, before, after,
        forward: { sql: JSON.stringify([command[0], key, ...command.slice(1)]), parameters: [] },
        rollback: { sql: `RESTORE ${JSON.stringify(key)} ${beforeSnapshot.expiry === -1 ? 0 : beforeSnapshot.expiry} <原始 DUMP 二进制> REPLACE${beforeSnapshot.expiry === -1 ? '' : ' ABSTTL'}`, parameters: [] } };
    });
  }
  async transition(plan, rollback) {
    return this.using(async c => {
      const original = plan.beforeSnapshot;
      let args;
      if (rollback) {
        requireValue(plan.outcome?.dump !== undefined, 'OUTCOME_UNKNOWN');
        args = ['EVAL', rollbackLua, '1', plan.key, Buffer.from(plan.outcome.dump, 'base64'), String(plan.outcome.expiry), Buffer.from(original.dump, 'base64'), String(original.expiry)];
      } else args = ['EVAL', applyLua, '1', plan.key, Buffer.from(original.dump, 'base64'), String(original.expiry), JSON.stringify(plan.command)];
      const [dump, expiry] = await c.sendCommand(args, options);
      return { dump: Buffer.isBuffer(dump) ? dump.toString('base64') : '', expiry };
    });
  }
}
