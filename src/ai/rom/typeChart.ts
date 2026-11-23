// The type chart the battle reads, sTypeMatchupMultipliers (battle_lib.c:2399), found in the hack's overlay 16.

import { RomError } from '../../errors.js';
import { readOverlay } from '../../nds/overlay.js';
import { findBytes } from './items.js';

/**
 * Triples [attacking type, defending type, multiplier × 10], in the cartridge's order. The [0xFE, 0xFE, 0] triple stays:
 * the Ghost immunities after it are skipped under Foresight or Scrappy (battle_lib.c:2613). The 0xFF terminator is dropped.
 */
export type TypeChart = readonly (readonly [number, number, number])[];

/** The battle overlay, which holds battle_lib.c. */
const BATTLE_OVERLAY = 16;
const TERMINATOR = 0xff;

// Gen 4 type IDs (generated/pokemon_types.txt) and multipliers (constants/battle.h:144–146).
const TYPE_NORMAL = 0;
const TYPE_ROCK = 5;
const TYPE_BUG = 6;
const TYPE_STEEL = 8;
const TYPE_FIRE = 10;
const TYPE_WATER = 11;
const TYPE_GRASS = 12;
const TYPE_ICE = 15;
const TYPE_MULTI_NOT_VERY_EFF = 5;
const TYPE_MULTI_SUPER_EFF = 20;

/** Vanilla's first eight triples (battle_lib.c:2400–2407), the pattern the chart is found by. */
const VANILLA_HEAD = [
  TYPE_NORMAL, TYPE_ROCK, TYPE_MULTI_NOT_VERY_EFF,
  TYPE_NORMAL, TYPE_STEEL, TYPE_MULTI_NOT_VERY_EFF,
  TYPE_FIRE, TYPE_FIRE, TYPE_MULTI_NOT_VERY_EFF,
  TYPE_FIRE, TYPE_WATER, TYPE_MULTI_NOT_VERY_EFF,
  TYPE_FIRE, TYPE_GRASS, TYPE_MULTI_SUPER_EFF,
  TYPE_FIRE, TYPE_ICE, TYPE_MULTI_SUPER_EFF,
  TYPE_FIRE, TYPE_BUG, TYPE_MULTI_SUPER_EFF,
  TYPE_FIRE, TYPE_ROCK, TYPE_MULTI_NOT_VERY_EFF,
];

/** The ROM's type chart, in overlay 16. RomError('BAD_FORMAT') unless vanilla's first eight triples occur there exactly once. */
export function extractTypeChart(rom: Uint8Array): TypeChart {
  const overlay = readOverlay(rom, BATTLE_OVERLAY);
  const hits = findBytes(overlay, VANILLA_HEAD);
  if (hits.length !== 1) {
    const where = hits.map((offset) => `0x${offset.toString(16)}`).join(', ');
    throw new RomError('BAD_FORMAT', `expected one type chart in overlay ${BATTLE_OVERLAY}, found ${hits.length}${where ? ` (at ${where})` : ''}`);
  }
  return decodeTypeChart(overlay, hits[0]!);
}

/**
 * The triples from `start` up to the first whose attacking type is 0xFF, where the battle's loop stops
 * (battle_lib.c:2612); the 0xFE separator is kept. RomError('BAD_FORMAT') if the bytes end first.
 */
export function decodeTypeChart(bytes: Uint8Array, start = 0): TypeChart {
  const chart: (readonly [number, number, number])[] = [];
  for (let at = start; at < bytes.length; at += 3) {
    if (bytes[at] === TERMINATOR) return chart;
    if (at + 3 > bytes.length) break;
    chart.push([bytes[at]!, bytes[at + 1]!, bytes[at + 2]!]);
  }
  throw new RomError('BAD_FORMAT', `the type chart at 0x${start.toString(16)} has no 0x${TERMINATOR.toString(16)} terminator`);
}
