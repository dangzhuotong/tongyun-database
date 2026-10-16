import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';

const directory = fileURLToPath(new URL('../.local/', import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const fixture = `${directory}/services.private.json`;
const docker = args => { const r = spawnSync('docker', args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error('Docker operation failed'); return r.stdout.trim(); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv[2] === 'stop') {
  if (existsSync(fixture)) {
    const config = JSON.parse(readFileSync(fixture, 'utf8'));
    for (const name of config.containers) {
      const owner = docker(['inspect', '--format', '{{index .Config.Labels "tongyun.fixture"}}', name]);
      if (owner !== config.owner) throw new Error('Fixture ownership mismatch');
      docker(['rm', '-f', name]);
    }
    unlinkSync(fixture); console.log('Removed this workspace’s disposable database containers');
  }
} else if (process.argv[2] === 'start') {
  if (existsSync(fixture)) { const previous=JSON.parse(readFileSync(fixture,'utf8'));if(previous.ready===false)throw new Error('Setup incomplete; stop the registered fixture before starting again');console.log('Isolated services already registered in .local/services.private.json'); process.exit(0); }
  const owner = randomBytes(6).toString('hex'); const password = randomBytes(24).toString('hex');
  const mysqlName = `tongyun-mysql-${owner}`; const redisName = `tongyun-redis-${owner}`;
  const config = { owner, containers: [], ready:false };
  try {
    console.log('Starting isolated MySQL 8.4 and Redis 7.4…');
    docker(['run','-d','--name',mysqlName,'--label',`tongyun.fixture=${owner}`,'-e',`MYSQL_ROOT_PASSWORD=${password}`,'-e','MYSQL_DATABASE=tongyun_demo','-p','127.0.0.1::3306','mysql:8.4']);
    config.containers.push(mysqlName);writeFileSync(fixture,JSON.stringify(config),{mode:0o600});
    docker(['run','-d','--name',redisName,'--label',`tongyun.fixture=${owner}`,'-p','127.0.0.1::6379','redis:7.4-alpine','redis-server','--save','','--appendonly','no']);
    config.containers.push(redisName);writeFileSync(fixture,JSON.stringify(config),{mode:0o600});
    const mysqlPort = Number(docker(['port',mysqlName,'3306/tcp']).split(':').at(-1));
    const redisPort = Number(docker(['port',redisName,'6379/tcp']).split(':').at(-1));
    config.mysql = { engine:'mysql', name:'MySQL · 本机演示', host:'127.0.0.1',port:mysqlPort,username:'root',password,database:'tongyun_demo',environment:'test',allowWrites:true,tls:false };
    config.redis = { engine:'redis', name:'Redis · 本机演示', host:'127.0.0.1',port:redisPort,username:'',password:'',database:'0',environment:'test',allowWrites:true,tls:false };
    // Persist ownership before readiness so interrupted setup can still be cleaned up.
    writeFileSync(fixture, JSON.stringify(config), { mode: 0o600 });
    let connection;
    for (let i=0;i<90;i++) { try { connection=await mysql.createConnection({host:'127.0.0.1',port:mysqlPort,user:'root',password,database:'tongyun_demo',connectTimeout:1000}); break; } catch { await delay(1000); } }
    if (!connection) throw new Error('MySQL readiness timeout');
    await connection.query('CREATE TABLE customers(id BIGINT PRIMARY KEY, name VARCHAR(100) NOT NULL, credits DECIMAL(12,2) NOT NULL) ENGINE=InnoDB');
    await connection.query("INSERT INTO customers VALUES (1,'示例客户 A',120.00),(2,'示例客户 B',80.00),(9007199254740993,'大整数示例',25.50)");
    await connection.end();
    const redis = createClient({socket:{host:'127.0.0.1',port:redisPort,reconnectStrategy:false}}); redis.on('error',()=>{}); await redis.connect();
    await redis.set('demo:welcome','你好，橦云数据库'); await redis.hSet('demo:profile',{name:'示例用户',status:'active'});
    await redis.rPush('demo:queue',['task-1','task-2']); await redis.sAdd('demo:tags',['database','agent']);
    await redis.zAdd('demo:ranking',[{score:100,value:'example-a'},{score:80,value:'example-b'}]);
    await redis.set('demo:expiring','TTL 示例',{EX:3600}); await redis.quit();
    config.ready=true;writeFileSync(fixture,JSON.stringify(config),{mode:0o600});
    console.log(`Ready: MySQL 127.0.0.1:${mysqlPort}, Redis 127.0.0.1:${redisPort}. Credentials only in ignored .local/services.private.json`);
  } catch (error) { console.error('Setup incomplete. Use node scripts/services.mjs stop to clean up registered fixtures.'); process.exitCode=1; }
} else console.log('Usage: node scripts/services.mjs start|stop');
