// Search-side keys: a 128-bit digest for indexing, canonical JSON, and the text of a Choice. Hashes index; equality
// decides: the checker re-derives every state
// and never reads these keys, so a digest collision can only cost a checker mismatch, never a false "safe".

import { createHash } from 'node:crypto';
import type { Choice } from '../contracts/engine.js';

/** sha256 of `text`, base64url, first 22 characters (128 bits). Search side only. */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url').slice(0, 22);
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeys(record[k])]));
}

/**
 * 'm<slot>', 's<index>', or for an item 'i:' + the canonical JSON of the choice without `kind`, so every field
 * (`item`, `consumeSlots`, any later one) tells choices apart. Used in cache keys and history.
 */
export function choiceText(c: Choice): string {
  switch (c.kind) {
    case 'move': return `m${c.slot}`;
    case 'switch': return `s${c.index}`;
    case 'item': {
      const { kind: _kind, ...fields } = c;
      return `i:${canonicalJson(fields)}`;
    }
  }
}
