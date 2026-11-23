// The engine's move behaviours, table-driven from the docs' effect texts (src/engine/effects.ts), run through `expandTurn`
// on the fixture's own moves, several of them moves whose docs text is not their Showdown namesake's behaviour.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it } from 'vitest';
import { normaliseEffectText } from '../../../src/battle/effectMap.js';
import { buildMoves, type KaizoMove } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { loadLocalData } from '../../../src/data/load.js';
import { parseMovesTab } from '../../../src/docs/tables.js';
import { createBattle, legalChoices, restore, snapshot } from '../../../src/engine/battle.js';
import { installedMoves, installKaizoDex, KAIZO_MOD, moveId, showdownMoveData } from '../../../src/engine/dex.js';
import { ENGINE_EFFECTS, engineEffect, type EngineEffect } from '../../../src/engine/effects.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/index.js';
import { belowWeight, residueWeights } from '../../../src/engine/odds.js';
import { add, mul, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { EFFECT_LISTS } from '../../fixtures/effectClassification.js';
import { ABILITY, BAG, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const { Dex } = PS;
const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const U16 = 65536n;
const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const draws = (weight: bigint | number): Rational => rat(BigInt(weight), U16);
const entry = (text: string): EngineEffect | undefined => ENGINE_EFFECTS[normaliseEffectText(text)];
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational =>
  outcomes.filter(test).reduce((total, outcome) => add(total, outcome.probability), ZERO);
const labels = (outcomes: Outcome[]) => outcomes.flatMap((outcome) => outcome.labels);
const hasEffectLabel = (outcomes: Outcome[]) => labels(outcomes).some((label) => label.kind === 'effect');
const foe = (outcome: Outcome) => restore(outcome.state).p2.active[0]!;
const mine = (outcome: Outcome) => restore(outcome.state).p1.active[0]!;
const idOf = (id: number) => moveId(installedMoves().get(id)!);

/** One turn of the player's `mineMon` against the trainer's `theirs`. */
const turn = (mineMon: PlayerMon, theirs: ResolvedMon, enemyAbility?: number, choices = BOTH_FIRST) => expandTurn(createBattle(duel(mineMon, theirs, enemyAbility)), choices);
const duel = (mineMon: PlayerMon, theirs: ResolvedMon, enemyAbility?: number): BattleInput => ({
  player: [mineMon], trainer: resolvedTrainer(BAG.none, [theirs]), field: {},
  ...(enemyAbility === undefined ? {} : { world: { enemy: [{ ability: enemyAbility }] } }),
});

// A weak attacker on a bulky Battle Armor target: no crit, few damage values. Monferno (Speed 62) outspeeds Zigzagoon
// (35) and Bidoof (53), but Zigzagoon's Mean Look has priority +1.
const weak = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.zigzagoon, 5, moves, fields);
const deoxys = (moves: number[] = [ID.meanLook], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.deoxys, 50, moves, fields);
const monferno = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, moves, fields);
const zigzagoon = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 20, moves, fields);
const bidoof = (moves: number[]) => resolvedMon(ID.bidoof, 20, moves);
const armored = { ability: knownAbility(ABILITY.battleArmor) };
const BA = ABILITY.battleArmor;

describe('ENGINE_EFFECTS', () => {
  it('every effect text of the classification lists has an engine entry, and every entry is one of their texts, normalised', () => {
    const texts = Object.values(EFFECT_LISTS).flat();
    expect(texts.filter((text) => entry(text) === undefined)).toEqual([]);
    expect(Object.keys(ENGINE_EFFECTS).filter((key) => !texts.includes(key) || key !== normaliseEffectText(key))).toEqual([]);
  });

  // The docs CSVs are local only (gitignored), so this runs where `npm run extract` saved them.
  const movesCsv = join(process.env.DATA_DIR || 'data', 'docs', 'Moves.csv');
  it.skipIf(!existsSync(movesCsv))(`every docs effect has an engine entry (${movesCsv})`, () => {
    const texts = [...new Set(parseMovesTab(readFileSync(movesCsv, 'utf8')).map((row) => row.effectText))];
    expect(texts.length).toBeGreaterThan(200);
    expect(texts.filter((text) => entry(text) === undefined)).toEqual([]);
  });

  it('the table entries of the regular families', () => {
    expect(Object.fromEntries([
      'Chance of causing Burn; 1/3 damage dealt recoil', 'Chance to Burn', 'Raises Atk', 'Chance of raising Atk', 'Lowers Def (Status)',
      'Lowers Def (Attack)', 'Causes Sleep', 'Restores up to 50% max HP', 'Chance to Flinch', 'Chance to Confuse', 'Guaranteed Confusion (Status)',
      'Lowers user\'s Spd', 'Chance of causing Burn; chance of causing Flinch', 'Sharply raises target\'s Atk and causes Confusion',
      'Sharply raises crit ratio', 'Struggle effect',
    ].map((text) => [text, entry(text)]))).toEqual({
      'Chance of causing Burn; 1/3 damage dealt recoil': { kind: 'secondary', status: 'brn' },
      'Chance to Burn': { kind: 'secondary', status: 'brn' },
      'Raises Atk': { kind: 'status', target: 'self', boosts: { atk: 1 } },
      'Chance of raising Atk': { kind: 'secondary', boosts: { atk: 1 }, self: true },
      'Lowers Def (Status)': { kind: 'status', target: 'foe', boosts: { def: -1 } },
      'Lowers Def (Attack)': { kind: 'secondary', boosts: { def: -1 } },
      'Causes Sleep': { kind: 'status', target: 'foe', status: 'slp' },
      'Restores up to 50% max HP': { kind: 'heal', fraction: [1, 2] },
      'Chance to Flinch': { kind: 'secondary', volatile: 'flinch' },
      'Chance to Confuse': { kind: 'secondary', volatile: 'confusion' },
      'Guaranteed Confusion (Status)': { kind: 'status', target: 'foe', volatile: 'confusion' },
      'Lowers user\'s Spd': { kind: 'secondary', boosts: { spe: -1 }, self: true, chance: 100 }, // sure: MOVE_SIDE_EFFECT_ON_HIT
      'Chance of causing Burn; chance of causing Flinch': { kind: 'secondary', status: 'brn', volatile: 'flinch' },
      'Sharply raises target\'s Atk and causes Confusion': { kind: 'status', target: 'foe', boosts: { atk: 2 }, volatile: 'confusion' },
      'Sharply raises crit ratio': { kind: 'status', target: 'self', volatile: 'focusenergy' },
      'Struggle effect': { kind: 'inherit', from: 'struggle' },
    });
  });

  it('a text with no entry, or a status-move entry on a damaging move, is unmodelled', () => {
    const tackle = installedMoves().get(ID.tackle)!;
    for (const kaizo of [{ ...tackle, effectText: 'Power doubles under the full moon' }, { ...tackle, effectText: 'Raises Atk' },
      { ...installedMoves().get(ID.howl)!, effectText: 'Chance to Burn' }]) expect(engineEffect(kaizo)).toMatchObject({ kind: 'unmodelled' });
    expect(engineEffect(tackle)).toEqual({ kind: 'plain' });
  });

  it('a ROM effect chance of 0 leaves the move with none; a chance of 100 is a sure move-level self boost', () => {
    const claw = installedMoves().get(ID.crushClaw)!;
    expect(showdownMoveData({ ...claw, effectChance: 0 })).not.toHaveProperty('secondaries');
    expect(showdownMoveData(claw)).toMatchObject({ secondaries: [{ chance: 50, boosts: { def: -1 } }] });
    const beam = showdownMoveData(installedMoves().get(ID.chargeBeam)!);
    expect(beam).toMatchObject({ self: { boosts: { spa: 1 } } });
    expect(beam).not.toHaveProperty('secondaries');
  });
});

describe('the regular families through expandTurn', () => {
  // r % 100 < N: 655 x N + N of the 65,536 draws.
  it.each<{ name: string; outcomes: () => Outcome[]; hit: (outcome: Outcome) => boolean; chance: () => Rational; label?: object }>([
    { name: 'a 10% burn: Overheat (its base Swift never burns)', outcomes: () => turn(weak([ID.overheat]), deoxys(), BA), hit: (o) => foe(o).status === 'brn',
      chance: () => draws(6560), label: { kind: 'effect', side: 'p1', source: 'overheat', outcome: 'brn' } },
    { name: 'a 10% burn: Ember', outcomes: () => turn(weak([ID.ember]), deoxys(), BA), hit: (o) => foe(o).status === 'brn',
      chance: () => draws(6560), label: { kind: 'effect', side: 'p1', source: 'ember', outcome: 'brn' } },
    { name: '+1 user Attack 10% of the time: Metal Claw', outcomes: () => turn(weak([ID.metalClaw]), deoxys(), BA), hit: (o) => mine(o).boosts.atk === 1,
      chance: () => draws(6560), label: { kind: 'effect', side: 'p1', source: 'metalclaw', outcome: 'self:atk+1' } },
    { name: '-1 target Defense on a hit and its 50%: Crush Claw', outcomes: () => turn(weak([ID.crushClaw]), deoxys(), BA), hit: (o) => foe(o).boosts.def === -1,
      chance: () => mul(draws(belowWeight(100, 95)), draws(belowWeight(100, 50))), label: { kind: 'effect', side: 'p1', source: 'crushclaw', outcome: 'def-1' } },
    { name: 'confusion 20% of the time: Water Pulse (its base Swift never confuses)', outcomes: () => turn(weak([ID.waterPulse]), deoxys(), BA),
      hit: (o) => 'confusion' in foe(o).volatiles, chance: () => draws(13120), label: { kind: 'effect', side: 'p1', source: 'waterpulse', outcome: 'confusion' } },
    { name: 'a flinch 30% of the time when moving first: Bite on the slower Bidoof', outcomes: () => turn(monferno([ID.bite], armored), bidoof([ID.tackle]), BA),
      hit: (o) => o.log.includes('|cant|p2a: Bidoof|flinch'), chance: () => draws(19680) },
    { name: 'a sure +1 Attack with no draw: Howl', outcomes: () => turn(weak([ID.howl]), deoxys()), hit: (o) => mine(o).boosts.atk === 1 && foe(o).boosts.atk === 0, chance: () => rat(1, 1) },
    { name: 'a sure -1 Defense with no draw: Leer', outcomes: () => turn(weak([ID.leer]), deoxys()), hit: (o) => foe(o).boosts.def === -1, chance: () => rat(1, 1) },
    { name: 'the docs\' stat wins over the namesake\'s: Fake Tears sharply lowers Speed', outcomes: () => turn(weak([ID.fakeTears]), deoxys()),
      hit: (o) => JSON.stringify(foe(o).boosts) === JSON.stringify({ atk: 0, def: 0, spa: 0, spd: 0, spe: -2, accuracy: 0, evasion: 0 }), chance: () => rat(1, 1) },
    { name: 'a sure confusion: Confuse Ray', outcomes: () => turn(monferno([ID.confuseRay]), zigzagoon([ID.growl])), hit: (o) => 'confusion' in foe(o).volatiles, chance: () => rat(1, 1) },
    // Hammer Arm's ROM effect chance is 0, but its drop is sure (effect_script_0218.s).
    { name: 'a sure self drop with no draw: Hammer Arm', outcomes: () => turn(weak([ID.hammerArm]), deoxys(), BA), hit: (o) => mine(o).boosts.spe === -1, chance: () => rat(1, 1) },
    { name: 'a sure self boost with no draw: Charge Beam (ROM chance 100)', outcomes: () => turn(weak([ID.chargeBeam]), deoxys(), BA), hit: (o) => mine(o).boosts.spa === 1, chance: () => rat(1, 1) },
  ])('$name', ({ outcomes, hit, chance, label }) => {
    const all = outcomes();
    expect(chanceOf(all, hit)).toEqual(chance());
    expect(all.every((outcome) => !outcome.unlabelled)).toBe(true);
    if (label) expect(labels(all)).toContainEqual(label);
    else if (chance().num === chance().den) expect(hasEffectLabel(all)).toBe(false);
  });

  it('Overheat\'s 1/3 recoil: a third of the damage dealt, at least 1 (unburned outcomes only: a burn adds its own chip)', () => {
    const start = createBattle(duel(weak([ID.overheat]), deoxys(), BA));
    const [maxhp, foeHp] = [restore(start).p1.active[0]!.maxhp, restore(start).p2.active[0]!.hp];
    const unburned = expandTurn(start, BOTH_FIRST).filter((outcome) => foe(outcome).status === '');
    expect(unburned.length).toBeGreaterThan(0);
    for (const outcome of unburned) expect(maxhp - mine(outcome).hp).toBe(Math.max(1, Math.floor((foeHp - foe(outcome).hp) / 3)));
  });

  it('Howl, Leer and Swagger are one outcome with no chance point; Swagger gives +2 Attack and confusion', () => {
    for (const outcomes of [turn(weak([ID.howl]), deoxys()), turn(weak([ID.leer]), deoxys())]) expect([outcomes.length, labels(outcomes)]).toEqual([1, []]);
    const swagger = turn(monferno([ID.swagger]), zigzagoon([ID.meanLook])); // Mean Look first: no confused attempt this turn
    expect([swagger.length, labels(swagger), foe(swagger[0]!).boosts.atk, 'confusion' in foe(swagger[0]!).volatiles]).toEqual([1, [], 2, true]);
  });

  it('a sleep move: the hit is the chance point and no counter is drawn (the wake hazards: counters.test.ts)', () => {
    // The hack's Yawn is "Causes Sleep" (70% accurate), not Showdown's drowsiness.
    const outcomes = turn(monferno([ID.yawn, ID.growl]), zigzagoon([ID.meanLook]));
    expect(chanceOf(outcomes, (outcome) => foe(outcome).status === 'slp')).toEqual(draws(belowWeight(100, 70)));
    expect(labels(outcomes).map((label) => `${label.kind}:${label.source}:${label.outcome}`).sort()).toEqual(['hit:yawn:hit', 'hit:yawn:miss']);
  });

  it('Lunar Dance heals half the max HP, rounded down, and its user stays in (Showdown\'s faints its user)', () => {
    const start = createBattle(duel(monferno([ID.lunarDance]), zigzagoon([ID.growl])));
    const hurt = (() => { const battle = restore(start); battle.p1.active[0]!.hp = 20; return snapshot(battle); })();
    const outcomes = expandTurn(hurt, BOTH_FIRST);
    expect([outcomes.length, mine(outcomes[0]!).hp, outcomes[0]!.state.phase.kind]).toEqual([1, 20 + Math.floor(restore(start).p1.active[0]!.maxhp / 2), 'turnChoice']);
  });

  it('a flinch only when moving first: the flinched Bidoof never moves; a second-moving Bite flinches no one, now or next turn', () => {
    for (const outcome of turn(monferno([ID.bite], armored), bidoof([ID.tackle]), BA)) {
      expect(outcome.log.some((line) => line.startsWith('|move|p2a: Bidoof|Tackle|'))).toBe(!outcome.log.includes('|cant|p2a: Bidoof|flinch'));
    }
    for (const outcome of turn(monferno([ID.growl], armored), bidoof([ID.bite]), BA)) {
      expect(outcome.log.some((line) => line.startsWith('|cant|p1a: Monferno|'))).toBe(false);
      expect(mine(outcome).volatiles).not.toHaveProperty('flinch');
    }
  });

  it('two effects at one chance (Fire Fang): the burn and the flinch are independent draws, each 6560 of 65,536', () => {
    const outcomes = turn(monferno([ID.fireFang], armored), bidoof([ID.tackle]), BA);
    const burned = (outcome: Outcome) => foe(outcome).status === 'brn';
    const flinched = (outcome: Outcome) => outcome.log.includes('|cant|p2a: Bidoof|flinch');
    const [yes, no] = [belowWeight(100, 10), U16 - belowWeight(100, 10)];
    expect([[true, true], [true, false], [false, true], [false, false]].map(([b, f]) => chanceOf(outcomes, (o) => burned(o) === b && flinched(o) === f)))
      .toEqual([[yes, yes], [yes, no], [no, yes], [no, no]].map(([a, b]) => rat(a! * b!, U16 * U16)));
    for (const outcome of ['brn', 'flinch']) expect(labels(outcomes)).toContainEqual({ kind: 'effect', side: 'p1', source: 'firefang', outcome });
    expect(outcomes.every((each) => !each.unlabelled)).toBe(true);
  });

  it('Focus Energy brings Showdown\'s condition, 2 more crit stages: a crit 1 in 4 instead of 1 in 16', () => {
    expect(Dex.mod(KAIZO_MOD).moves.get(idOf(ID.focusEnergy)).condition).toBeDefined();
    const start = createBattle(duel(monferno([ID.focusEnergy, ID.tackle]), zigzagoon([ID.growl])));
    const [focused, ...rest] = expandTurn(start, BOTH_FIRST);
    expect([rest, 'focusenergy' in mine(focused!).volatiles]).toEqual([[], true]);
    const crit = (outcomes: Outcome[]) => chanceOf(outcomes, (o) => o.labels.some((label) => label.kind === 'crit' && label.outcome === 'crit'));
    expect([crit(expandTurn(focused!.state, { p1: move(1), p2: move(0) })), crit(expandTurn(start, { p1: move(1), p2: move(0) }))])
      .toEqual([draws(residueWeights(4)[0]!), draws(residueWeights(16)[0]!)]);
  });
});

describe('fixes', () => {
  it('a table move makes contact by its ROM flag: Rough Skin hurts Mystical Fire\'s user (Swift base), never Sky Attack\'s (Tackle base)', () => {
    const table = Dex.mod(KAIZO_MOD).moves;
    expect([table.get(idOf(ID.skyAttack)).flags['contact'], table.get(idOf(ID.mysticalFire)).flags['contact']]).toEqual([undefined, 1]);
    const hurt = (outcome: Outcome) => outcome.log.some((line) => line.startsWith('|-damage|p1a: Zigzagoon|') && line.includes('Rough Skin'));
    const [sky, fire] = [ID.skyAttack, ID.mysticalFire].map((id) => turn(weak([id]), deoxys(), ABILITY.roughSkin));
    expect([sky!.length > 0, sky!.some(hurt), fire!.length > 0, fire!.every(hurt)]).toEqual([true, false, true, true]);
  });

  it('Oblivious doesn\'t block Captivate (the docs give no exception), but still blocks Attract', () => {
    const versus = (id: number, ability: number) => turn(monferno([id]), zigzagoon([ID.meanLook], { gender: 'F' }), ability);
    for (const outcome of versus(ID.captivate, ABILITY.oblivious)) expect(foe(outcome).boosts.spa).toBe(-2);
    for (const outcome of versus(ID.attract, ABILITY.oblivious)) expect(foe(outcome).volatiles).not.toHaveProperty('attract');
    for (const outcome of versus(ID.attract, BA)) expect(foe(outcome).volatiles).toHaveProperty('attract');
  });

  it('"Struggle effect" runs Showdown\'s Struggle (its recoil: counters.test.ts), its roll labelled, and nothing names it unmodelled', () => {
    const start = createBattle(duel(weak([ID.tackle], { pp: [0] }), deoxys([ID.growl]), BA)); // no PP: Struggle
    const outcomes = expandTurn(start, BOTH_FIRST);
    for (const outcome of [{ state: start, unlabelled: false }, ...outcomes]) expect([unmodelledIn(outcome.state), outcome.unlabelled]).toEqual([[], false]);
    expect(labels(outcomes).some((label) => label.kind === 'roll' && label.source === 'struggle')).toBe(true);
  });
});

describe('plain hits', () => {
  it('a "None" move whose namesake does more is a plain hit: the fixture\'s Outrage locks nothing, its Magnitude draws nothing', () => {
    for (const outcome of turn(weak([ID.outrage, ID.growl]), deoxys(), BA)) {
      expect(mine(outcome).volatiles).not.toHaveProperty('lockedmove');
      expect(legalChoices(outcome.state, 'p1')).toEqual([move(0), move(1)]);
    }
    expect(labels(turn(weak([ID.magnitude]), deoxys(), BA)).some((label) => label.kind === 'pick')).toBe(false);
  });

  it('no plain-effect hack move keeps a non-neutral Showdown callback (fixture data)', () => {
    const plain = [...installedMoves().values()].filter((kaizo) => engineEffect(kaizo).kind === 'plain').map((kaizo) => kaizo.id);
    expect(plain).toEqual(expect.arrayContaining([ID.return, ID.frustration, ID.outrage, ID.magnitude, ID.psywave, ID.megaKick]));
    expect(plainCallbacks(installedMoves())).toEqual([]);
  });

  const dataDir = process.env.DATA_DIR || 'data';
  const real = existsSync(join(dataDir, 'rom', 'romdata.json')) && existsSync(join(dataDir, 'docs', 'Moves.csv'));
  it.skipIf(!real)(`no plain-effect hack move keeps a non-neutral Showdown callback (${dataDir})`, () => {
    const data = loadLocalData(dataDir);
    const moves = buildMoves(data);
    installKaizoDex(data, moves);
    try {
      expect([...moves.values()].filter((kaizo) => engineEffect(kaizo).kind === 'plain').length).toBeGreaterThan(40);
      expect(plainCallbacks(moves)).toEqual([]);
    } finally {
      installKaizoDex(fixture.data, fixture.moves);
    }
  });
});

/** The plain-effect moves of `moves` with a function in their Showdown data ("<id>: <path>"), but a neutral `basePowerCallback`. */
function plainCallbacks(moves: Map<number, KaizoMove>): string[] {
  const table = Dex.mod(KAIZO_MOD).data.Moves as unknown as Record<string, Record<string, unknown>>;
  const found: string[] = [];
  const scan = (value: unknown, path: string, id: string) => {
    if (typeof value === 'function') {
      const neutral = path === 'basePowerCallback' && (value as (...args: unknown[]) => unknown)(undefined, undefined, { basePower: 77 }) === 77;
      if (!neutral) found.push(`${id}: ${path}`);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) scan(inner, path === '' ? key : `${path}.${key}`, id);
    }
  };
  for (const kaizo of moves.values()) if (engineEffect(kaizo).kind === 'plain') scan(table[moveId(kaizo)], '', moveId(kaizo));
  return found;
}
