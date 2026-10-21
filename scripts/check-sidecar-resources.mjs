import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const confPath = join(root, 'apps/desktop/src-tauri/tauri.conf.json');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const resources = conf.bundle?.resources;
if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
  console.error('tauri.conf.json bundle.resources must map sidecar files');
  process.exit(1);
}

const tauriDir = join(root, 'apps/desktop/src-tauri');
const nodeModulesEntry = Object.entries(resources).find(([, dest]) => dest === 'sidecar/node_modules');
if (!nodeModulesEntry) {
  console.error('bundle.resources does not place a directory at sidecar/node_modules');
  process.exit(1);
}

const source = join(tauriDir, nodeModulesEntry[0]);
if (!existsSync(source) || !statSync(source).isDirectory()) {
  console.error(`sidecar node_modules resource is missing: ${source}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const names = Object.keys(pkg.dependencies ?? {});
if (names.length === 0) {
  console.error('root package.json has no production dependencies to bundle');
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'tongyun-sidecar-bundle-'));
try {
  const bundled = join(stage, 'sidecar/node_modules');
  const missing = [];
  for (const name of names) {
    const from = join(source, name);
    const marker = join(from, 'package.json');
    if (!existsSync(marker)) {
      missing.push(name);
      continue;
    }
    cpSync(from, join(bundled, name), { recursive: true, dereference: true });
    if (!existsSync(join(bundled, name, 'package.json'))) missing.push(name);
  }
  if (missing.length > 0) {
    console.error(`sidecar bundle is missing production dependencies: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`sidecar bundle includes ${names.join(', ')}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
