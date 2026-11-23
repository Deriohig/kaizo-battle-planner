// The compiled server: `tsc -p tsconfig.server.json` emits all of src, `npm start` runs the emitted entry, and the
// emitted app imports under plain Node, with no tsx.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (file: string) => JSON.parse(readFileSync(path.join(repo, file), 'utf8')) as Record<string, unknown>;
// Inside the repo (dist/ is git-ignored), so the emitted files resolve node_modules as the real build's do.
const outDir = path.join(repo, 'dist', `test-server-${process.pid}`);
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it('npm run build:server emits all of src with tsc, npm start runs its entry, and the app imports under plain node', () => {
  expect(readJson('package.json').scripts).toMatchObject({
    'build:server': 'tsc -p tsconfig.server.json', build: 'npm run build:web && npm run build:server', start: 'node dist/server/server/main.js --hosted',
  });
  expect(readJson('tsconfig.server.json')).toEqual({ extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'dist/server', rootDir: 'src' }, include: ['src'] });
  const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.server.json', '--outDir', outDir], { cwd: repo, encoding: 'utf8' });
  expect([build.status, build.stdout + build.stderr]).toEqual([0, '']);
  expect(existsSync(path.join(outDir, 'server', 'main.js'))).toBe(true);
  const app = new URL(`file://${path.join(outDir, 'server', 'app.js')}`).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(app)}); console.log('imported')`], { cwd: repo, encoding: 'utf8' });
  expect([run.stderr, run.stdout.trim()]).toEqual(['', 'imported']);
});
