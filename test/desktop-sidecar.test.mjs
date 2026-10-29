import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { directoryFromArgs, frameAncestorsPolicy } from '../src/server.mjs';

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

test('release desktop frame ancestors do not include the vite dev port', () => {
  assert.equal(frameAncestorsPolicy({}), "frame-ancestors 'none'");
  const release = frameAncestorsPolicy({ TONGYUN_DESKTOP: '1' });
  assert.match(release, /tauri\.localhost/);
  assert.match(release, /tauri:\/\/localhost/);
  assert.equal(release.includes('1420'), false);
  assert.equal(release.includes('127.0.0.1:1420'), false);
  const dev = frameAncestorsPolicy({ TONGYUN_DESKTOP: '1', TONGYUN_DESKTOP_DEV: '1' });
  assert.match(dev, /127\.0\.0\.1:1420/);
  assert.match(dev, /localhost:1420/);
});

test('data dir is taken from the sidecar argument', () => {
  assert.equal(directoryFromArgs(['node', 'server.mjs']), '');
  const arg = join(tmpdir(), 'tongyun data');
  const dir = directoryFromArgs(['node', 'server.mjs', '--data-dir', arg]);
  assert.equal(dir, resolve(arg));
});

function waitForEndpoint(dir, child, timeoutMs) {
  const endpoint = join(dir, 'endpoint.json');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const url = JSON.parse(readFileSync(endpoint, 'utf8')).url;
        resolve(url);
        return;
      } catch { /* not written yet */ }
      if (child.exitCode !== null) {
        reject(new Error('sidecar exited before endpoint.json'));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('sidecar did not write endpoint.json'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function probe(url) {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET' }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

test('desktop sidecar exits when the parent closes its stdin pipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tongyun-sidecar-'));
  const child = spawn(process.execPath, [server, '--data-dir', dir], {
    env: {
      ...process.env,
      TONGYUN_DESKTOP: '1',
      TONGYUN_DATABASE_PORT: '0',
      TONGYUN_DATA_DIR: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const url = await waitForEndpoint(dir, child, 8000);
    assert.ok(url.startsWith('http://127.0.0.1:'), stderr);
    child.stdin.end();
    const code = await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`sidecar stayed up after stdin closed\n${stderr}`)), 4000)),
    ]);
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop sidecar exits when its parent process exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tongyun-ppid-'));
  const wrapperPath = join(dir, 'wrapper.mjs');
  const endpoint = join(dir, 'endpoint.json');
  writeFileSync(wrapperPath, `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const child = spawn(process.execPath, process.argv.slice(2), {
  env: process.env,
  stdio: ['inherit', 'ignore', 'ignore'],
});
child.unref();
const endpoint = process.env.TONGYUN_WRAPPER_ENDPOINT;
const started = Date.now();
const timer = setInterval(() => {
  if ((endpoint && existsSync(endpoint)) || Date.now() - started > 7000) {
    clearInterval(timer);
    process.exit(0);
  }
}, 30);
`);
  const wrapper = spawn(process.execPath, [wrapperPath, server, '--data-dir', dir], {
    env: {
      ...process.env,
      TONGYUN_DESKTOP: '1',
      TONGYUN_DATABASE_PORT: '0',
      TONGYUN_DATA_DIR: dir,
      TONGYUN_WRAPPER_ENDPOINT: endpoint,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const wrapperExit = new Promise((resolve) => wrapper.once('exit', resolve));
  try {
    const url = await waitForEndpoint(dir, { exitCode: null }, 8000);
    const wrapperCode = wrapper.exitCode ?? await Promise.race([
      wrapperExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper stayed up')), 4000)),
    ]);
    assert.equal(wrapperCode, 0);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await probe(url), false);
  } finally {
    if (wrapper.exitCode === null) wrapper.kill('SIGKILL');
    spawnSync('pkill', ['-f', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});
