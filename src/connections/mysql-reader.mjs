import { MysqlAdapter } from './mysql.mjs';

const controller = new AbortController();
let started = false;
process.on('message', async message => {
  if (message?.cancel) { controller.abort(); return; }
  if (started || !message?.action) return;
  started = true;
  try {
    const adapter = new MysqlAdapter(message.config);
    const result = message.action === 'query'
      ? await adapter.query(message.args[0], { signal: controller.signal })
      : await adapter.browse(...message.args);
    process.send({ result });
  } catch (error) {
    process.send({ error: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'QUERY_FAILED' });
  } finally { process.disconnect(); }
});
