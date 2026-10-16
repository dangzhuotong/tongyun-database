import { readFileSync } from 'node:fs';
import { ChangeControl, privateJson } from './change-control/core.mjs';

const help = `Usage: npm run db -- <prepare|inspect|apply|rollback|audit> --db FILE --context FILE
  prepare  --input FILE                  Structured {table,key,changes}; no arbitrary SQL
  inspect  --plan ID                     PRIVATE: prints before/after and SQL parameters
  apply    --plan ID --approve DIGEST    Confirm the inspected plan digest
  rollback --plan ID --approve DIGEST    Confirm guarded compensation
  audit                                 Metadata only; verifies the local hash chain
Context JSON: {actor,taskId,connectionId,environment}. Local prototype; labels are not authentication.
Only use isolated local SQLite files in this CLI. MySQL/Redis are available through the workbench API.`;

let control;
try {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === '--help') { console.log(help); process.exit(0); }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--db', '--context', '--input', '--plan', '--approve'].includes(args[i]) || !args[i + 1] || args[i] in options) throw new Error('INVALID_ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  if (!['prepare', 'inspect', 'apply', 'rollback', 'audit'].includes(action) || !options['--db'] || !options['--context']) throw new Error('INVALID_ARGUMENTS');
  const json = filename => JSON.parse(readFileSync(filename, 'utf8'));
  control = new ChangeControl(options['--db'], json(options['--context']));
  let result;
  if (action === 'prepare') result = control.prepareUpdate(json(options['--input']));
  if (action === 'inspect') result = control.inspect(options['--plan']);
  if (action === 'apply' || action === 'rollback') result = control.transition(options['--plan'], options['--approve'], action === 'rollback');
  if (action === 'audit') result = control.events();
  console.log(privateJson({ ok: true, ...result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.code && /^[A-Z_]+$/.test(error.code) ? error.code : 'COMMAND_FAILED' }));
  process.exitCode = 1;
} finally { control?.close(); }
