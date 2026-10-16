import { MysqlAdapter } from './mysql.mjs';
process.once('message', async ({config, action, args})=>{
  try {
    const adapter=new MysqlAdapter(config);
    const result=action==='query'?await adapter.query(...args):await adapter.browse(...args);
    process.send({result});
  } catch(error) { process.send({error:typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'QUERY_FAILED'}); }
  finally { process.disconnect(); }
});
