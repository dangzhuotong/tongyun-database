import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function secretsEnabled() {
  return Boolean(process.env.TONGYUN_SECRETS_BIN);
}

export function discoverSecretsBin() {
  if (process.env.TONGYUN_SECRETS_BIN) return process.env.TONGYUN_SECRETS_BIN;
  const name = process.platform === 'win32' ? 'tongyun-database-secrets.exe' : 'tongyun-database-secrets';
  for (const profile of ['debug', 'release']) {
    const candidate = join(repoRoot, 'target', profile, name);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function argv(rest) {
  const prefix = (process.env.TONGYUN_SECRETS_PREFIX ?? '').trim();
  const head = prefix ? prefix.split(/\s+/) : [];
  return [...head, ...rest];
}

function run(args, input) {
  const bin = process.env.TONGYUN_SECRETS_BIN;
  if (!bin) return { ok: false, code: 'CONNECTION_SECRET_UNAVAILABLE' };
  const result = spawnSync(bin, argv(args), {
    input,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status === null) return { ok: false, code: 'CONNECTION_SECRET_UNAVAILABLE' };
  return result;
}

export function secretGet(dir, account) {
  const result = run(['get', '--dir', dir, '--account', account]);
  if (result.code) return result;
  if (result.status === 2) return { ok: false, code: 'CONNECTION_SECRET_MISSING' };
  if (result.status !== 0) return { ok: false, code: 'CONNECTION_SECRET_UNAVAILABLE' };
  return { ok: true, value: result.stdout.toString('utf8') };
}

export function secretSet(dir, account, value) {
  const result = run(['set', '--dir', dir, '--account', account], Buffer.from(value, 'utf8'));
  if (result.code) return result;
  if (result.status !== 0) return { ok: false, code: 'CONNECTION_SECRET_UNAVAILABLE' };
  return { ok: true };
}

export function secretDelete(dir, account) {
  const result = run(['delete', '--dir', dir, '--account', account]);
  if (result.code) return result;
  if (result.status !== 0) return { ok: false, code: 'CONNECTION_SECRET_UNAVAILABLE' };
  return { ok: true };
}

export function activateSecrets(dir) {
  const bin = discoverSecretsBin();
  if (!bin) return false;
  process.env.TONGYUN_SECRETS_BIN = bin;
  const result = spawnSync(bin, argv(['migrate-legacy', '--dir', dir]), {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error('连接密码迁移失败，已停止启动。');
    process.exit(1);
  }
  return true;
}
