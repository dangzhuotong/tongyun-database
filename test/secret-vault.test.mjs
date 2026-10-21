import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ConnectionStore } from '../src/connections/store.mjs';
import { discoverSecretsBin } from '../src/connections/vault-cli.mjs';

const bin = discoverSecretsBin();
const required = process.env.TONGYUN_REQUIRE_SECRETS_BIN === '1';
if (required && !bin) throw new Error('TONGYUN_SECRETS_BIN is required but target/debug/tongyun-database-secrets is missing');

test('connection passwords move into the file vault and settings stay out of it', { skip: !bin }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tongyun-vault-'));
  const previousBin = process.env.TONGYUN_SECRETS_BIN;
  const previousPrefix = process.env.TONGYUN_SECRETS_PREFIX;
  delete process.env.TONGYUN_SECRETS_PREFIX;
  try {
    const legacy = new ConnectionStore(dir);
    const input = {
      engine: 'mysql', name: 'Example', host: '127.0.0.1', port: 3306, database: 'example',
      username: 'test', password: 'synthetic-vault-password', environment: 'test', allowWrites: false,
    };
    const created = legacy.add(input);
    assert.equal(created.password, undefined);
    assert.equal(created.hasPassword, true);
    assert.equal(created.secretAccount, undefined);

    const migrated = spawnSync(bin, ['migrate-legacy', '--dir', dir], { encoding: 'utf8' });
    assert.equal(migrated.status, 0, migrated.stderr);
    const report = JSON.parse(migrated.stdout);
    assert.equal(report.imported, 1);
    assert.equal(report.alreadyMigrated, false);

    const blob = readFileSync(join(dir, 'connections.private.json'));
    assert.ok(!blob.includes(Buffer.from(input.password)));
    const vault = readFileSync(join(dir, 'secrets.vault'));
    assert.ok(!vault.includes(Buffer.from(input.password)));
    assert.equal(statSync(join(dir, 'secrets.vault')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'secret.key')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    process.env.TONGYUN_SECRETS_BIN = bin;
    const again = spawnSync(bin, ['migrate-legacy', '--dir', dir], { encoding: 'utf8' });
    assert.equal(JSON.parse(again.stdout).alreadyMigrated, true);
    const store = new ConnectionStore(dir);
    assert.equal(store.get(created.id).password, input.password);
    assert.equal(store.list()[0].password, undefined);
    assert.equal(store.list()[0].hasPassword, true);
    assert.equal(store.list()[0].secretAccount, undefined);

    const added = store.add({ ...input, name: 'Second' });
    assert.equal(store.get(added.id).password, input.password);
    const savedBlob = readFileSync(join(dir, 'connections.private.json'));
    assert.ok(!savedBlob.includes(Buffer.from(input.password)));
  } finally {
    if (previousBin === undefined) delete process.env.TONGYUN_SECRETS_BIN;
    else process.env.TONGYUN_SECRETS_BIN = previousBin;
    if (previousPrefix === undefined) delete process.env.TONGYUN_SECRETS_PREFIX;
    else process.env.TONGYUN_SECRETS_PREFIX = previousPrefix;
    rmSync(dir, { recursive: true, force: true });
  }
});
