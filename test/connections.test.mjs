import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { ConnectionStore } from '../src/connections/store.mjs';
import { ChangeControl, ChangeError } from '../src/change-control/core.mjs';
import { RemoteService } from '../src/connections/service.mjs';
import { readSql } from '../src/connections/mysql.mjs';
import { createWorkbench } from '../src/server.mjs';
import { verifyFixture } from '../scripts/fixture-config.mjs';

const fixturePath = new URL('../.local/services.private.json', import.meta.url);
const services = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath)) : null;
if(services)verifyFixture(services);
function local(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'tongyun-remote-'));
  const filename = join(dir, 'audit.sqlite'); new DatabaseSync(filename).close();
  const core = new ChangeControl(filename, { actor:'agent:integration',taskId:'remote-test',connectionId:config.id,environment:config.environment });
  t.after(() => { core.close(); rmSync(dir,{recursive:true,force:true}); });
  return new RemoteService(core,config);
}
test('connection credentials are encrypted, metadata is redacted, production defaults fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(),'tongyun-store-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store = new ConnectionStore(dir);
  const input = {engine:'mysql',name:'Example',host:'127.0.0.1',port:3306,database:'example',username:'test',password:'private-test-password',environment:'test',allowWrites:false};
  const item = store.add(input); assert.equal(item.password,undefined); assert.equal(item.hasPassword,true);
  assert.ok(!readFileSync(join(dir,'connections.private.json'),'utf8').includes(input.password));
  assert.equal(new ConnectionStore(dir).get(item.id).password,input.password);
  assert.throws(()=>store.add({...input,environment:'production',allowWrites:true}),/PRODUCTION_WRITES_DISABLED/);
  assert.throws(()=>store.add({...input,host:'http://bad.example'}),/INVALID_HOST/);
});
test('MySQL SELECT parser rejects side effects, system schemas, stored functions and suffixes',()=>{
  assert.match(readSql('SELECT id FROM customers WHERE id=1','example',['customers']),/SELECT/);
  assert.match(readSql('SELECT * FROM customers LIMIT 1000;','example',['customers']),/SELECT/);
  for(const sql of ["DELETE FROM customers", "SELECT * INTO OUTFILE '/tmp/dump' FROM customers", 'SELECT SLEEP(5)', 'SELECT LOAD_FILE(\'/etc/passwd\')', 'SELECT * FROM mysql.user', 'SELECT * FROM customers FOR UPDATE', 'SELECT 1; UPDATE customers SET id=2', 'SELECT example.custom_function(id) FROM customers', 'SELECT @x := 1']) assert.throws(()=>readSql(sql,'example',['customers']),/QUERY_REJECTED/);
});
test('Redis COUNT spill cursors retain every key and fill the following page',async t=>{
  const service=local(t,{engine:'redis',id:randomUUID(),revision:randomUUID(),environment:'test'});
  const rows=(start,count)=>Array.from({length:count},(_,i)=>({key:`example-${start+i}`,type:'string',ttlMs:-1,memoryBytes:64}));
  service.adapter.scan=async({cursor})=>cursor==='0'?{rows:rows(0,1002),cursor:'999'}:{rows:rows(1002,5),cursor:'0'};
  const first=await service.scan({pattern:'*'});assert.equal(first.rows.length,1000);assert.match(first.nextCursor,/^page:/);
  const second=await service.scan({pattern:'*',cursor:first.nextCursor});assert.equal(second.rows.length,7);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.rows,...second.rows].map(row=>row.key)).size,1007);
});
test('real MySQL schema, bigint, cursor, update/rollback and stale-row guards', {skip:!services}, async t=>{
  const config={...services.mysql,id:randomUUID(),revision:randomUUID()};
  const raw=await mysql.createConnection({host:config.host,port:config.port,user:config.username,password:config.password,database:config.database});t.after(()=>raw.end());
  await raw.query('CREATE TABLE IF NOT EXISTS integration_records(id BIGINT PRIMARY KEY, name VARCHAR(100), amount DECIMAL(12,2)) ENGINE=InnoDB');
  await raw.query('DELETE FROM integration_records');await raw.query("INSERT INTO integration_records VALUES(1,'Example',10.25),(9007199254740993,'Big integer',20.00)");
  const service=local(t,config);assert.equal((await service.test()).engine,'mysql');
  assert.ok((await service.schema()).tables.some(t=>t.name==='integration_records'));
  const rows=await service.browse('integration_records');assert.equal(rows.rows[1].id,'9007199254740993');
  const plan=await service.prepare({table:'integration_records',key:'1',changes:{amount:'30.50'}});
  assert.equal((await raw.query('SELECT amount FROM integration_records WHERE id=1'))[0][0].amount,'10.25');
  assert.match((await service.inspect(plan.id)).rollback.sql,/UPDATE/);
  await assert.rejects(service.transition(plan.id,'bad',false),/APPROVAL_REQUIRED/);
  await service.transition(plan.id,plan.digest,false);assert.equal((await service.transition(plan.id,plan.digest,false)).replayed,true);
  await service.transition(plan.id,plan.digest,true);assert.equal((await raw.query('SELECT amount FROM integration_records WHERE id=1'))[0][0].amount,'10.25');
  const stale=await service.prepare({table:'integration_records',key:'1',changes:{amount:'40.00'}});
  await raw.query("UPDATE integration_records SET name='other' WHERE id=1");
  await assert.rejects(service.transition(stale.id,stale.digest,false),/ROW_CONFLICT/);
  await assert.rejects(service.query('SELECT SLEEP(3)'),/QUERY_REJECTED/);
  await assert.rejects(service.query(`SELECT SUM(LENGTH(CONCAT(${Array.from({length:30},(_,i)=>`a${i}.name`).join(',')}))) AS total FROM ${Array.from({length:30},(_,i)=>`integration_records a${i}`).join(' CROSS JOIN ')}`),/QUERY_TIMEOUT/);
  const readonly=local(t,{...config,id:randomUUID(),allowWrites:false});await assert.rejects(readonly.prepare({table:'integration_records',key:1,changes:{name:'x'}}),/CONNECTION_READ_ONLY/);
});
test('real Redis five type editors, TTL, exact rollback, delete restore and conflict guards', {skip:!services},async t=>{
  const config={...services.redis,id:randomUUID(),revision:randomUUID()};
  const raw=createClient({socket:{host:config.host,port:config.port,reconnectStrategy:false}});raw.on('error',()=>{});await raw.connect();
  const prefix=`test:${randomUUID()}:`;const keys=['string','hash','list','set','zset','ttl','delete'].map(k=>prefix+k);
  t.after(async()=>{try{if(raw.isReady)await raw.del(keys)}finally{raw.destroy()}});
  await raw.set(keys[0],'before');await raw.hSet(keys[1],{a:'1'});await raw.rPush(keys[2],['a','b']);await raw.sAdd(keys[3],['a']);await raw.zAdd(keys[4],[{score:1,value:'a'}]);await raw.set(keys[5],'expiring',{EX:60});await raw.set(keys[6],'restore-me');
  const service=local(t,config);assert.equal((await service.test()).engine,'redis');
  const scan=await service.scan({pattern:prefix+'*'});assert.ok(scan.rows.length>0);
  const edits=[{action:'set',value:'after'},{action:'hash_set',fields:{a:'2',b:'3'}},{action:'list_set',index:1,value:'changed'},{action:'set_add',members:['b']},{action:'zset_add',members:[{score:5,value:'b'}]},{action:'ttl',seconds:120},{action:'delete'}];
  for(let i=0;i<keys.length;i++){
    const before=await raw.dump(keys[i]);const expiry=await raw.pExpireTime(keys[i]);
    const plan=await service.prepare({key:keys[i],changes:edits[i]});
    assert.deepEqual(await raw.dump(keys[i]),before);
    await service.transition(plan.id,plan.digest,false);assert.equal((await service.transition(plan.id,plan.digest,false)).replayed,true);
    await service.transition(plan.id,plan.digest,true);
    assert.deepEqual(await raw.dump(keys[i]),before);assert.equal(await raw.pExpireTime(keys[i]),expiry);
  }
  const plan=await service.prepare({key:keys[0],changes:{action:'set',value:'new'}});await service.transition(plan.id,plan.digest,false);await raw.set(keys[0],'external');
  await assert.rejects(service.transition(plan.id,plan.digest,true),/ROW_CONFLICT/);
  assert.equal(await raw.get(keys[0]),'external');
  await raw.sendCommand(['HPEXPIRE',keys[1],'60000','FIELDS','1','a']);
  await assert.rejects(service.prepare({key:keys[1],changes:{action:'hash_set',fields:{a:'changed'}}}),/HASH_FIELD_TTL_UNSUPPORTED/);
});
test('Redis refuses to resurrect expired originals and unknown outcomes cannot repeat mutations',{skip:!services},async t=>{
  const config={...services.redis,id:randomUUID(),revision:randomUUID()};
  const raw=createClient({socket:{host:config.host,port:config.port,reconnectStrategy:false}});raw.on('error',()=>{});await raw.connect();
  const key=`test:${randomUUID()}`;t.after(async()=>{try{await raw.del(key)}finally{raw.destroy()}});
  const service=local(t,config);
  await raw.set(key,'old',{PX:300});
  const plan=await service.prepare({key,changes:{action:'ttl',seconds:120}});await service.transition(plan.id,plan.digest,false);
  await new Promise(resolve=>setTimeout(resolve,350));
  await assert.rejects(service.transition(plan.id,plan.digest,true),/ROLLBACK_EXPIRED/);
  assert.equal(await raw.get(key),'old');
  const pending=await service.prepare({key,changes:{action:'set',value:'new'}});
  let calls=0;
  service.adapter.transition=async()=>{calls++;await raw.set(key,'new');throw new ChangeError('REDIS_ERROR')};
  await assert.rejects(service.transition(pending.id,pending.digest,false),/OUTCOME_UNKNOWN/);
  assert.equal((await service.inspect(pending.id)).state,'unknown');
  await assert.rejects(service.transition(pending.id,pending.digest,false),/OUTCOME_UNKNOWN/);
  assert.equal(calls,1);assert.equal(await raw.get(key),'new');
});
test('network HTTP API shares UI/Agent plans, redacts passwords and binds connection/task',{skip:!services},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tongyun-http-'));const filename=join(dir,'sandbox.sqlite');new DatabaseSync(filename).close();
  const server=createWorkbench({filename,token:'integration-token'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,body,connection='local-sqlite',task='shared'){
    const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer integration-token','Content-Type':'application/json','X-Tongyun-Connection':connection,'X-Tongyun-Task':task,'X-Tongyun-Actor':'agent:http'},body:body===undefined?undefined:JSON.stringify(body)});return response.json();
  }
  const mysqlConnection=(await call('connections',services.mysql)).connection;
  const redisConnection=(await call('connections',services.redis)).connection;
  assert.equal(mysqlConnection.password,undefined);assert.ok(!JSON.stringify(await call('connections')).includes(services.mysql.password));
  const query=await call('query',{sql:'SELECT id,name FROM customers ORDER BY id LIMIT 1'},mysqlConnection.id);assert.equal(query.ok,true);assert.equal(query.rows[0].id,'1');
  assert.equal((await call(`queries/${query.operationId}`,undefined,redisConnection.id)).error,'CONTEXT_MISMATCH');
  assert.match((await call(`queries/${query.operationId}`,undefined,mysqlConnection.id)).sql,/SELECT/);
  const scan=await call('redis/scan',{pattern:'demo:*'},redisConnection.id);assert.equal(scan.ok,true);
  const operation=await call(`operations/${scan.operationId}`,undefined,redisConnection.id);assert.deepEqual(operation.request,{pattern:'demo:*'});
  const plan=await call('plans',{key:'demo:welcome',changes:{action:'set',value:'HTTP draft'}},redisConnection.id);assert.equal(plan.ok,true);
  assert.ok((await call('plans',undefined,redisConnection.id)).plans.some(p=>p.id===plan.id));
  assert.equal((await call(`plans/${plan.id}`,undefined,mysqlConnection.id)).error,'CONTEXT_MISMATCH');
  assert.equal((await call(`plans/${plan.id}`,undefined,redisConnection.id,'other-task')).error,'CONTEXT_MISMATCH');
  const ro=(await call('connections',{...services.redis,name:'Read-only',allowWrites:false})).connection;
  assert.equal((await call('plans',{key:'demo:welcome',changes:{action:'set',value:'blocked'}},ro.id)).error,'CONNECTION_READ_ONLY');
});
