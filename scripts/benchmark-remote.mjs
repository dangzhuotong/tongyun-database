import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { DatabaseSync } from 'node:sqlite';
import { ChangeControl } from '../src/change-control/core.mjs';
import { RemoteService } from '../src/connections/service.mjs';
import { verifyFixture } from './fixture-config.mjs';
const fixture=JSON.parse(readFileSync(new URL('../.local/services.private.json',import.meta.url)));
verifyFixture(fixture);
const unique=randomBytes(6).toString('hex');const table=`bench_${unique}`;const prefix=`bench:${unique}:`;
const directory=mkdtempSync(join(tmpdir(),'tongyun-remote-bench-'));const filename=join(directory,'audit.sqlite');new DatabaseSync(filename).close();
const config=fixture.mysql;const db=await mysql.createConnection({host:config.host,port:config.port,user:config.username,password:config.password,database:config.database});
const redis=createClient({socket:{host:fixture.redis.host,port:fixture.redis.port,reconnectStrategy:false}});redis.on('error',()=>{});await redis.connect();
const cores=[];const report={node:process.version,platform:process.platform,rows:1000000,scope:'Isolated local Docker; one warm-cache sample per page; includes client/process/audit overhead; excludes HTTP/browser and remote network. Not an SLA.'};
function service(config){const core=new ChangeControl(filename,{actor:'benchmark',taskId:'remote-million',connectionId:config.engine,environment:'test'});cores.push(core);return new RemoteService(core,{...config,id:config.engine,revision:'benchmark'});}
try {
  console.log('Seeding 1,000,000 MySQL rows in an owned temporary table…');
  const begin=performance.now();await db.query(`CREATE TABLE \`${table}\`(id BIGINT PRIMARY KEY,label VARCHAR(64),amount INT) ENGINE=InnoDB`);
  const digits='(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
  const number='a.n+10*b.n+100*c.n+1000*d.n+10000*e.n+100000*f.n+1';
  await db.query(`INSERT INTO \`${table}\` SELECT ${number},CONCAT('example-',${number}),MOD(${number},1000) FROM ${['a','b','c','d','e','f'].map(alias=>`${digits} ${alias}`).join(' CROSS JOIN ')} ORDER BY 1`);
  const mysqlService=service(fixture.mysql);const pages=[];
  for(const after of [undefined,'500000','999000']){const start=performance.now();const result=await mysqlService.browse(table,after);pages.push({after:after??null,ms:Math.round((performance.now()-start)*100)/100,rows:result.rows.length,first:result.rows[0]?.id,last:result.rows.at(-1)?.id});}
  const [explain]=await db.query(`EXPLAIN SELECT * FROM \`${table}\` WHERE id>500000 ORDER BY id LIMIT 1001`);
  report.mysql={seedMs:Math.round(performance.now()-begin),pages,explain:explain.map(r=>({type:r.type,key:r.key,rows:r.rows,extra:r.Extra}))};
  console.log('Seeding 1,000,000 Redis keys in an owned namespace…');const redisBegin=performance.now();
  for(let offset=0;offset<1000000;offset+=1000) await redis.mSet(Object.fromEntries(Array.from({length:1000},(_,i)=>[`${prefix}${offset+i}`,`example-${offset+i}`])));
  const redisService=service(fixture.redis);const samples=[];let cursor;
  for(let i=0;i<3;i++){const start=performance.now();const result=await redisService.scan({pattern:prefix+'*',...(cursor?{cursor}:{})});samples.push({ms:Math.round((performance.now()-start)*100)/100,keys:result.rows.length,hasMore:Boolean(result.nextCursor)});cursor=result.nextCursor;}
  report.redis={seedMs:Math.round(performance.now()-redisBegin),samples,countHint:1000};
  writeFileSync(new URL('../.local/remote-benchmark.json',import.meta.url),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
} finally {
  console.log('Cleaning only the owned benchmark table and key prefix…');
  await db.query(`DROP TABLE IF EXISTS \`${table}\``);await db.end();
  let cursor='0';do{const result=await redis.scan(cursor,{MATCH:prefix+'*',COUNT:1000});if(result.keys.length)await redis.unlink(result.keys);cursor=result.cursor;}while(cursor!=='0');
  await redis.quit();cores.forEach(core=>core.close());rmSync(directory,{recursive:true,force:true});
}
