// The accepted differences in test/real/accepted-diffs.json, which `npm run record:diffs` writes, for the real-data checks.

import { readFileSync } from 'node:fs';
import type { DiffArea, KeyedDiff } from '../../src/check/diff.js';

export interface Accepted { diffs: Record<string, KeyedDiff>; romOnly: number[]; docsOnly: string[] }

export const accepted = JSON.parse(readFileSync(new URL('./accepted-diffs.json', import.meta.url), 'utf8')) as Accepted;

/** The accepted diffs of `area` whose field passes `keep`. */
export function acceptedFor(area: DiffArea, keep: (field: string) => boolean = () => true): Record<string, KeyedDiff> {
  return Object.fromEntries(Object.entries(accepted.diffs).filter(([key]) => key.startsWith(`${area}/`) && keep(key.slice(key.lastIndexOf('/') + 1))));
}
