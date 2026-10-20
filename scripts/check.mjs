import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
function files(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):/\.(mjs|js)$/.test(e.name)?[join(dir,e.name)]:[]); }
for(const file of ['src','public','scripts','test'].flatMap(files)) {
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
const result=spawnSync(process.execPath,['--test','test/**/*.test.mjs'],{stdio:'inherit'});process.exit(result.status??1);
