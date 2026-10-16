import { spawnSync } from 'node:child_process';
/** Refuse to run destructive fixture tests against anything except this workspace's containers. */
export function verifyFixture(fixture) {
  if(!fixture||!/^[a-f0-9]{12}$/.test(fixture.owner)||fixture.ready===false)throw new Error('Isolated fixture is not ready');
  for(const [engine,port] of [['mysql','3306/tcp'],['redis','6379/tcp']]){
    const config=fixture[engine];const name=`tongyun-${engine}-${fixture.owner}`;
    if(!fixture.containers.includes(name)||config?.host!=='127.0.0.1'||config.environment!=='test')throw new Error('Fixture target is not an owned local test service');
    const owner=spawnSync('docker',['inspect','--format','{{index .Config.Labels "tongyun.fixture"}}',name],{encoding:'utf8'});
    const ports=spawnSync('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',name],{encoding:'utf8'});
    if(owner.status!==0||ports.status!==0||owner.stdout.trim()!==fixture.owner)throw new Error('Start the owned isolated Docker services before running network tests');
    const bindings=JSON.parse(ports.stdout)[port]??[];
    if(!bindings.some(p=>p.HostIp==='127.0.0.1'&&Number(p.HostPort)===config.port))throw new Error('Fixture port does not match its owned container');
  }
}
