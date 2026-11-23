// The calc's three effect lists, and the check that they classify every effect text in the docs' Moves tab. The unit
// test runs the check where the gitignored data/docs/Moves.csv is saved; test/real/effectTexts.test.ts runs it on the
// real docs, so that it also runs from a fresh clone.

import { expect } from 'vitest';
import { EFFECT_MAP, normaliseEffectText, UNMODELLED_EFFECTS } from '../../src/battle/effectMap.js';
import { NO_DAMAGE_EFFECTS } from '../../src/battle/noDamageEffects.js';
import type { DocMove } from '../../src/docs/types.js';

/** Each list's normalised effect texts, by the list's name. */
export const EFFECT_LISTS = { EFFECT_MAP: Object.keys(EFFECT_MAP), UNMODELLED_EFFECTS: Object.keys(UNMODELLED_EFFECTS), NO_DAMAGE_EFFECTS: [...NO_DAMAGE_EFFECTS] };

/** Expects every effect text of the docs' Moves tab (`moves`, over 200 distinct texts) to be in one of the lists. */
export function expectEveryEffectClassified(moves: DocMove[]): void {
  const classified = new Set(Object.values(EFFECT_LISTS).flat());
  const texts = [...new Set(moves.map((move) => move.effectText))];
  expect(texts.length).toBeGreaterThan(200);
  expect(texts.filter((text) => !classified.has(normaliseEffectText(text)))).toEqual([]);
  // The Dig and Dive doubling texts are "no damage impact" only because no move digs or dives in the hack.
  expect(moves.filter((move) => ['Dig', 'Dive'].includes(move.name)).map((move) => move.effectText)).toEqual(['None', 'None']);
}
