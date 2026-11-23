// The engine's damage, the calc's `damage()` and `gen4Damage` agree: for each fixture matchup the three give the same 16
// rolls, plain and critical (the engine's from the first damage line of an `expandTurn`, weighted by outcome probability).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { type CalcField, type CalcSide, damage } from '../../../src/calc/calc.js';
import { gen4ConfusionDamage, gen4Damage } from '../../../src/calc/gen4Damage.js';
import type { EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { unmodelledIn } from '../../../src/engine/index.js';
import { METRONOME_COUNT_NOTE } from '../../../src/engine/mod/scripts.js';
import { installKaizoDex, moveId } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { toNumber } from '../../../src/engine/rational.js';
import { setStartStatus } from '../../../src/engine/sets.js';
import type { StartStatus } from '../../../src/save/status.js';
import { BAG, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

/** Ability IDs of the hack ROM (generated/abilities.txt). */
const AB = {
  thickFat: 47, hustle: 55, guts: 62, marvelScale: 63, blaze: 66, simple: 86, adaptability: 91, solarPower: 94, technician: 101,
  unaware: 109, tintedLens: 110, filter: 111, scrappy: 113, flowerGift: 122, hugePower: 37, sniper: 97, rivalry: 79,
} as const;
/** Item IDs (the hack ROM): Choice Band, Muscle Band, Expert Belt, Life Orb, a Flame Plate, Silk Scarf, Occa Berry, Chilan Berry, Light Ball. */
const IT = { choiceBand: 220, muscleBand: 266, expertBelt: 268, lifeOrb: 270, flamePlate: 298, silkScarf: 251, occa: 184, chilan: 200, lightBall: 236 } as const;

interface Side {
  species: number; level?: number; ability?: number; item?: number; status?: StartStatus['kind']; boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd', number>>;
  /** HP for the pinch abilities and the HP-based powers; the engine's defender is otherwise made too bulky to be knocked out. */
  hp?: number; foresight?: boolean;
  /** The attacker's consecutive uses of the move, counting this one (a Metronome item). */
  metronome?: number;
  /** The defender's Dig / Fly / Dive / Minimize state. */
  hiding?: 'airborne' | 'underground' | 'underwater' | 'minimized';
}
interface Matchup {
  name: string; attacker: Side; defender: Side; move: number; field?: CalcField;
  /** A fixed-damage move cannot crit; a hit that cannot crit is checked as a plain hit only. */
  noCrit?: boolean;
  /** Fury Attack's engine turn enumerates every hit count (twelve seconds): its first hit is the same `getDamage` call as a single hit's. */
  noEngine?: boolean;
}

const WEATHER = { rain: 'raindance', sun: 'sunnyday', sand: 'sandstorm', hail: 'hail' } as const;

const M = (name: string, attacker: Side, defender: Side, move: number, extra: Partial<Matchup> = {}): Matchup => ({ name, attacker, defender, move, ...extra });
const Z = ID.zigzagoon;
const D = ID.deoxys;

const MATCHUPS: Matchup[] = [
  M('STAB: Monferno Ember on Zigzagoon', { species: ID.monferno, level: 30 }, { species: Z, level: 20 }, ID.ember),
  M('no STAB, neutral: Zigzagoon Tackle on Deoxys', { species: Z }, { species: D }, ID.tackle),
  M('4x: Ice on Grass/Flying', { species: D }, { species: ID.tropius }, ID.plainIce),
  M('1/4x: Fire Ball on Water/Dragon', { species: ID.monferno }, { species: ID.bidoof }, ID.fireBall),
  M('burn halves a physical hit', { species: Z, status: 'burn' }, { species: D }, ID.plainHit),
  M('Reflect (and a crit ignores it)', { species: Z }, { species: D }, ID.plainHit, { field: { reflect: true } }),
  M('Light Screen on a special hit', { species: Z }, { species: D }, ID.plainSpecial, { field: { lightScreen: true } }),
  M('stat stages: Attack -2, Defense +2 (a crit ignores both)', { species: Z, boosts: { atk: -2 } }, { species: D, boosts: { def: 2 } }, ID.plainHit),
  M('stat stages: Attack +3, Defense -1', { species: Z, boosts: { atk: 3 } }, { species: D, boosts: { def: -1 } }, ID.plainHit),
  M('rain on Fire', { species: ID.monferno }, { species: Z }, ID.fireBall, { field: { weather: 'rain' } }),
  M('rain on Water', { species: ID.bidoof }, { species: Z }, ID.waterBall, { field: { weather: 'rain' } }),
  M('sun on Fire', { species: ID.monferno }, { species: Z }, ID.fireBall, { field: { weather: 'sun' } }),
  M('sun on Water', { species: ID.bidoof }, { species: Z }, ID.waterBall, { field: { weather: 'sun' } }),
  M('Life Orb', { species: Z, item: IT.lifeOrb }, { species: D }, ID.plainHit),
  M('Expert Belt on a super effective hit', { species: D, level: 30, item: IT.expertBelt }, { species: ID.shaymin }, ID.plainIce),
  M('Choice Band on an odd Attack', { species: Z, level: 45, item: IT.choiceBand }, { species: D }, ID.plainHit),
  M('Tinted Lens on a resisted hit', { species: Z, ability: AB.tintedLens }, { species: ID.tropius }, ID.plainFighting),
  M('Tinted Lens, Fighting on Ghost/Poison: 0 (the Ghost row after the marker)', { species: Z, ability: AB.tintedLens }, { species: ID.gengar }, ID.plainFighting),
  M('Scrappy lets Fighting hit Ghost/Poison (the Poison row only)', { species: Z, ability: AB.scrappy }, { species: ID.gengar }, ID.plainFighting),
  M('Filter on a super effective hit', { species: D }, { species: ID.shaymin, ability: AB.filter }, ID.plainIce),
  M('Technician (Tackle, power 35)', { species: Z, ability: AB.technician }, { species: D }, ID.tackle),
  M('Adaptability', { species: ID.monferno, ability: AB.adaptability }, { species: Z }, ID.ember),
  M('Huge Power at +1 on an odd Attack', { species: Z, level: 31, ability: AB.hugePower, boosts: { atk: 1 } }, { species: D }, ID.plainHit),
  M('Guts with a burn and Choice Band on an odd Attack', { species: Z, level: 38, ability: AB.guts, item: IT.choiceBand, status: 'burn' }, { species: D }, ID.plainHit),
  M('Solar Power in sun', { species: ID.gengar, ability: AB.solarPower }, { species: D }, ID.plainSpecial, { field: { weather: 'sun' } }),
  M('a resist berry halves a super effective hit', { species: ID.monferno }, { species: ID.shaymin, item: IT.occa }, ID.fireBall),
  M('Chilan Berry halves a Normal hit', { species: Z }, { species: D, item: IT.chilan }, ID.plainHit),
  M('multi-hit: the first hit of Fury Attack', { species: Z }, { species: D }, ID.furyAttack, { noEngine: true }),
  M('fixed damage: Seismic Toss is the level', { species: Z, level: 45 }, { species: D }, ID.seismicToss, { noCrit: true }),
  M('fixed damage: Dragon Rage on a Normal-type', { species: Z }, { species: Z }, ID.dragonRage, { noCrit: true }),
  M('Blaze at low HP on a Thick Fat target (Thick Fat first, then Blaze)', { species: ID.monferno, level: 33, ability: AB.blaze, hp: 20 }, { species: Z, ability: AB.thickFat }, ID.plainFire),
  M('Sniper critical hit (x3)', { species: Z, ability: AB.sniper }, { species: D }, ID.plainHit),
  M('Shadow Ball on Ghost/Dark: only even rolls', { species: Z }, { species: ID.spiritomb }, ID.plainGhost),
  M('Ice Beam on Fire/Flying: the neutral rolls', { species: D }, { species: ID.charizard }, ID.plainIce),
  M('a Plate: 50 where vanilla has 20', { species: ID.monferno, item: IT.flamePlate }, { species: Z }, ID.fireBall),
  M('Muscle Band', { species: Z, item: IT.muscleBand }, { species: D }, ID.plainHit),
  M('Silk Scarf with Technician', { species: Z, level: 35, item: IT.silkScarf, ability: AB.technician }, { species: D }, ID.tackle),
  M('Marvel Scale on a paralysed defender', { species: Z }, { species: D, ability: AB.marvelScale, status: 'paralysis' }, ID.plainHit),
  M('Simple doubles the defender\'s stage', { species: Z }, { species: D, ability: AB.simple, boosts: { def: 2 } }, ID.plainHit),
  M('Unaware ignores the defender\'s stage', { species: Z, ability: AB.unaware }, { species: D, boosts: { def: 2 } }, ID.plainHit),
  M('Flower Gift in sun on the defender\'s Special Defense', { species: Z }, { species: D, ability: AB.flowerGift }, ID.plainSpecial, { field: { weather: 'sun' } }),
  M('Light Ball doubles the power', { species: ID.pikachu, item: IT.lightBall }, { species: D }, ID.plainSpecial),
  M('Explosion halves the Defense', { species: Z }, { species: D }, ID.explosion),
  M('the Metronome item after 4 consecutive uses: x14/10 after Life Orb, before the roll', { species: Z, item: 277, metronome: 4 }, { species: D }, ID.plainHit),
  M('a Minimized target doubles the power first: Technician then misses a 40-power move', { species: Z, ability: AB.technician }, { species: D, hiding: 'minimized' }, ID.plainStomp),
  M('Rivalry on the same gender', { species: Z, ability: AB.rivalry }, { species: D }, ID.plainHit),
];

const levelOf = (side: Side) => side.level ?? 50;

function attackerMon(side: Side, move: number): PlayerMon {
  return playerMon(side.species, levelOf(side), [move], {
    ...(side.hp !== undefined && { currentHp: side.hp }),
    ...(side.ability !== undefined && { ability: knownAbility(side.ability) }), ...(side.item !== undefined && { item: side.item }),
    ...(side.status !== undefined && side.status !== 'none' && { status: { kind: side.status } as StartStatus }),
  });
}
function defenderMon(side: Side): ResolvedMon {
  return resolvedMon(side.species, levelOf(side), [ID.meanLook], {
    ...(side.ability !== undefined && { ability: knownAbility(side.ability) }), ...(side.item !== undefined && { item: side.item }),
  });
}

const calcSide = (mon: PlayerMon | ResolvedMon, side: Side, curHp?: number): CalcSide => ({
  mon, ...(side.boosts && { boosts: side.boosts }), ...(side.status && { status: { kind: side.status } as StartStatus }),
  ...(curHp !== undefined && { curHp }), ...(side.foresight && { foresight: true }),
  ...(side.metronome !== undefined && { metronomeTurns: side.metronome }), ...(side.hiding && { hiding: side.hiding }),
});

/** Ascending 16 rolls from `(damage, count)` pairs. */
const expandRolls = (pairs: Map<number, number>): number[] => [...pairs].sort((a, b) => a[0] - b[0]).flatMap(([value, count]) => Array<number>(count).fill(value));
/** The 16 rolls of `outcomes`: the damage `dealt` reads from each, weighted by its share of their total probability. */
function weightedRolls(outcomes: Outcome[], dealt: (outcome: Outcome) => number): number[] {
  const total = outcomes.reduce((sum, outcome) => sum + toNumber(outcome.probability), 0);
  const pairs = new Map<number, number>();
  for (const outcome of outcomes) pairs.set(dealt(outcome), (pairs.get(dealt(outcome)) ?? 0) + (toNumber(outcome.probability) / total) * 16);
  return expandRolls(new Map([...pairs].map(([value, count]) => [value, Math.round(count)])));
}
const hpOfLine = (line: string) => Number(/\|(\d+)\/\d+/.exec(line)![1]);

/** The engine's first damage to the defender in each outcome of a turn in which the attacker uses `move` and the defender Mean Look. */
function engineRolls(m: Matchup, crit: boolean): number[] {
  const mon = attackerMon(m.attacker, m.move);
  const foe = defenderMon(m.defender);
  const input = { player: [mon], trainer: resolvedTrainer(BAG.none, [foe]), field: {} };
  let state = createBattle(input);
  const bulky = 9000;
  const b = restore(state);
  const [me, them] = [b.p1.active[0]!, b.p2.active[0]!];
  for (const stat of ['atk', 'def', 'spa', 'spd'] as const) {
    if (m.attacker.boosts?.[stat]) me.boosts[stat] = m.attacker.boosts[stat]!;
    if (m.defender.boosts?.[stat]) them.boosts[stat] = m.defender.boosts[stat]!;
  }
  if (m.attacker.metronome !== undefined) {
    // Showdown's volatile counts one more use at the move's `TryMove`: start one short, having used this move last turn.
    Object.assign(me.volatiles['metronome']!, { numConsecutive: m.attacker.metronome - 1, lastMove: moveId(fixture.moves.get(m.move)!) });
    me.moveLastTurnResult = true;
  }
  if (m.defender.hiding === 'minimized') them.volatiles['minimize'] = them.battle.initEffectState({ id: 'minimize', target: them });
  if (m.defender.status && m.defender.status !== 'none') setStartStatus(them, { kind: m.defender.status } as StartStatus);
  them.maxhp = them.hp = bulky;
  if (m.field?.weather) b.field.setWeather(WEATHER[m.field.weather], me);
  if (m.field?.reflect) b.p2.addSideCondition('reflect', me);
  if (m.field?.lightScreen) b.p2.addSideCondition('lightscreen', me);
  state = snapshot(b);
  const outcomes = expandTurn(state, { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } });
  const critOf = (outcome: Outcome) => outcome.labels.some((label) => label.kind === 'crit' && label.outcome === 'crit');
  // A hit that deals nothing (an immunity) draws no crit: its one branch is the plain hit's, and a crit of it is 0 too.
  if (crit && !outcomes.some(critOf)) return Array<number>(16).fill(0);
  const branch = outcomes.filter((outcome) => critOf(outcome) === crit && !outcome.labels.some((label) => label.kind === 'hit' && label.outcome === 'miss'));
  const rolls = weightedRolls(branch, (outcome) => {
    const line = outcome.log.find((entry) => /^\|-damage\|p2a:/.test(entry));
    return bulky - (line === undefined ? bulky : hpOfLine(line));
  });
  if (rolls.length !== 16) throw new Error(`${m.name}: the engine's rolls are ${rolls.length} of 16`);
  return rolls;
}

describe('the engine, damage() and gen4Damage agree', () => {
  for (const m of MATCHUPS) {
    const attacker = attackerMon(m.attacker, m.move);
    const defender = defenderMon(m.defender);
    const move = () => fixture.moves.get(m.move)!;
    const a = () => calcSide(attacker, m.attacker, m.attacker.hp);
    const d = () => calcSide(defender, m.defender);
    const field = m.field ?? {};
    for (const crit of m.noCrit ? [false] : [false, true]) {
      it(`${m.name}${crit ? ' (crit)' : ''}`, () => {
        const reference = gen4Damage(a(), d(), move(), field, crit);
        const result = damage(a(), d(), move(), field, { crit });
        expect(result).not.toBeNull();
        expect(crit ? result!.critRolls : result!.rolls, 'damage()').toEqual(reference);
        if (!m.noEngine) expect(engineRolls(m, crit), 'the engine').toEqual(reference);
      });
    }
  }
});

// The confusion self-hit, `CALC_SELF_HIT(MOVE_STRUGGLE, 40)`: a physical Normal Struggle of power 40, with every power
// term, stat term, stage and burn, and no weather or screen.

/** The 16 rolls of a trainer's confused Zigzagoon-class `side` hitting itself, from the engine's first confused attempt. */
function engineSelfHitRolls(side: Side, field: CalcField = {}): number[] {
  const foe = defenderMon(side);
  const start = createBattle({ player: [playerMon(ID.monferno, 30, [ID.confuseRay, ID.meanLook])], trainer: resolvedTrainer(BAG.none, [foe]), field: {} });
  const confused = runFirstOutcome(start, { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } }); // Confuse Ray lands after Mean Look
  const b = restore(confused);
  const them = b.p2.active[0]!;
  for (const stat of ['atk', 'def'] as const) if (side.boosts?.[stat]) them.boosts[stat] = side.boosts[stat]!;
  if (side.status && side.status !== 'none') setStartStatus(them, { kind: side.status } as StartStatus);
  them.maxhp = them.hp = 9000;
  if (field.weather) b.field.setWeather(WEATHER[field.weather], b.p1.active[0]!);
  const outcomes = expandTurn(snapshot(b), { p1: { kind: 'move', slot: 1 }, p2: { kind: 'move', slot: 0 } });
  const selfHit = (line: string) => line.startsWith('|-damage|p2a:') && line.endsWith('|[from] confusion');
  return weightedRolls(outcomes.filter((outcome) => outcome.log.some(selfHit)), (outcome) => 9000 - hpOfLine(outcome.log.find(selfHit)!));
}

const SELF_HITS: [string, Side, CalcField?][] = [
  ['Choice Band and Guts with a burn on an odd Attack', { species: Z, level: 38, ability: AB.guts, item: IT.choiceBand, status: 'burn' }],
  ['Huge Power at +1 on an odd Attack', { species: Z, level: 31, ability: AB.hugePower, boosts: { atk: 1 } }],
  ['a burn halves it', { species: Z, level: 41, status: 'burn' }],
  ['Marvel Scale on its own Defense with a status', { species: Z, level: 37, ability: AB.marvelScale, status: 'paralysis' }],
  ['Silk Scarf (Normal) and Muscle Band raise the power', { species: Z, level: 43, item: IT.silkScarf }],
  ['Simple doubles both its stages', { species: Z, level: 35, ability: AB.simple, boosts: { atk: 1, def: 1 } }],
  ['weather does nothing to it (Flower Gift in sun)', { species: Z, level: 39, ability: AB.flowerGift }, { weather: 'sun' }],
];

describe('the confusion self-hit: the engine and gen4ConfusionDamage agree', () => {
  it.each(SELF_HITS)('%s', (_, side, field) => expect(engineSelfHitRolls(side, field)).toEqual(gen4ConfusionDamage(calcSide(defenderMon(side), side))));
});

// Dig / Fly / Dive: `getDamage` called directly with the target's volatile set (an `expandTurn` at a semi-invulnerable
// target misses), against gen4Damage's `hiding` and against the same hit with no state, so a dropped x2 shows.

/** The engine's 16 rolls for the attacker's move, enumerated through a chance driver, with `volatile` set on the defender. */
function directRolls(m: Matchup, volatile: string | null, crit: boolean): number[] {
  const state = createBattle({ player: [attackerMon(m.attacker, m.move)], trainer: resolvedTrainer(BAG.none, [defenderMon(m.defender)]), field: {} });
  const counts = new Map<number, number>();
  let script: number[] | null = [];
  while (script !== null) {
    const driver = new ChanceDriver(script, { collapse: false });
    const b = restore(state, driver);
    const [me, them] = [b.p1.active[0]!, b.p2.active[0]!];
    them.maxhp = them.hp = 9000;
    if (volatile !== null) {
      expect(b.dex.conditions.get(volatile).exists, `${volatile} is a Showdown condition`).toBe(true);
      them.volatiles[volatile] = them.battle.initEffectState({ id: volatile, target: them });
    }
    const active = b.dex.getActiveMove(moveId(fixture.moves.get(m.move)!));
    const dealt = b.actions.getDamage(me, them, active);
    const critHit = !!them.getMoveHitData(active).crit;
    const roll = driver.points.find((point) => point.kind === 'roll');
    if (critHit === crit) counts.set(dealt as number, (counts.get(dealt as number) ?? 0) + (roll === undefined ? 16 : Number(roll.options[roll.chosen]!.weight / 4096n)));
    script = nextScript(driver.points);
  }
  return expandRolls(counts);
}

const HIDING: [string, string, Side, Side, NonNullable<Side['hiding']>, number][] = [
  ['Dig and the Earthquake effect (147)', 'dig', { species: Z, ability: AB.technician }, { species: D }, 'underground', ID.plainQuake],
  ['Fly and the Gust effect (149)', 'fly', { species: Z, ability: AB.technician }, { species: D }, 'airborne', ID.plainGust],
  ['Dive and the Surf effect (261)', 'dive', { species: Z, ability: AB.technician }, { species: D }, 'underwater', ID.plainSurf],
];

describe('a hiding target doubles the power first, by ROM effect', () => {
  for (const [name, volatile, attacker, defender, hiding, move] of HIDING) {
    for (const crit of [false, true]) {
      it(`${name}${crit ? ' (crit)' : ''}`, () => {
        const m: Matchup = { name, attacker, defender: { ...defender, hiding }, move };
        const plain: Matchup = { name, attacker, defender, move };
        const reference = gen4Damage(calcSide(attackerMon(attacker, move), attacker), calcSide(defenderMon(defender), { ...defender, hiding }), fixture.moves.get(move)!, {}, crit);
        const without = gen4Damage(calcSide(attackerMon(attacker, move), attacker), calcSide(defenderMon(defender), defender), fixture.moves.get(move)!, {}, crit);
        expect(reference[15]!).toBeGreaterThan(without[15]!); // the state matters
        expect(directRolls(m, volatile, crit)).toEqual(reference);
        expect(directRolls(plain, null, crit)).toEqual(without);
      });
    }
  }
});

// The Metronome item's count after a locked or failed use is Showdown's, not the cartridge's (bl:6160-6200): the engine says so.
describe('a Metronome holder whose count the engine cannot keep as the cartridge does', () => {
  const notes = (setup: (me: Pokemon) => void, move: number = ID.plainHit): string[] => {
    const b = restore(createBattle({ player: [attackerMon({ species: Z, item: 277 }, move)], trainer: resolvedTrainer(BAG.none, [defenderMon({ species: D })]), field: {} }));
    b.p2.active[0]!.maxhp = b.p2.active[0]!.hp = 9000;
    setup(b.p1.active[0]!);
    return expandTurn(snapshot(b), { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } }).flatMap((outcome) => unmodelledIn(outcome.state));
  };
  const ran = (result: boolean) => (me: Pokemon) => { me.moveLastTurnResult = result; };
  it.each<[string, (me: Pokemon) => void, number, boolean]>([
    ['notes a use after a failed one', ran(false), ID.plainHit, true],
    ['notes a use locked into a move', (me) => { me.volatiles['lockedmove'] = me.battle.initEffectState({ id: 'lockedmove', target: me, time: 2 }); }, ID.plainHit, true],
    ['notes Rollout (effect 117), whose script the cartridge counts as locked', ran(true), ID.plainRoll, true],
    ['notes a charge-turn attack (Fly, effect 155)', ran(true), ID.plainFly, true],
    ['says nothing after a plain run of uses', ran(true), ID.plainHit, false],
  ])('%s', (_, setup, move, noted) => expect(notes(setup, move).includes(METRONOME_COUNT_NOTE)).toBe(noted));
});
