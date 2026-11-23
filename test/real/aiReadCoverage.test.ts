// The coverage ledger of the read interface: over every state the differential corpus reaches
// (aiCorpus.ts, the golden file's k) and its hand-made battles (aiFixtures.ts FIXTURES), the Showdown source's read of
// each state, and for every read field the values it took: bit by bit for the masks, value by value for each counter
// packed in a mask and for every other field (Ledger). A field (or bit, or counter) that took fewer than
// two values fails, named, unless ALLOWED names it with its reason. So the view oracle
// can't pass on a corpus that never exercises a mapping. A mask bit outside the ones the read may set fails too, and so
// does an allow-list entry the corpus now covers (the list stays honest).
//
// It runs only with AI_READ_FULL=1 (`npm run test:ai-read`): a sample of the corpus would make its
// one-value rows wrong. One walk of the whole corpus in one process: about 13 minutes at load 6 to 10, so it has its own
// timeout (split across files or child processes, each part would be another process holding a corpus walk's memory,
// about 1.2 GB, beside the differential's). Every fix touching src/ai/read runs it first.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_HAILING_TEMP, FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_RAINING_TEMP,
  FIELD_CONDITION_SANDSTORM_PERM, FIELD_CONDITION_SANDSTORM_TEMP, FIELD_CONDITION_SUNNY_PERM, FIELD_CONDITION_SUNNY_TEMP,
  MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON, MON_CONDITION_TOXIC,
  MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_EFFECT_AIRBORNE, MOVE_EFFECT_AQUA_RING, MOVE_EFFECT_CHARGE, MOVE_EFFECT_EMBARGO,
  MOVE_EFFECT_GRUDGE, MOVE_EFFECT_HEAL_BLOCK, MOVE_EFFECT_IMPRISON, MOVE_EFFECT_INGRAIN, MOVE_EFFECT_LEECH_SEED,
  MOVE_EFFECT_MAGNET_RISE, MOVE_EFFECT_MINIMIZE, MOVE_EFFECT_MIRACLE_EYE, MOVE_EFFECT_MUD_SPORT, MOVE_EFFECT_PERISH_SONG,
  MOVE_EFFECT_POWER_TRICK, MOVE_EFFECT_SHADOW_FORCE, MOVE_EFFECT_UNDERGROUND, MOVE_EFFECT_UNDERWATER,
  MOVE_EFFECT_WATER_SPORT, SIDE_CONDITION_FUTURE_SIGHT, SIDE_CONDITION_LIGHT_SCREEN, SIDE_CONDITION_MIST,
  SIDE_CONDITION_REFLECT, SIDE_CONDITION_SAFEGUARD, SIDE_CONDITION_SPIKES, SIDE_CONDITION_STEALTH_ROCK,
  SIDE_CONDITION_TOXIC_SPIKES, SIDE_CONDITION_WISH, VOLATILE_CONDITION_CURSE, VOLATILE_CONDITION_DEFENSE_CURL,
  VOLATILE_CONDITION_DESTINY_BOND, VOLATILE_CONDITION_FLINCH, VOLATILE_CONDITION_FOCUS_ENERGY, VOLATILE_CONDITION_FORESIGHT,
  VOLATILE_CONDITION_MEAN_LOOK, VOLATILE_CONDITION_MOVE_LOCKED, VOLATILE_CONDITION_NIGHTMARE, VOLATILE_CONDITION_RAGE,
  VOLATILE_CONDITION_RECHARGING, VOLATILE_CONDITION_SUBSTITUTE, VOLATILE_CONDITION_TORMENT, VOLATILE_CONDITION_TRANSFORM,
} from '../../src/ai/constants.js';
import { showdownAiSource } from '../../src/ai/read/showdown.js';
import type { AiBattleRead, AiReadMon, AiReadPartyMon } from '../../src/contracts/aiRead.js';
import type { EngineState } from '../../src/contracts/engine.js';
import { type Corpus, GOLDEN_PATH, type Golden, loadCorpus, runCase } from './aiCorpus.js';
import { FIXTURES, runFixture } from './aiFixtures.js';
import { DATA_DIR, needFiles, PK_ROM } from './env.js';

const ROM_DIR = join(DATA_DIR, 'rom');

/** The walk's timeout: an hour, for a loaded machine (the project's 10 minutes is for one shard's work). */
const WALK_TIMEOUT_MS = 60 * 60_000;

/** A mask's layout: its one-bit flags, and its counters (`[name, shift, width mask]`). */
interface MaskLayout { flags: [string, number][]; counters: [string, number, number][] }

const FIELD_MASK: MaskLayout = {
  flags: [
    ['RAINING_TEMP', FIELD_CONDITION_RAINING_TEMP], ['RAINING_PERM', FIELD_CONDITION_RAINING_PERM],
    ['SANDSTORM_TEMP', FIELD_CONDITION_SANDSTORM_TEMP], ['SANDSTORM_PERM', FIELD_CONDITION_SANDSTORM_PERM],
    ['SUNNY_TEMP', FIELD_CONDITION_SUNNY_TEMP], ['SUNNY_PERM', FIELD_CONDITION_SUNNY_PERM],
    ['HAILING_TEMP', FIELD_CONDITION_HAILING_TEMP], ['HAILING_PERM', FIELD_CONDITION_HAILING_PERM],
    ['UPROAR (battler 0)', 1 << 8], ['UPROAR (battler 1)', 1 << 9],
  ],
  counters: [['GRAVITY', 12, 7], ['TRICK_ROOM', 16, 7]],
};

const SIDE_MASK: MaskLayout = {
  flags: [
    ['REFLECT', SIDE_CONDITION_REFLECT], ['LIGHT_SCREEN', SIDE_CONDITION_LIGHT_SCREEN], ['SPIKES', SIDE_CONDITION_SPIKES],
    ['SAFEGUARD', SIDE_CONDITION_SAFEGUARD], ['FUTURE_SIGHT', SIDE_CONDITION_FUTURE_SIGHT], ['WISH', SIDE_CONDITION_WISH],
    ['MIST', SIDE_CONDITION_MIST], ['STEALTH_ROCK', SIDE_CONDITION_STEALTH_ROCK], ['TOXIC_SPIKES', SIDE_CONDITION_TOXIC_SPIKES],
  ],
  counters: [['TAILWIND', 8, 3], ['LUCKY_CHANT', 12, 7]],
};

const STATUS_MASK: MaskLayout = {
  flags: [
    ['POISON', MON_CONDITION_POISON], ['BURN', MON_CONDITION_BURN], ['FREEZE', MON_CONDITION_FREEZE],
    ['PARALYSIS', MON_CONDITION_PARALYSIS], ['TOXIC', MON_CONDITION_TOXIC],
  ],
  counters: [['SLEEP', 0, 7], ['TOXIC_COUNTER', 8, 15]],
};

const VOLATILE_MASK: MaskLayout = {
  flags: [
    ['FLINCH', VOLATILE_CONDITION_FLINCH], ['MOVE_LOCKED', VOLATILE_CONDITION_MOVE_LOCKED],
    ['ATTRACT (to battler 0)', 1 << 16], ['ATTRACT (to battler 1)', 1 << 17],
    ['FOCUS_ENERGY', VOLATILE_CONDITION_FOCUS_ENERGY], ['TRANSFORM', VOLATILE_CONDITION_TRANSFORM],
    ['RECHARGING', VOLATILE_CONDITION_RECHARGING], ['RAGE', VOLATILE_CONDITION_RAGE], ['SUBSTITUTE', VOLATILE_CONDITION_SUBSTITUTE],
    ['DESTINY_BOND', VOLATILE_CONDITION_DESTINY_BOND], ['MEAN_LOOK', VOLATILE_CONDITION_MEAN_LOOK],
    ['NIGHTMARE', VOLATILE_CONDITION_NIGHTMARE], ['CURSE', VOLATILE_CONDITION_CURSE], ['FORESIGHT', VOLATILE_CONDITION_FORESIGHT],
    ['DEFENSE_CURL', VOLATILE_CONDITION_DEFENSE_CURL], ['TORMENT', VOLATILE_CONDITION_TORMENT],
  ],
  counters: [['CONFUSION', 0, 7], ['UPROAR', 4, 7], ['BIDE', 8, 3], ['THRASH', 10, 3], ['BIND', 13, 7]],
};

/** MOVE_EFFECT_*, but IMPRISONED (the composer's), NO_CRITICAL and CAMOUFLAGE (never set): a read must never hold those. */
const MOVE_EFFECT_MASK: MaskLayout = {
  flags: [
    ['LEECH_SEED', MOVE_EFFECT_LEECH_SEED], ['PERISH_SONG', MOVE_EFFECT_PERISH_SONG], ['AIRBORNE', MOVE_EFFECT_AIRBORNE],
    ['UNDERGROUND', MOVE_EFFECT_UNDERGROUND], ['MINIMIZE', MOVE_EFFECT_MINIMIZE], ['CHARGE', MOVE_EFFECT_CHARGE],
    ['INGRAIN', MOVE_EFFECT_INGRAIN], ['IMPRISON', MOVE_EFFECT_IMPRISON], ['GRUDGE', MOVE_EFFECT_GRUDGE],
    ['MUD_SPORT', MOVE_EFFECT_MUD_SPORT], ['WATER_SPORT', MOVE_EFFECT_WATER_SPORT], ['UNDERWATER', MOVE_EFFECT_UNDERWATER],
    ['ABILITY_SUPPRESSED', MOVE_EFFECT_ABILITY_SUPPRESSED], ['MIRACLE_EYE', MOVE_EFFECT_MIRACLE_EYE],
    ['POWER_TRICK', MOVE_EFFECT_POWER_TRICK], ['AQUA_RING', MOVE_EFFECT_AQUA_RING], ['HEAL_BLOCK', MOVE_EFFECT_HEAL_BLOCK],
    ['EMBARGO', MOVE_EFFECT_EMBARGO], ['MAGNET_RISE', MOVE_EFFECT_MAGNET_RISE], ['SHADOW_FORCE', MOVE_EFFECT_SHADOW_FORCE],
  ],
  counters: [['LEECH_SEED_RECIPIENT', 0, 3], ['LOCK_ON', 3, 3], ['YAWN', 11, 3]],
};

/** The bits a layout names. */
function known(layout: MaskLayout): number {
  let bits = 0;
  for (const [, bit] of layout.flags) bits |= bit;
  for (const [, shift, width] of layout.counters) bits |= width << shift;
  return bits;
}

/**
 * The values each row took (as JSON). A row is a read field, counted over both battlers and both sides (the contract's
 * fields), or one bit or counter of a mask, or a field narrowed to where its mapping shows (a
 * fainted battler's status; Leech Seed's recipient while seeded; each stat stage by its index). Five booleans also
 * get a row per battler (`roosting`, `transformed`, `protectChainKnown`, `effects.flashFire`,
 * `effects.canUnburden`), so one that is fixed for each battler, but differently, still fails.
 */
class Ledger {
  readonly rows = new Map<string, Set<string>>();
  readonly strays: string[] = [];
  readonly refused = new Map<string, number>();
  states = 0;

  see(row: string, value: unknown): void {
    let values = this.rows.get(row);
    if (values === undefined) {
      values = new Set();
      this.rows.set(row, values);
    }
    values.add(JSON.stringify(value));
  }

  each(row: string, values: readonly unknown[]): void {
    for (const value of values) this.see(row, value);
  }

  mask(row: string, mask: number, layout: MaskLayout): void {
    for (const [name, bit] of layout.flags) this.see(`${row} ${name}`, (mask & bit) !== 0);
    for (const [name, shift, width] of layout.counters) this.see(`${row} ${name}`, (mask >>> shift) & width);
    const stray = (mask & ~known(layout)) >>> 0;
    if (stray !== 0 && this.strays.length < 20) this.strays.push(`${row}: 0x${(mask >>> 0).toString(16)} holds 0x${stray.toString(16)}`);
  }

  mon(mon: AiReadMon, battler: number): void {
    const row = (name: string): string => `mons.${name}`;
    for (const [name, value] of [
      ['roosting', mon.roosting], ['transformed', mon.transformed], ['protectChainKnown', mon.protectChainKnown],
      ['effects.flashFire', mon.effects.flashFire], ['effects.canUnburden', mon.effects.canUnburden],
    ] as const) {
      this.see(row(`${name} (battler ${battler})`), value);
    }
    for (const name of ['partyIndex', 'species', 'form', 'level', 'gender', 'ability', 'heldItem', 'friendship', 'curHP', 'maxHP',
      'attack', 'defense', 'spAttack', 'spDefense', 'speed', 'roosting', 'helpingHand', 'transformed', 'weightSpecies', 'weightForm',
      'moveProtect', 'protectChainKnown', 'lastItem'] as const) {
      this.see(row(name), mon[name]);
    }
    this.see(row('types'), mon.types);
    this.see(row('ivs'), mon.ivs);
    mon.statBoosts.forEach((stage, i) => this.see(row(`statBoosts[${i}]`), stage));
    this.each(row('moves'), mon.moves);
    this.each(row('ppCur'), mon.ppCur);
    this.each(row('ppMax'), mon.ppMax);
    this.mask(row('status'), mon.status, STATUS_MASK);
    if (mon.curHP === 0) this.see(row('status (fainted, non-zero)'), mon.status !== 0);
    this.mask(row('statusVolatile'), mon.statusVolatile, VOLATILE_MASK);
    this.mask(row('moveEffectsMask'), mon.moveEffectsMask, MOVE_EFFECT_MASK);
    if ((mon.moveEffectsMask & MOVE_EFFECT_LEECH_SEED) !== 0) this.see(row('moveEffectsMask LEECH_SEED_RECIPIENT (seeded)'), mon.moveEffectsMask & 3);
    for (const [name, value] of Object.entries(mon.effects)) this.see(row(`effects.${name}`), value);
  }

  member(member: AiReadPartyMon): void {
    const row = (name: string): string => `parties.${name}`;
    for (const name of ['species', 'form', 'level', 'hp', 'maxHp', 'heldItem', 'ability'] as const) this.see(row(name), member[name]);
    this.see(row('ivs'), member.ivs);
    this.each(row('moves'), member.moves);
    this.each(row('pp'), member.pp);
    this.each(row('ppMax'), member.ppMax);
    this.mask(row('status'), member.status, STATUS_MASK);
  }

  read(read: AiBattleRead): void {
    this.states++;
    this.see('battleType', read.battleType);
    this.see('totalTurns', read.totalTurns);
    this.mask('fieldConditionsMask', read.fieldConditionsMask, FIELD_MASK);
    for (const side of [0, 1] as const) {
      this.mask('sideConditionsMask', read.sideConditionsMask[side], SIDE_MASK);
      this.see('sideConditions.spikesLayers', read.sideConditions[side].spikesLayers);
      this.see('sideConditions.toxicSpikesLayers', read.sideConditions[side].toxicSpikesLayers);
    }
    this.each('monSpeedValues', read.monSpeedValues);
    this.each('quickClawRolls', read.quickClawRolls);
    this.see('bag', read.bag);
    this.see('queuedPlayerMoves', read.queuedPlayerMoves);
    this.see('request', read.request === null ? 'none' : 'some');
    if (read.request !== null) {
      this.each('request.entries[].id', read.request.entries.map((entry) => entry.id));
      this.each('request.entries[].usable', read.request.entries.map((entry) => entry.usable));
      this.each('request.slotIds', read.request.slotIds);
    }
    this.see('trainer.romIndex', read.trainer.romIndex);
    this.see('trainer.aiMask', read.trainer.aiMask);
    this.see('fieldNote', read.fieldNote);
    read.mons.forEach((mon, battler) => this.mon(mon, battler));
    for (const party of read.parties) for (const member of party) this.member(member);
  }

  /** The read of `state`, seen; a read that throws is counted by its message. */
  visit(state: EngineState): void {
    let read: AiBattleRead;
    try {
      read = showdownAiSource.read(state);
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error);
      this.refused.set(what, (this.refused.get(what) ?? 0) + 1);
      return;
    }
    this.read(read);
  }
}

/**
 * The rows the corpus cannot give two values, each with why, in three kinds:
 * - UNREACHABLE: singles or the hack's data never set it on this engine (an effect no hack move has: the move effects are
 *   the ROM's, read by name from the decompilation's generated/move_battle_effects.txt);
 * - REFUSED: only a move the engine refuses sets it (aiFixtures.ts REFUSED), named;
 * - THIN: reachable on this engine, but no corpus state has it: the fixture (aiFixtures.ts) that would.
 */
const ALLOWED: Record<string, string> = {
  'battleType': 'UNREACHABLE: the engine runs singles trainer battles only (createBattle throws UNSUPPORTED_DOUBLE)',
  'mons.helpingHand': 'UNREACHABLE: Helping Hand fails in singles',
  'mons.statBoosts[0]': 'UNREACHABLE: HP has no stat stage; the read holds the neutral 6 there',
  'mons.statusVolatile RECHARGING': "UNREACHABLE: no hack move has BATTLE_EFFECT_RECHARGE_AFTER (the hack's Hyper Beam and Giga Impact are RECOIL_QUARTER)",
  'mons.statusVolatile RAGE': "UNREACHABLE: no hack move has BATTLE_EFFECT_RAISE_ATK_WHEN_HIT (the hack's Rage, move 99, has Pursuit's HIT_BEFORE_SWITCH)",
  'mons.statusVolatile NIGHTMARE': 'UNREACHABLE: no hack move has BATTLE_EFFECT_STATUS_NIGHTMARE (the hack has no Nightmare)',
  'mons.statusVolatile DEFENSE_CURL': 'UNREACHABLE: no hack move has BATTLE_EFFECT_DEF_UP_DOUBLE_ROLLOUT_POWER (the hack has no Defense Curl)',
  'mons.statusVolatile BIDE': "UNREACHABLE: no hack move has BATTLE_EFFECT_BIDE (the hack's Bide, move 117, has METAL_BURST)",
  'mons.statusVolatile THRASH': 'UNREACHABLE: no hack move has BATTLE_EFFECT_CONTINUE_AND_CONFUSE_SELF (Thrash, Petal Dance and Outrage '
    + "don't lock in the hack; fixture outrage-no-lock)",
  'mons.moveEffectsMask UNDERGROUND': 'UNREACHABLE: no hack move has BATTLE_EFFECT_DIG (Dig is a one-turn move in the hack)',
  'mons.moveEffectsMask UNDERWATER': 'UNREACHABLE: no hack move has BATTLE_EFFECT_DIVE (Dive is a one-turn move in the hack)',
  'mons.moveEffectsMask MUD_SPORT': 'UNREACHABLE: no hack move has BATTLE_EFFECT_HALVE_ELECTRIC_DAMAGE (the hack has no Mud Sport)',
  'mons.moveEffectsMask WATER_SPORT': 'UNREACHABLE: no hack move has BATTLE_EFFECT_HALVE_FIRE_DAMAGE (the hack has no Water Sport)',
  'mons.moveEffectsMask HEAL_BLOCK': 'UNREACHABLE: no hack move has BATTLE_EFFECT_PREVENT_HEALING (the hack has no Heal Block)',
  'mons.effects.healBlockTurns': 'UNREACHABLE: no hack move has BATTLE_EFFECT_PREVENT_HEALING (the hack has no Heal Block)',
  'mons.moveEffectsMask YAWN': "UNREACHABLE: no hack move has BATTLE_EFFECT_STATUS_SLEEP_NEXT_TURN (the hack's Yawn, move 281, sleeps at once: STATUS_SLEEP)",
  'mons.effects.tauntedTurns': 'UNREACHABLE: no hack move has BATTLE_EFFECT_TAUNT (move 269 is Hidden Power Dark in the hack)',
  'mons.effects.stockpileCount': "UNREACHABLE: no hack move has BATTLE_EFFECT_STOCKPILE (the hack's Stockpile, move 254, is DEF_SPD_UP; "
    + 'fixture stockpile-2 leaves no counter)',
  'mons.moveEffectsMask AIRBORNE': 'REFUSED: only Fly has BATTLE_EFFECT_FLY in the hack, and the engine refuses it (REFUSED fixture '
    + 'twoturn-ai-fly); Bounce is a one-turn move in the hack',
  'mons.moveEffectsMask CHARGE': 'REFUSED: only Charge (move 268) sets it, and the engine refuses Charge (unmodelledIn); a fixture of it '
    + 'would join REFUSED',
  'fieldConditionsMask UPROAR (battler 0)': "THIN: the player's Uproar: a fixture uproar-player (uproar-ai covers battler 1)",
  'mons.roosting': "THIN: Roost's flag lasts the turn, so only a mid-turn decision sees it: a fixture roost-player-uturn (the player "
    + 'Roosts first, then the AI U-turns)',
  'mons.statusVolatile FLINCH': "THIN: a flinch lasts the turn and a flinched battler doesn't act, so only a U-turn that flinches (King's "
    + 'Rock or Razor Fang) leaves one at a decision (the mid-turn switch); the flinch is silent in the log until the flinched battler '
    + "would move, so that fixture must pick the step's outcome by its state",
  'mons.statusVolatile FOCUS_ENERGY': 'THIN: a fixture focusenergy-ai (Focus Energy, move 116)',
  'mons.statusVolatile FORESIGHT': 'THIN: a fixture foresight-player (Foresight, move 193, or Odor Sleuth, 316)',
  'mons.moveEffectsMask GRUDGE': 'THIN: a fixture grudge-ai (Grudge, move 288)',
  'mons.moveEffectsMask MIRACLE_EYE': 'THIN: a fixture miracleeye-player (Miracle Eye, move 357)',
  'mons.moveEffectsMask POWER_TRICK': 'THIN: a fixture powertrick-ai (Power Trick, move 379)',
  'mons.moveEffectsMask LOCK_ON': 'THIN: a fixture lockon-ai (Lock-On, move 199, or Mind Reader, 170)',
  'mons.effects.flashFire': "THIN: a fixture flashfire-ai (a Fire move into the AI's Flash Fire holder)",
  // The per-battler rows.
  'mons.roosting (battler 0)': 'THIN: as mons.roosting: a fixture roost-player-uturn',
  'mons.roosting (battler 1)': "THIN: the AI Roosts first, then the player U-turns (the player's mid-turn switch, which the corpus "
    + 'visits): a fixture roost-ai-uturn',
  'mons.transformed (battler 0)': "REFUSED: no corpus player knows Transform, and the engine refuses it (REFUSED fixture transform is "
    + "the AI's; a player's would be refused the same way)",
  'mons.protectChainKnown (battler 0)': "THIN: the player's chain is ambiguous only after its Sleep Talk calls Protect (the player uses no "
    + 'bag item): a fixture sleeptalk-protect-player',
  'mons.effects.flashFire (battler 0)': "THIN: a fixture flashfire-player (the AI's Fire move into the player's Flash Fire holder)",
  'mons.effects.flashFire (battler 1)': 'THIN: as mons.effects.flashFire: a fixture flashfire-ai',
  'mons.effects.canUnburden (battler 0)': "THIN: no corpus player has Unburden: a fixture unburden-player (the player's Unburden holder "
    + 'loses its item)',
};

const suite = needFiles("the read interface's coverage ledger", { PK_ROM, GOLDEN: GOLDEN_PATH }, [{
  name: 'ROM extract', dir: ROM_DIR,
  skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
    ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
}]);

/** The whole corpus only: `npm run test:ai-read` sets AI_READ_FULL=1. */
const FULL = process.env['AI_READ_FULL'] === '1';
const NOT_FULL = 'the whole corpus only, with AI_READ_FULL=1: run npm run test:ai-read';
if (!FULL && !suite.skip) console.warn(`Skipping "${suite.title}": ${NOT_FULL}`);

describe.skipIf(suite.skip || !FULL)(FULL || suite.skip ? suite.title : `${suite.title} (skipped: ${NOT_FULL})`, () => {
  it('sees every read field take two values, every mask bit set, over the corpus and the fixtures', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    const start = performance.now();
    const corpus: Corpus = loadCorpus(DATA_DIR, golden.k);
    const ledger = new Ledger();
    for (const c of corpus.cases) runCase(corpus, c, new Map(), (_key, state) => ledger.visit(state));
    for (const fixture of FIXTURES) runFixture(corpus, fixture, new Map(), (_key, state) => ledger.visit(state));
    const seconds = (performance.now() - start) / 1000;

    const thin = [...ledger.rows].filter(([, values]) => values.size < 2);
    const failing = thin.filter(([row]) => ALLOWED[row] === undefined);
    const stale = Object.keys(ALLOWED).filter((row) => (ledger.rows.get(row)?.size ?? 0) !== 1);
    console.log(`Read coverage: ${ledger.states} states read (${corpus.cases.length} cases, ${FIXTURES.length} fixtures) in ${seconds.toFixed(1)} s; `
      + `${ledger.rows.size} rows, ${thin.length} with one value (${thin.length - failing.length} allowed); `
      + `refused reads ${JSON.stringify(Object.fromEntries(ledger.refused))}`);
    const shown = thin.map(([row, values]) => `  ${row}: ${[...values].join(' ')}${ALLOWED[row] === undefined ? '' : ` (allowed: ${ALLOWED[row]})`}`);
    console.log(`Rows with one value:\n${shown.join('\n')}`);
    expect(failing.map(([row, values]) => `${row}: only ${[...values].join(' ')}`)).toEqual([]);
    expect(stale, 'allow-list entries the corpus covers, or no longer has').toEqual([]);
    expect(ledger.strays).toEqual([]);
    expect(ledger.states).toBeGreaterThan(10_000);
  }, WALK_TIMEOUT_MS);
});
