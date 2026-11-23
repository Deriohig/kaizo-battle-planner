import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

// The calc wrapper and the move mapping lean on @smogon/calc 0.12.0's Gen 4 internals, so no other version may load.
it('pins @smogon/calc to exactly 0.12.0, and 0.12.0 is the version installed', () => {
  expect(readJson('../../package.json').dependencies['@smogon/calc']).toBe('0.12.0');
  expect(readJson('../../node_modules/@smogon/calc/package.json').version).toBe('0.12.0');
});
