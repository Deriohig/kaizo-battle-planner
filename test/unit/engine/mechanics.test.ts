// The named mechanics: each docs text resolves to an inherited Showdown move (its Gen 4 code with the ROM's numbers and
// flags) or to an engine override where the cartridge differs (pokeplatinum, cited in src/engine/mod/*.ts).

import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it } from 'vitest';
import { normaliseEffectText } from '../../../src/battle/effectMap.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { carryOut, createBattle, legalChoices, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installedMoves, installKaizoDex, KAIZO_MOD, moveId, showdownMoveData } from '../../../src/engine/dex.js';
import { ENGINE_EFFECTS, type EngineEffect } from '../../../src/engine/effects.js';
import { expandTurn } from '../../../src/engine/expand.js';
import * as engine from '../../../src/engine/index.js';
import { BRICK_BREAK_IMMUNE_NOTE, LAST_RESORT_CALLER_NOTE, metronomeCallNote, WISH_RECIPIENT_NOTE } from '../../../src/engine/mod/moves.js';
import { unmodelledMoves } from '../../../src/engine/unmodelled.js';
import { belowWeight, residueWeights } from '../../../src/engine/odds.js';
import { buildMoves, hiddenPower } from '../../../src/battle/moves.js';
import { loadLocalData } from '../../../src/data/load.js';
import { existsSync, readFileSync } from 'node:fs';
import { storeSpeedValues } from '../../../src/engine/speedValues.js';
import { TYPE_NAMES } from '../../../src/rom/tables.js';
import { itemEffect } from '../../../src/calc/battler.js';
import { add, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const { Dex } = PS;

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

type Choices = { p1?: Choice; p2?: Choice };
const move = (slot: number): Choice => ({ kind: 'move', slot });
const switchTo = (index: number): Choice => ({ kind: 'switch', index });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const SECOND = { p1: move(1), p2: move(0) };
const entry = (text: string): EngineEffect | undefined => ENGINE_EFFECTS[normaliseEffectText(text)];
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational =>
  outcomes.filter(test).reduce((total, outcome) => add(total, outcome.probability), ZERO);
const labels = (outcomes: Outcome[]) => outcomes.flatMap((outcome) => outcome.labels);
const hasLabel = (outcomes: Outcome[], kind: string, source?: string) =>
  labels(outcomes).some((label) => label.kind === kind && (source === undefined || ('source' in label && label.source === source)));
const foe = (outcome: Outcome | EngineState) => restore('state' in outcome ? outcome.state : outcome).p2.active[0]!;
const mine = (outcome: Outcome | EngineState) => restore('state' in outcome ? outcome.state : outcome).p1.active[0]!;
const idOf = (id: number) => moveId(installedMoves().get(id)!);
const dexMove = (id: number) => Dex.mod(KAIZO_MOD).moves.get(idOf(id));
const logged = (outcome: Outcome, prefix: string) => outcome.log.some((line) => line.startsWith(prefix));
const canSwitch = (state: EngineState, side: 'p1' | 'p2') => legalChoices(state, side).some((choice) => choice.kind === 'switch');

/** A single battle: the player's `mineMons` (lead first) against the trainer's `theirs`. */
const battle = (mineMons: PlayerMon | PlayerMon[], theirs: ResolvedMon | ResolvedMon[], enemyAbility?: number, bag: number = BAG.none): BattleInput => ({
  player: Array.isArray(mineMons) ? mineMons.map((mon, slot) => ({ ...mon, location: { kind: 'party', slot } })) : [mineMons],
  trainer: resolvedTrainer(bag, Array.isArray(theirs) ? theirs : [theirs]), field: {},
  ...(enemyAbility === undefined ? {} : { world: { enemy: (Array.isArray(theirs) ? theirs : [theirs]).map(() => ({ ability: enemyAbility })) } }),
});
const start = (mineMons: PlayerMon | PlayerMon[], theirs: ResolvedMon | ResolvedMon[], enemyAbility?: number, bag?: number) =>
  createBattle(battle(mineMons, theirs, enemyAbility, bag));

/** `state` after `change` to its battle. */
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const restored = restore(state);
  change(restored);
  return snapshot(restored);
}
const setHp = (side: 'p1' | 'p2', hp: number) => (b: Battle) => { b[side].active[0]!.hp = hp; };
const slowP1 = (b: Battle) => { b.p1.active[0]!.boosts.spe = -6; };
const asleep = (b: Battle) => { b.p1.active[0]!.setStatus('slp'); b.p1.active[0]!.statusState['time'] = 3; };

const armored = { ability: knownAbility(ABILITY.battleArmor) };
const weak = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.zigzagoon, 5, moves, fields);
const monferno = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, moves, fields);
const bulky = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.deoxys, 50, moves, { ...armored, ...fields });
const deoxys = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.deoxys, 50, moves, fields);
const zigzagoon = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 20, moves, fields);
const little = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 5, moves, fields);
const twoDeoxys = () => [deoxys([ID.howl]), deoxys([ID.howl])];

/** The HP a side's active lost between two states. */
const lost = (before: EngineState, after: EngineState, side: 'p1' | 'p2') => restore(before)[side].active[0]!.hp - restore(after)[side].active[0]!.hp;
/** The first outcome's state of a step. */
const step = (state: EngineState, choices: Choices) => expandTurn(state, choices)[0]!.state;
const crits = (outcomes: Outcome[]) => outcomes.filter((outcome) => outcome.labels.some((label) => label.kind === 'crit' && label.outcome === 'crit'));
/** A turn's outcomes, at least one, each passed to `check`. */
const every = (state: EngineState, choices: Choices, check: (outcome: Outcome) => void) => {
  const outcomes = expandTurn(state, choices);
  expect(outcomes.length).toBeGreaterThan(0);
  outcomes.forEach(check);
  return outcomes;
};
/** The first outcome whose phase is `kind`. */
const phase = (outcomes: Outcome[], kind: string) => {
  const found = outcomes.find((outcome) => outcome.state.phase.kind === kind);
  expect(found).toBeDefined();
  return found!.state;
};
const distinctLosses = (from: EngineState, outcomes: Outcome[]) => new Set(outcomes.map((outcome) => lost(from, outcome.state, 'p2')));

describe('effect texts', () => {
  it('each inherited text names the Showdown move whose Gen 4 code is the text', () => {
    const inherited: Record<string, string> = {
      'Whirlpool effect': 'wrap', 'Selfdestruct/ Explosion effect': 'explosion', 'Pursuit effect': 'pursuit',
      'Protect/ Detect effect': 'protect', 'Allows user to endure a fatal hit and survive at 1 HP': 'endure', 'Substitute effect': 'substitute',
      'Switches user out after dealing damage': 'uturn', 'Baton Pass effect': 'batonpass', 'Whirlwind/ Roar effect': 'roar',
      'Stealth Rocks effect': 'stealthrock', 'Spikes effect': 'spikes', 'Toxic Spikes effect': 'toxicspikes',
      '1/2 damage from Physical attacks': 'reflect', '1/2 damage from Special attacks': 'lightscreen', 'Safeguard effect': 'safeguard',
      'Prevents lowering of stats': 'mist', 'Trick Room effect': 'trickroom', '2x Spd for user\'s party for 3 turns': 'tailwind',
      'Gravity effect': 'gravity', 'Torment effect': 'torment', 'Locks target into last move used for 3-7 turns': 'encore',
      'Disables last move used for 4-7 turns': 'disable', 'Leech Seed effect': 'leechseed', 'Causes Sleep and restores all HP': 'rest',
      'Sleep Talk effect': 'sleeptalk', 'Pain Split effect': 'painsplit', '2x last amount of damage received': 'counter',
      'Mirror Coat effect': 'mirrorcoat', 'Focus Punch effect': 'focuspunch', 'Guaranteed Flinch; can only be used turn 1': 'fakeout',
      'All users on field faint in 3 turns': 'perishsong', 'Destiny Bond effect': 'destinybond',
      'Renders the target\'s held item unusable': 'knockoff', 'Belly Drum effect': 'bellydrum', 'Resets stat changes': 'haze',
      'Causes flinch and 2x damage if target has used Minimize': 'stomp', 'Higher power the less HP the user has': 'flail',
      'Power= Base power x(user\'s current HP/ user\'s max HP)': 'waterspout',
      'Power = min(150; (25 x Target\'s Current Speed / User\'s Current Speed) + 1)': 'gyroball',
      'Inflicts greater damage on heavier targets': 'lowkick', '2x power if target is at or below 1/2 HP': 'brine',
      '2x power if user is Poisoned; Paralyzed; or Burned.': 'facade', 'Power= 60 + (20x # of stat increases of target)': 'punishment',
      '2x Power if user moves after target': 'payback', 'Hidden Power effect': 'hiddenpower', 'Type changes to match weather': 'weatherball',
      'The less PP the move has; the greater its Power': 'trumpcard',
      '2x power if target is Paralyzed; cures target of Paralysis': 'smellingsalts', '2x power if target is asleep; wakes up target': 'wakeupslap',
      'Present Effect': 'present', 'Prevents target from switching out or fleeing': 'meanlook', 'Consumes target\'s berry': 'bugbite',
      'Always hits in Hail': 'blizzard', 'Always hits in rain; chance to Paralyze': 'thunder', 'Curse effect': 'curse',
      'Removes Light Screen/ Reflect from target\'s side of the field': 'brickbreak', 'Infatuates target of opposite gender': 'attract',
      'Deals damage equal to user\'s level': 'seismictoss', 'Redirects all moves to user': 'followme',
      'Charging turn unless in Harsh Sunlight': 'solarbeam', 'Metronome effect': 'metronome',
      'Target\'s HP becomes equal to the user\'s current HP': 'endeavor', 'Roost effect': 'roost',
      'Damage= 1.5x damage dealt by the target\'s last attack': 'metalburst', 'Deals damage equal to 1/2 target\'s current hp': 'superfang',
      'Chance of either Paralyzing; Burning; or Freezing target': 'triattack', 'OHKO': 'guillotine', 'Synthesis effect': 'synthesis',
      'Deals 40 damage': 'dragonrage', 'Inflicts 20 damage': 'sonicboom', 'Can only be used while asleep; chance of causing Flinch': 'snore',
      '1/2 of user\'s max HP is restored at the end of next turn': 'wish', 'Assist effect': 'assist',
      '2x Damage on Pokemon using Bounce/Fly': 'gust', 'Sharply raises a random stat of the target': 'acupressure',
      'User\'s party becomes immune to Ground-type attacks and grounded hazards for 5 turns': 'magnetrise',
      'Ally\'s attack deals 1.5x damage this turn': 'helpinghand', 'Flees from wild single battle': 'teleport',
      'Copies all of target\'s stat boosts': 'psychup', 'Pay Day effect': 'payday',
      'Damages sleeping target; heals user up to 50% of damage dealt': 'dreameater', 'Splash effect': 'thief',
      'Decreases PP of target\'s last move used by 4': 'spite', 'False Swipe effect': 'falseswipe', 'Uproar effect': 'uproar',
      'Cures user of Burn; Poison; or Paralysis': 'refresh',
      'Prevents the target from using its held item or having items used on it': 'embargo', 'Swaps the user\'s Atk stat with its Def stat': 'powertrick',
      'Prevents opponents from landing critical hits on the user\'s party for 5 turns': 'luckychant',
      'Restores 1/16 of the user\'s max HP at the end of every turn': 'aquaring', 'Recharge turn': 'roaroftime',
      'Charging turn; high crit ratio': 'razorwind', 'Ignores type immunities': 'foresight',
      'Causes all moves to ignore changes to the target\'s Evasiveness': 'miracleeye', 'Next move used by user guaranteed to hit': 'lockon',
      'Ingrain effect': 'ingrain', 'Grudge effect': 'grudge',
      'Swaps the user\'s Atk and SpAtk buffs with the target\'s Atk and SpAtk buffs': 'powerswap',
      'Swaps the user\'s Def and SpDef buffs with the target\'s Def and SpDef buffs': 'guardswap',
      'Fails unless the user has used all of its other moves at least once': 'lastresort',
      'Can only hit targets that have used Protect/ Detect': 'feint', 'Suppresses the target\'s Ability': 'gastroacid',
      'Reflects status moves back at their user': 'magiccoat',
    };
    const texts = Object.keys(inherited);
    expect(Object.fromEntries(texts.map((text) => [text, entry(text)])))
      .toEqual(Object.fromEntries(texts.map((text) => [text, { kind: 'inherit', from: inherited[text] }])));
    for (const text of ['Causes Rain', 'Causes Harsh Sunlight', 'Causes Sandstorm', 'Causes Hail']) expect(entry(text)).toMatchObject({ kind: 'inherit' });
    expect(entry('None')).toEqual({ kind: 'plain' });
    // Hurricane is a confusion chance at the ROM's chance, built from the text.
    expect(entry('Always hits in rain; chance to Confuse')).toEqual({ kind: 'secondary', volatile: 'confusion' });
  });

  it('every unmodelled entry gives a real reason', () => {
    const reasons = Object.values(ENGINE_EFFECTS).flatMap((effect) => (effect.kind === 'unmodelled' ? [effect.reason] : []));
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(40);
  });
});

describe('one-turn outcomes', () => {
  const full = (mon: Pokemon) => expect(mon.hp).toBe(mon.maxhp);
  const hurt = (mon: Pokemon) => expect(mon.hp).toBeLessThan(mon.maxhp);
  const flinched = (outcome: Outcome) => expect(logged(outcome, '|cant|p1a: Monferno|flinch')).toBe(true);
  const shedinja = () => resolvedMon(ID.shedinja, 30, [ID.growl]);
  it.each<[string, () => EngineState, (outcome: Outcome, from: EngineState) => void, Choices?]>([
    ['Explosion faints its user', () => start(weak([ID.explosion]), twoDeoxys()), (o) => expect(mine(o).hp).toBe(0)],
    ['Selfdestruct faints its user', () => start(weak([ID.selfdestruct]), twoDeoxys()), (o) => expect(mine(o).hp).toBe(0)],
    ['the hack\'s Memento (a special Explosion) faints its user', () => start(weak([ID.memento]), twoDeoxys()), (o) => expect(mine(o).hp).toBe(0)],
    // effect_script_0007.s:5 checks Damp in the effect's script; Showdown's Damp checks the move IDs.
    ['Damp stops Explosion', () => start(weak([ID.explosion]), deoxys([ID.growl]), ABILITY.damp), (o) => { full(mine(o)); full(foe(o)); }],
    ['Damp stops Memento (Explosion\'s ROM effect)', () => start(weak([ID.memento]), deoxys([ID.growl]), ABILITY.damp), (o) => { full(mine(o)); full(foe(o)); }],
    ['Endure leaves its user at 1 HP', () => changed(start(monferno([ID.tackle]), little([ID.endure])), setHp('p2', 1)), (o) => expect(foe(o).hp).toBe(1)],
    ['Safeguard keeps off a status', () => start(weak([ID.thunderWave]), deoxys([ID.safeguard])), (o) => expect(foe(o).status).toBe('')],
    ['Mist keeps off a stat drop', () => start(weak([ID.growl]), deoxys([ID.mist])), (o) => expect(foe(o).boosts.atk).toBe(0)],
    ['Leech Seed drains max HP / 8 (Battle Armor: Magic Guard would block it)', () => start(bulky([ID.leechSeed]), deoxys([ID.growl]), ABILITY.battleArmor),
      (o) => expect(foe(o).maxhp - foe(o).hp).toBe(Math.floor(foe(o).maxhp / 8))],
    ['Destiny Bond takes its attacker down', () => changed(start(monferno([ID.tackle]), [deoxys([ID.destinyBond]), little([ID.growl])]), setHp('p2', 1)),
      (o) => expect(mine(o).hp).toBe(0)],
    ['Knock Off makes the target\'s item unusable', () => start(monferno([ID.knockOff]), deoxys([ID.growl], { item: ITEM.leftovers })),
      (o) => expect(foe(o).item).toBe('')],
    ['Focus Punch fails after its user is hit', () => start(bulky([ID.focusPunch]), deoxys([ID.tackle, ID.growl]), ABILITY.battleArmor), (o) => full(foe(o))],
    ['Focus Punch hits when its user is not hit', () => start(bulky([ID.focusPunch]), deoxys([ID.tackle, ID.growl]), ABILITY.battleArmor), (o) => hurt(foe(o)),
      { p1: move(0), p2: move(1) }],
    // Showdown's Focus Punch makes its user immune to flinching; the cartridge's flinch check comes first.
    ['a Focus Punch user flinches', () => start(monferno([ID.focusPunch]), little([ID.fakeOut]), ABILITY.battleArmor), flinched],
    ['the hack\'s Sucker Punch is a plain priority hit: it hits a status-move user', () => start(bulky([ID.suckerPunch]), deoxys([ID.growl]), ABILITY.battleArmor),
      (o) => hurt(foe(o))],
    ['a hit with no ROM Protect bit goes through Protect', () => start(monferno([ID.unblockable]), deoxys([ID.protect])), (o) => hurt(foe(o))],
    ['Wonder Guard never stops a move with Fire Fang\'s ROM effect (bl:7588-7605)',
      () => start(monferno([ID.fangHit], armored), shedinja(), ABILITY.wonderGuard), (o) => expect(foe(o).hp).toBe(0)],
    ['Wonder Guard stops a plain Normal hit', () => start(monferno([ID.unblockable], armored), shedinja(), ABILITY.wonderGuard), (o) => full(foe(o))],
    ['the hack\'s Thief ("Splash effect") does nothing', () => start(monferno([ID.thief]), deoxys([ID.growl], { item: ITEM.leftovers })),
      (o) => expect([foe(o).hp, foe(o).item, mine(o).item]).toEqual([foe(o).maxhp, 'leftovers', ''])],
    ['Snore fails while its user is awake', () => start(bulky([ID.snore]), deoxys([ID.growl]), ABILITY.battleArmor), (o) => full(foe(o))],
    ['Snore works while its user sleeps', () => changed(start(bulky([ID.snore]), deoxys([ID.growl]), ABILITY.battleArmor), asleep), (o) => hurt(foe(o))],
    ['Sleep Talk never calls a move with a charge-turn ROM effect (Move_IsMultiTurn)',
      () => changed(start(bulky([ID.sleepTalk, ID.chargeHit, ID.tackle]), deoxys([ID.growl])), asleep),
      (o) => expect([logged(o, '|move|p1a: Deoxys|Tackle|'), logged(o, '|move|p1a: Deoxys|Charge Hit|')]).toEqual([true, false])],
    ['Counter returns twice a physical hit\'s damage', () => start(bulky([ID.counter]), deoxys([ID.tackle]), ABILITY.battleArmor),
      (o, from) => expect(lost(from, o.state, 'p2')).toBe(Math.min(foe(from).hp, 2 * lost(from, o.state, 'p1')))],
    ['Mirror Coat returns twice a special hit\'s damage', () => start(bulky([ID.mirrorCoat]), deoxys([ID.fireBall]), ABILITY.battleArmor),
      (o, from) => expect(lost(from, o.state, 'p2')).toBe(Math.min(foe(from).hp, 2 * lost(from, o.state, 'p1')))],
    ['Metal Burst returns 1.5x the damage taken, rounded down (bs:7153-7196)', () => start(bulky([ID.metalBurst]), deoxys([ID.tackle]), ABILITY.battleArmor),
      (o, from) => expect(lost(from, o.state, 'p2')).toBe(Math.min(foe(from).hp, Math.floor((3 * lost(from, o.state, 'p1')) / 2)))],
    ['Brick Break into a type-immune target with a screen up is noted (bl:1490-1500)',
      () => changed(start(monferno([ID.brickBreak]), resolvedMon(ID.giratina, 50, [ID.growl])), (b) => { b.p2.addSideCondition('reflect', b.p2.active[0]!); }),
      (o) => expect(engine.unmodelledIn(o.state)).toContain(BRICK_BREAK_IMMUNE_NOTE)],
    ['Brick Break into a type-immune target notes nothing without a screen', () => start(monferno([ID.brickBreak]), resolvedMon(ID.giratina, 50, [ID.growl])),
      (o) => expect(engine.unmodelledIn(o.state)).toEqual([])],
    ['fixed damage still respects type immunity (bl:7544-7556)', () => start(monferno([ID.seismicToss]), resolvedMon(ID.giratina, 50, [ID.growl])), (o) => full(foe(o))],
  ])('%s', (_, from, check, choices = BOTH_FIRST) => {
    const state = from();
    every(state, choices, (outcome) => check(outcome, state));
  });
});

describe('binding, Explosion and Pursuit', () => {
  it('binding traps its target, which loses max HP / 16 at the turn\'s end (bcp:1462-1482)', () => {
    const state = start([bulky([ID.growl]), bulky([ID.growl])], little([ID.wrap]));
    const maxhp = mine(state).maxhp;
    const bound = expandTurn(state, BOTH_FIRST).filter((outcome) => 'partiallytrapped' in mine(outcome).volatiles);
    expect(bound.length).toBeGreaterThan(0);
    const hp = (line: string) => Number(line.split('|')[3]!.split('/')[0]);
    for (const outcome of bound) {
      expect(canSwitch(outcome.state, 'p1')).toBe(false);
      const damage = outcome.log.filter((line) => line.startsWith('|-damage|p1a: Deoxys|'));
      expect(damage).toHaveLength(2);
      expect(hp(damage[0]!) - hp(damage[1]!)).toBe(Math.floor(maxhp / 16));
    }
  });

  describe('Explosion and Memento against Defense', () => {
    /** The distinct HP losses of the trainer's lead to `player`'s move, its Defense and stages set first. */
    const losses = (player: PlayerMon, ability: number | undefined, def: number | undefined, boosts: Partial<BoostsTable>, critOnly = false) => {
      const from = changed(start(player, twoDeoxys(), ability), (b) => {
        if (def !== undefined) b.p2.active[0]!.storedStats.def = def;
        Object.assign(b.p2.active[0]!.boosts, boosts);
      });
      const outcomes = expandTurn(from, BOTH_FIRST);
      return distinctLosses(from, critOnly ? crits(outcomes) : outcomes);
    };
    const boom = () => monferno([ID.explosion]);
    const unaware = (id: number) => monferno([id], { ability: knownAbility(ABILITY.unaware) });
    const BA = ABILITY.battleArmor;
    it.each<[string, () => Set<number>, () => Set<number>]>([
      // floor(floor(103 / 2) x 15 / 10) = 76, as Defense 152 at no stage; Showdown's order gave 77.
      ['halves the raw Defense, then applies the stage (bl:6943-6973)', () => losses(boom(), BA, 103, { def: 1 }), () => losses(boom(), BA, 152, {})],
      ['a crit ignores the positive stage', () => losses(boom(), undefined, 103, { def: 1 }, true), () => losses(boom(), undefined, 103, {}, true)],
      ['keeps the defender\'s Simple: +1 is +2 (bl:6868-6875)', () => losses(boom(), ABILITY.simple, 103, { def: 1 }), () => losses(boom(), ABILITY.sturdy, 103, { def: 2 })],
      ['keeps the attacker\'s Unaware (bl:6891-6893)', () => losses(unaware(ID.explosion), BA, 103, { def: 2 }), () => losses(unaware(ID.explosion), BA, 103, {})],
      ['an Unaware Memento user ignores the Sp. Def stage', () => losses(unaware(ID.memento), BA, undefined, { spd: 2 }), () => losses(unaware(ID.memento), BA, undefined, {})],
    ])('%s', (_, a, b) => expect(a()).toEqual(b()));
  });

  const pursuer = () => start(monferno([ID.pursuit], armored), twoDeoxys(), ABILITY.battleArmor);

  it('Pursuit doubles its power on a switching target and hits it before it goes', () => {
    const from = pursuer();
    const stay = expandTurn(from, BOTH_FIRST).map((outcome) => lost(from, outcome.state, 'p2'));
    const lead = (state: EngineState) => {
      const restored = restore(state);
      return restored.p2.pokemon.find((pokemon) => pokemon.set === restored.p2.team[0])!;
    };
    const fled = every(from, { p1: move(0), p2: switchTo(1) }, (outcome) => {
      const order = outcome.log.findIndex((line) => line.startsWith('|move|p1a: Monferno|Pursuit|'));
      expect(order).toBeGreaterThanOrEqual(0);
      expect(order).toBeLessThan(outcome.log.findIndex((line) => line.startsWith('|switch|p2a:')));
    }).map((outcome) => lead(from).hp - lead(outcome.state).hp);
    // Twice the power: twice the staying target's largest loss, less the formula's +2 (x2).
    expect(Math.max(...fled)).toBeGreaterThanOrEqual(2 * Math.max(...stay) - 6);
    expect(Math.max(...fled)).toBeLessThanOrEqual(2 * Math.max(...stay));
  });

  it('Pursuit\'s switch-out hit leaves a pending Micle Berry boost; a normal hit eats it', () => {
    const from = changed(pursuer(), (b) => { b.p1.active[0]!.addVolatile('micleberry'); });
    every(from, { p1: move(0), p2: switchTo(1) }, (outcome) => {
      expect(logged(outcome, '|-enditem|p1a: Monferno|Micle Berry')).toBe(false);
      expect(mine(outcome).volatiles).toHaveProperty('micleberry');
    });
    every(from, BOTH_FIRST, (outcome) => expect(logged(outcome, '|-enditem|p1a: Monferno|Micle Berry')).toBe(true));
  });

  it('the hack\'s Rage is a Fighting Pursuit: on a switching target it uses Rage, not Showdown\'s Pursuit', () => {
    const from = start(monferno([ID.rage], armored), [zigzagoon([ID.growl]), zigzagoon([ID.growl])], ABILITY.battleArmor);
    every(from, { p1: move(0), p2: switchTo(1) }, (outcome) =>
      expect([logged(outcome, '|move|p1a: Monferno|Rage|'), logged(outcome, '|move|p1a: Monferno|Pursuit|')]).toEqual([true, false]));
  });

  it('Pursuit hits a U-turn user before its switch-in is chosen; knocked out, it is replaced at the turn\'s end', () => {
    const from = changed(start(bulky([ID.pursuit]), [resolvedMon(ID.monferno, 30, [ID.uTurn]), zigzagoon([ID.growl])]), slowP1);
    every(from, BOTH_FIRST, (outcome) => {
      const [turn, hit] = ['|move|p2a: Monferno|U-turn|', '|move|p1a: Deoxys|Pursuit|'].map((prefix) => outcome.log.findIndex((line) => line.startsWith(prefix)));
      expect(hit).toBeGreaterThan(turn!);
      expect(logged(outcome, '|switch|')).toBe(false);
      expect(outcome.state.phase.kind).toBe(foe(outcome).hp === 0 ? 'enemyReplacement' : 'enemyMidTurnSwitch');
    });
  });

  it('Pursuit always hits a switching target, by a switch or a U-turn: no hit roll (subscript_pursuit.s:7-12)', () => {
    const powder = { item: ITEM.brightPowder }; // lowers the hit rate, so a staying target draws a hit roll
    const from = start(monferno([ID.pursuit], armored), [deoxys([ID.howl], powder), deoxys([ID.howl])], ABILITY.battleArmor);
    expect(hasLabel(expandTurn(from, BOTH_FIRST), 'hit', 'pursuit')).toBe(true);
    const fled = every(from, { p1: move(0), p2: switchTo(1) }, (outcome) => expect(logged(outcome, '|-miss|')).toBe(false));
    expect(hasLabel(fled, 'hit')).toBe(false);
    const uturn = changed(start(bulky([ID.pursuit]), [resolvedMon(ID.monferno, 30, [ID.uTurn], powder), zigzagoon([ID.growl])]), slowP1);
    const turned = every(uturn, BOTH_FIRST, (outcome) => expect(logged(outcome, '|move|p1a: Deoxys|Pursuit|')).toBe(true));
    expect(hasLabel(turned, 'hit', 'pursuit')).toBe(false);
  });
});

describe('protection, switching and trapping', () => {
  it('Protect blocks; used again next turn it succeeds for half of the draws (bs:5128-5133)', () => {
    const first = expandTurn(start(weak([ID.tackle]), deoxys([ID.protect, ID.growl])), BOTH_FIRST);
    expect(first).toHaveLength(1);
    expect(foe(first[0]!).hp).toBe(foe(first[0]!).maxhp);
    const second = expandTurn(first[0]!.state, BOTH_FIRST);
    expect(chanceOf(second, (outcome) => outcome.labels.some((label) => label.kind === 'protect' && label.outcome === 'success'))).toEqual(rat(0x7fff + 1, 65536));
  });

  it('a missed roll into Protect shows "protected itself", not a miss (subscript_missed.s)', () => {
    const outcomes = every(start(weak([ID.megaKick]), deoxys([ID.protect])), BOTH_FIRST, (outcome) => {
      expect(logged(outcome, '|-miss|')).toBe(false);
      expect(outcome.log.some((line) => line.startsWith('|-activate|p2a: Deoxys|') && line.includes('Protect'))).toBe(true);
    });
    expect(hasLabel(outcomes, 'hit')).toBe(false);
  });

  it('Substitute costs max HP / 4 and blocks a status move', () => {
    const [subbed] = expandTurn(start(bulky([ID.substitute]), deoxys([ID.meanLook, ID.thunderWave])), BOTH_FIRST);
    expect(mine(subbed!).maxhp - mine(subbed!).hp).toBe(Math.floor(mine(subbed!).maxhp / 4));
    every(subbed!.state, { p1: move(0), p2: move(1) }, (outcome) => expect(mine(outcome).status).toBe(''));
  });

  it('U-turn hits, then its user switches out (a mid-turn switch decision)', () => {
    phase(expandTurn(start([monferno([ID.uTurn]), monferno([ID.growl])], zigzagoon([ID.growl])), BOTH_FIRST), 'playerMidTurnSwitch');
  });

  describe('Baton Pass', () => {
    const passer = (change: (b: Battle) => void) => changed(start([weak([ID.batonPass]), weak([ID.growl])], deoxys([ID.howl])), change);
    it('passes stat stages', () => {
      const mid = phase(expandTurn(passer((b) => { b.p1.active[0]!.boosts.atk = 2; }), BOTH_FIRST), 'playerMidTurnSwitch');
      expect(mine(step(mid, { p1: switchTo(1) })).boosts.atk).toBe(2);
    });
    it('does not pass a pending Micle Berry boost (bl:2101-2114)', () => {
      const mid = phase(expandTurn(passer((b) => { b.p1.active[0]!.addVolatile('micleberry'); }), BOTH_FIRST), 'playerMidTurnSwitch');
      every(mid, { p1: switchTo(1) }, (outcome) => expect(mine(outcome).volatiles).not.toHaveProperty('micleberry'));
    });
    it('leaves binding behind: the replacement is neither trapped nor chipped (bl:2075)', () => {
      const from = start([bulky([ID.batonPass, ID.growl]), bulky([ID.growl])], little([ID.wrap, ID.growl]));
      const bound = expandTurn(from, SECOND).find((outcome) => 'partiallytrapped' in mine(outcome).volatiles);
      expect(bound).toBeDefined();
      const mid = phase(expandTurn(bound!.state, { p1: move(0), p2: move(1) }), 'playerMidTurnSwitch');
      every(mid, { p1: switchTo(1) }, (outcome) => {
        expect(mine(outcome).volatiles).not.toHaveProperty('partiallytrapped');
        expect(outcome.log.some((line) => line.startsWith('|-damage|p1a:') && line.includes('[partiallytrapped]'))).toBe(false);
        expect(canSwitch(outcome.state, 'p1')).toBe(true);
      });
    });
  });

  it('Mean Look and Block trap; the trap passes with either side\'s Baton Pass and ends when the trapper switches (bl:2055-2061)', () => {
    const from = start([bulky([ID.block, ID.batonPass, ID.growl]), bulky([ID.growl])], [deoxys([ID.growl, ID.batonPass]), deoxys([ID.growl])]);
    const trapped = step(from, BOTH_FIRST);
    expect(canSwitch(trapped, 'p2')).toBe(false);
    const foePass = phase(expandTurn(trapped, { p1: move(2), p2: move(1) }), 'enemyMidTurnSwitch');
    expect(canSwitch(step(foePass, { p2: switchTo(1) }), 'p2')).toBe(false);
    expect(canSwitch(step(trapped, { p1: switchTo(1), p2: move(0) }), 'p2')).toBe(true);
    const ownPass = phase(expandTurn(trapped, { p1: move(1), p2: move(0) }), 'playerMidTurnSwitch');
    expect(canSwitch(step(ownPass, { p1: switchTo(1) }), 'p2')).toBe(false);
  });

  it('Roar and Whirlwind run Showdown\'s Roar with the engine\'s target pick', () => {
    const outcomes = expandTurn(start(weak([ID.whirlwind]), [1, 2, 3].map(() => zigzagoon([ID.growl]))), BOTH_FIRST);
    expect(hasLabel(outcomes, 'switchTarget', 'whirlwind')).toBe(true);
  });

  it('Fake Out flinches on its user\'s first turn out (after a bag item or a mid-turn switch-in too) and fails after (bl:2117)', () => {
    const noFlinch = (outcome: Outcome) => expect(logged(outcome, '|cant|p1a: Monferno|flinch')).toBe(false);
    const first = every(start(monferno([ID.growl]), little([ID.fakeOut, ID.growl])), BOTH_FIRST,
      (outcome) => expect(logged(outcome, '|cant|p1a: Monferno|flinch')).toBe(true));
    expect(hasLabel(first, 'effect')).toBe(false); // ROM chance 100: sure, no draw
    every(first[0]!.state, BOTH_FIRST, noFlinch);
    // A bag item on the first turn still uses it up.
    const bagged = changed(start(monferno([ID.growl]), little([ID.fakeOut]), undefined, BAG.potions), (b) => { b.p2.active[0]!.hp -= 5; });
    const item = legalChoices(bagged, 'p2').find((choice) => choice.kind === 'item');
    expect(item).toBeDefined();
    const [used] = expandTurn(bagged, { p1: move(0), p2: item! });
    expect(logged(used!, '|move|p2a: Zigzagoon|')).toBe(false);
    every(used!.state, BOTH_FIRST, noFlinch);
    // Brought in by the trainer's U-turn, it works next turn.
    const mid = phase(expandTurn(start(monferno([ID.growl]), [resolvedMon(ID.deoxys, 50, [ID.uTurn]), little([ID.fakeOut, ID.growl])]), BOTH_FIRST), 'enemyMidTurnSwitch');
    const next = every(step(mid, { p2: switchTo(1) }), BOTH_FIRST, (outcome) => expect(logged(outcome, '|cant|p1a: Monferno|flinch')).toBe(true));
    every(next[0]!.state, BOTH_FIRST, noFlinch);
  });
});

describe('the field', () => {
  it('Stealth Rock, one layer of Spikes (max HP / 8 each) and Toxic Spikes (poison) hit a neutral switch-in', () => {
    for (const id of [ID.stealthRock, ID.spikes, ID.toxicSpikes]) {
      const laid = step(start(bulky([id, ID.growl]), [zigzagoon([ID.growl]), zigzagoon([ID.growl])]), BOTH_FIRST);
      const incoming = foe(step(laid, { p1: move(1), p2: switchTo(1) }));
      if (id === ID.toxicSpikes) expect(incoming.status).toBe('psn');
      else expect(incoming.maxhp - incoming.hp).toBe(Math.floor(incoming.maxhp / 8));
    }
  });

  it('Spikes at 2 and 3 layers take max HP / 6 and / 4; two layers of Toxic Spikes badly poison (bs:5425-5440)', () => {
    const team = [1, 2, 3, 4].map(() => zigzagoon([ID.growl]));
    const chip = (state: EngineState) => foe(state).maxhp - foe(state).hp;
    let state = step(step(start(bulky([ID.spikes, ID.growl]), team), BOTH_FIRST), BOTH_FIRST);
    state = step(state, { p1: move(1), p2: switchTo(1) });
    expect(chip(state)).toBe(Math.floor(foe(state).maxhp / 6));
    state = step(step(state, BOTH_FIRST), { p1: move(1), p2: switchTo(2) });
    expect(chip(state)).toBe(Math.floor(foe(state).maxhp / 4));
    const toxic = step(step(step(start(bulky([ID.toxicSpikes, ID.growl]), team), BOTH_FIRST), BOTH_FIRST), { p1: move(1), p2: switchTo(1) });
    expect(foe(toxic).status).toBe('tox');
  });

  it('Stealth Rock: a Rock-weak switch-in loses max HP / 4, a resistant one max HP / 16 (bs:8302-8340)', () => {
    const team = [zigzagoon([ID.growl]), resolvedMon(ID.charmander, 20, [ID.growl]), resolvedMon(ID.machop, 20, [ID.growl])];
    const laid = step(start(bulky([ID.stealthRock, ID.growl]), team), BOTH_FIRST);
    for (const [slot, species, share] of [[1, 'charmander', 4], [2, 'machop', 16]] as const) {
      const after = foe(step(laid, { p1: move(1), p2: switchTo(slot) }));
      expect([after.species.id, after.maxhp - after.hp]).toEqual([species, Math.floor(after.maxhp / share)]);
    }
  });

  it('Reflect halves a physical hit, Light Screen a special one, for five turns', () => {
    for (const [id, attack, condition] of [[ID.reflect, ID.plainHit, 'reflect'], [ID.lightScreen, ID.fireBall, 'lightscreen']] as const) {
      const from = start(monferno([attack], armored), deoxys([id, ID.howl]), ABILITY.battleArmor);
      const plain = Math.max(...distinctLosses(from, expandTurn(from, { p1: move(0), p2: move(1) })));
      const screenedTurn = expandTurn(from, BOTH_FIRST);
      const screened = Math.max(...distinctLosses(from, screenedTurn));
      // Halved before the formula's +2 and the modifiers: about half, a little more.
      expect(screened).toBeGreaterThanOrEqual(Math.floor(plain / 2));
      expect(screened).toBeLessThanOrEqual(Math.ceil(plain / 2) + 3);
      expect(restore(screenedTurn[0]!.state).p2.sideConditions[condition]!['duration']).toBe(4);
    }
  });

  it('a crit goes through Reflect: the same damage as without it (bl:6982-6984)', () => {
    const from = start(monferno([ID.plainHit]), deoxys([ID.reflect, ID.howl]));
    const screened = crits(expandTurn(from, BOTH_FIRST));
    expect(screened.length).toBeGreaterThan(0);
    expect(distinctLosses(from, screened)).toEqual(distinctLosses(from, crits(expandTurn(from, { p1: move(0), p2: move(1) }))));
  });

  it('Brick Break breaks the screens on a hit and ignores them in it; a miss leaves them (effect_script_0186.s)', () => {
    // BrightPowder makes misses possible; Deoxys sets Reflect before Monferno moves.
    const from = start(monferno([ID.brickBreak], armored), deoxys([ID.reflect, ID.howl], { item: ITEM.brightPowder }), ABILITY.battleArmor);
    const outcomes = expandTurn(from, BOTH_FIRST);
    const hits = outcomes.filter((outcome) => !logged(outcome, '|-miss|'));
    const misses = outcomes.filter((outcome) => logged(outcome, '|-miss|'));
    expect([hits.length > 0, misses.length > 0]).toEqual([true, true]);
    for (const outcome of hits) expect(restore(outcome.state).p2.sideConditions).not.toHaveProperty('reflect');
    for (const outcome of misses) expect(restore(outcome.state).p2.sideConditions).toHaveProperty('reflect');
    const open = expandTurn(from, { p1: move(0), p2: move(1) }).filter((outcome) => !logged(outcome, '|-miss|'));
    expect(distinctLosses(from, hits)).toEqual(distinctLosses(from, open));
  });

  it('the weather moves set five turns of their weather; Hail under a permanent hail starts five turns (effect_script_0164.s:5)', () => {
    for (const [id, weather] of [[ID.rainDance, 'raindance'], [ID.sunnyDay, 'sunnyday'], [ID.sandstorm, 'sandstorm'], [ID.hail, 'hail']] as const) {
      const field = restore(step(start(bulky([id]), deoxys([ID.growl])), BOTH_FIRST)).field;
      expect([field.weather, field.weatherState.duration]).toEqual([weather, 4]); // one turn gone at this turn's end
    }
    const permanent = changed(start(bulky([ID.hail]), deoxys([ID.growl])), (b) => {
      b.field.setWeather('hail', b.p2.active[0]!);
      b.field.weatherState.duration = 0;
    });
    expect(restore(step(permanent, BOTH_FIRST)).field.weatherState.duration).toBe(4);
  });

  it('Trick Room makes the slower Pokémon move first from the next turn, Tailwind doubles its side\'s Speed; mid-turn Trick Room re-sorts nothing', () => {
    const order = (outcome: Outcome) => outcome.log.filter((line) => line.startsWith('|move|')).map((line) => line.split('|')[2]);
    const bidoof = (moves: number[]) => resolvedMon(ID.bidoof, 20, moves); // Monferno (Speed 62) outspeeds Bidoof (53)
    const room = step(start(monferno([ID.trickRoom, ID.growl]), bidoof([ID.growl])), BOTH_FIRST);
    expect(order(expandTurn(room, SECOND)[0]!)).toEqual(['p2a: Bidoof', 'p1a: Monferno']);
    const wind = step(start(monferno([ID.growl]), bidoof([ID.tailwind, ID.growl])), BOTH_FIRST);
    expect(order(expandTurn(wind, { p1: move(0), p2: move(1) })[0]!)).toEqual(['p2a: Bidoof', 'p1a: Monferno']);
    // Used mid-turn it leaves the other Pokémon to move next, with no draw (bl:7276-7302).
    const outcomes = expandTurn(start(monferno([ID.trickRoom]), bidoof([ID.growl])), BOTH_FIRST);
    expect(outcomes).toHaveLength(1);
    expect([order(outcomes[0]!), labels(outcomes)]).toEqual([['p1a: Monferno', 'p2a: Bidoof'], []]);
  });

  it('Gravity from the move is set (with no end: field.test.ts)', () => {
    expect(restore(step(start(bulky([ID.gravity]), deoxys([ID.growl])), BOTH_FIRST)).field.pseudoWeather['gravity']).toBeDefined();
  });

  it('"Always hits in Hail": no roll in hail; Sheer Cold (ROM chance 100) always freezes, Ice Ball (0) never, Blizzard at 20', () => {
    // The foe moves first, so no thaw roll follows the freeze.
    const from = changed(start(bulky([ID.sheerCold, ID.iceBall, ID.blizzard]), deoxys([ID.growl]), ABILITY.battleArmor),
      (b) => { b.field.setWeather('hail', b.p1.active[0]!); slowP1(b); });
    const cold = every(from, BOTH_FIRST, (outcome) => expect(foe(outcome).status).toBe('frz'));
    expect(hasLabel(cold, 'hit') || hasLabel(cold, 'effect')).toBe(false);
    every(from, SECOND, (outcome) => expect(foe(outcome).status).toBe(''));
    const blizzard = expandTurn(from, { p1: move(2), p2: move(0) });
    expect(chanceOf(blizzard, (outcome) => foe(outcome).status === 'frz')).toEqual(rat(Number(belowWeight(100, 20)), 65536));
  });

  it('in rain, Thunder paralyses and Hurricane confuses at the ROM\'s 30 (docs: 10), with no hit roll', () => {
    const from = changed(start(bulky([ID.thunder, ID.hurricane]), deoxys([ID.growl]), ABILITY.battleArmor), (b) => b.field.setWeather('raindance', b.p1.active[0]!));
    const chance = rat(Number(belowWeight(100, 30)), 65536);
    const thunder = expandTurn(from, BOTH_FIRST);
    const hurricane = expandTurn(from, SECOND);
    expect([hasLabel(thunder, 'hit'), hasLabel(hurricane, 'hit')]).toEqual([false, false]);
    expect(chanceOf(thunder, (outcome) => foe(outcome).status === 'par')).toEqual(chance);
    expect(chanceOf(hurricane, (outcome) => 'confusion' in foe(outcome).volatiles)).toEqual(chance);
  });
});

describe('status, HP and stats', () => {
  it('Torment blocks the last move twice in a row; Disable disables the last move', () => {
    expect(legalChoices(step(start(bulky([ID.torment]), deoxys([ID.growl, ID.meanLook])), BOTH_FIRST), 'p2')).toEqual([move(1)]);
    // The faster Deoxys used Growl, then Disable hit it.
    expect(legalChoices(runFirstOutcome(start(weak([ID.encore, ID.disable]), deoxys([ID.growl, ID.meanLook])), SECOND), 'p2')).toEqual([move(1)]);
  });

  it('Rest heals fully and sleeps for exactly two turns (a known counter of 3)', () => {
    const rested = mine(step(changed(start(bulky([ID.rest, ID.growl]), deoxys([ID.growl])), setHp('p1', 10)), BOTH_FIRST));
    expect([rested.hp, rested.status, rested.statusState['time']]).toEqual([rested.maxhp, 'slp', 3]);
  });

  it('Pain Split averages the two HP values', () => {
    const from = changed(start(bulky([ID.painSplit]), deoxys([ID.growl])), setHp('p1', 11));
    const after = step(from, BOTH_FIRST);
    const average = Math.floor((11 + foe(from).hp) / 2);
    expect([mine(after).hp, foe(after).hp]).toEqual([average, average]);
  });

  it('Perish Song: three turns later both Pokémon faint', () => {
    let state = step(start([bulky([ID.perishSong, ID.growl]), bulky([ID.growl])], [deoxys([ID.growl]), deoxys([ID.growl])]), BOTH_FIRST);
    for (let turn = 0; turn < 3; turn++) state = step(state, SECOND);
    expect(state.phase.kind).toBe('playerReplacement');
  });

  it('Belly Drum costs half the max HP and maximises Attack; Haze clears every stat stage', () => {
    const drum = step(start(bulky([ID.bellyDrum, ID.haze]), deoxys([ID.howl])), BOTH_FIRST);
    expect([mine(drum).boosts.atk, mine(drum).maxhp - mine(drum).hp]).toEqual([6, Math.floor(mine(drum).maxhp / 2)]);
    expect(mine(step(drum, SECOND)).boosts.atk).toBe(0);
  });

  it('Curse: a non-Ghost user gets Atk and Def +1, Spe -1; a Ghost pays half its max HP and its target loses a quarter (effect_script_0109.s)', () => {
    expect(mine(step(start(bulky([ID.curse]), deoxys([ID.howl])), BOTH_FIRST)).boosts).toMatchObject({ atk: 1, def: 1, spe: -1 });
    const ghost = start(playerMon(ID.giratina, 50, [ID.curse]), deoxys([ID.howl]), ABILITY.battleArmor);
    const cursed = step(ghost, BOTH_FIRST);
    expect(mine(ghost).hp - mine(cursed).hp).toBe(Math.floor(mine(ghost).maxhp / 2));
    expect(foe(cursed).volatiles).toHaveProperty('curse');
    expect(foe(ghost).hp - foe(cursed).hp).toBe(Math.floor(foe(ghost).maxhp / 4));
  });

  it('fixed damage: Seismic Toss the level, Dragon Rage 40, Super Fang half the current HP, Endeavor down to the user\'s HP', () => {
    const from = start(monferno([ID.seismicToss, ID.dragonRage, ID.superFang, ID.endeavor], armored), deoxys([ID.growl]), ABILITY.battleArmor);
    const lostBy = (slot: number) => distinctLosses(from, expandTurn(from, { p1: move(slot), p2: move(0) }));
    expect([lostBy(0), lostBy(1), lostBy(2)]).toEqual([new Set([30]), new Set([40]), new Set([Math.floor(foe(from).hp / 2)])]);
    every(changed(from, setHp('p1', 20)), { p1: move(3), p2: move(0) }, (outcome) => expect(foe(outcome).hp).toBe(20));
  });

  it('a one-hit KO move deals the target\'s current HP (bs:4378), so a substitute with more HP survives it', () => {
    const from = changed(start(playerMon(ID.deoxys, 50, [ID.guillotine]), zigzagoon([ID.growl])), (b) => {
      const target = b.p2.active[0]!;
      target.hp = 5;
      target.addVolatile('substitute');
      target.volatiles['substitute']!['hp'] = 20;
    });
    const hits = expandTurn(from, BOTH_FIRST).filter((outcome) => !logged(outcome, '|-miss|'));
    expect(hits.length).toBeGreaterThan(0);
    for (const outcome of hits) expect(foe(outcome).volatiles['substitute']?.['hp']).toBe(15);
  });

  it('Follow Me succeeds in singles, where it changes nothing (bs:6261-6290)', () => {
    const [outcome] = expandTurn(start(bulky([ID.followMe]), deoxys([ID.growl])), BOTH_FIRST);
    expect([logged(outcome!, '|-singleturn|p1a: Deoxys|move: Follow Me'), logged(outcome!, '|-fail|')]).toEqual([true, false]);
  });

  it('Roost heals half the max HP; Synthesis half, 2/3 in sun and a quarter in other weather, rounded down', () => {
    const healed = (id: number, weather?: string) => {
      const from = changed(start(bulky([id]), deoxys([ID.growl])), (b) => {
        b.p1.active[0]!.hp = 1;
        if (weather) b.field.setWeather(weather, b.p1.active[0]!);
      });
      return mine(step(from, BOTH_FIRST)).hp - 1;
    };
    const maxhp = mine(start(bulky([ID.roost]), deoxys([ID.growl]))).maxhp;
    expect([healed(ID.roost), healed(ID.synthesis), healed(ID.synthesis, 'sunnyday'), healed(ID.synthesis, 'raindance')])
      .toEqual([Math.floor(maxhp / 2), Math.floor(maxhp / 2), Math.floor((maxhp * 20) / 30), Math.floor(maxhp / 4)]);
  });

  it('Wish heals the slot\'s Pokémon half its own max HP at the next turn\'s end (bcp:1086-1104); another recipient is noted', () => {
    const wished = step(changed(start([bulky([ID.wish, ID.growl]), weak([ID.growl])], deoxys([ID.howl])), setHp('p1', 10)), BOTH_FIRST);
    const healed = step(wished, SECOND);
    expect(mine(healed).hp).toBe(10 + Math.floor(mine(healed).maxhp / 2));
    expect(engine.unmodelledIn(healed)).not.toContain(WISH_RECIPIENT_NOTE);
    const swapped = step(wished, { p1: switchTo(1), p2: move(0) });
    expect(mine(swapped).species.id).toBe('zigzagoon');
    expect(engine.unmodelledIn(swapped)).toContain(WISH_RECIPIENT_NOTE);
  });

  it('Acupressure raises one stat below +6 by 2, picked as RandNext() % count (bs:8932-8960)', () => {
    const from = changed(start(bulky([ID.acupressure]), deoxys([ID.howl])), (b) => { b.p1.active[0]!.boosts.def = 6; });
    const outcomes = expandTurn(from, BOTH_FIRST);
    expect(outcomes.some((outcome) => outcome.unlabelled)).toBe(false);
    expect(hasLabel(outcomes, 'pick', 'acupressure')).toBe(true);
    expect(['atk', 'spe', 'spa', 'spd', 'accuracy', 'evasion'].map((stat) => chanceOf(outcomes, (outcome) => mine(outcome).boosts[stat as BoostID] === 2)))
      .toEqual(residueWeights(6).map((weight) => rat(Number(weight), 65536)));
  });

  it('Assist calls another party member\'s move, picked as RandNext() % count, never an invoker (bs:6405-6450)', () => {
    const outcomes = expandTurn(start([bulky([ID.assist]), bulky([ID.tackle, ID.metronome, ID.growl]), bulky([ID.ember])], deoxys([ID.howl])), BOTH_FIRST);
    expect(outcomes.some((outcome) => outcome.unlabelled)).toBe(false);
    const used = (name: string) => chanceOf(outcomes, (outcome) => logged(outcome, `|move|p1a: Deoxys|${name}|`));
    expect(['Tackle', 'Growl', 'Ember', 'Metronome'].map(used)).toEqual([...residueWeights(3).map((weight) => rat(Number(weight), 65536)), ZERO]);
  });

  it('Psych Up also copies Focus Energy, keeping the user\'s own (bs:6042-6050)', () => {
    const critChance = (outcomes: Outcome[]) => chanceOf(outcomes, (outcome) => crits([outcome]).length > 0);
    const copied = step(changed(start(bulky([ID.psychUp, ID.tackle]), deoxys([ID.growl])), (b) => { b.p2.active[0]!.addVolatile('focusenergy'); }), BOTH_FIRST);
    expect(mine(copied).volatiles).toHaveProperty('focusenergy');
    expect(critChance(expandTurn(copied, SECOND))).toEqual(rat(Number(residueWeights(4)[0]), 65536));
    const own = changed(start(bulky([ID.psychUp]), deoxys([ID.growl])), (b) => { b.p1.active[0]!.addVolatile('focusenergy'); });
    expect(mine(step(own, BOTH_FIRST)).volatiles).toHaveProperty('focusenergy');
  });

  it('Rivalry never raises a genderless Pokémon\'s confused self-hit (bl:6901-6906)', () => {
    const selfHits = (ability: number) => {
      const from = changed(start(bulky([ID.growl], { ability: knownAbility(ability), gender: null }), deoxys([ID.howl])), (b) => { b.p1.active[0]!.addVolatile('confusion'); });
      expect(mine(from).gender).toBe(''); // Showdown's genderless, not 'N'
      const hit = expandTurn(from, BOTH_FIRST).filter((outcome) => outcome.log.some((line) => line.startsWith('|-damage|p1a:') && line.includes('[from] confusion')));
      expect(hit.length).toBeGreaterThan(0);
      return new Set(hit.map((outcome) => lost(from, outcome.state, 'p1')));
    };
    expect(selfHits(ABILITY.rivalry)).toEqual(selfHits(ABILITY.battleArmor));
  });

  it('BrightPowder and Lax Incense take the ROM\'s parameter (11) off the hit rate (bcp:2949-2954)', () => {
    for (const item of [ITEM.brightPowder, ITEM.laxIncense]) {
      expect(itemEffect(item)!.param).toBe(11);
      const restored = restore(start(monferno([ID.megaKick]), deoxys([ID.growl], { item })));
      expect(engine.cartridgeHitRate(restored.p1.active[0]!, restored.p2.active[0]!, restored.dex.getActiveMove(idOf(ID.megaKick)), restored)).toBe(Math.floor((90 * 89) / 100));
    }
  });
});

describe('Bug Bite', () => {
  it('eats the target\'s berry, but not through a substitute, broken or not (bs:8116-8143; bcp:3371)', () => {
    const from = start(monferno([ID.bugBite], armored), deoxys([ID.growl], { item: ITEM.sitrusBerry }), ABILITY.battleArmor);
    every(from, BOTH_FIRST, (outcome) => expect(foe(outcome).item).toBe(''));
    every(changed(from, (b) => { b.p2.active[0]!.addVolatile('substitute'); }), BOTH_FIRST, (outcome) => {
      expect(foe(outcome).volatiles).toHaveProperty('substitute');
      expect(foe(outcome).item).toBe('sitrusberry');
      expect(outcome.log.some((line) => line.includes('[from] stealeat'))).toBe(false);
    });
    const frail = changed(from, (b) => {
      b.p2.active[0]!.addVolatile('substitute');
      b.p2.active[0]!.volatiles['substitute']!['hp'] = 1;
    });
    every(frail, BOTH_FIRST, (outcome) => expect(['substitute' in foe(outcome).volatiles, foe(outcome).item]).toEqual([false, 'sitrusberry']));
  });

  it('the player\'s own substitute keeps his berry against the trainer\'s Bug Bite, and the carry keeps it', () => {
    const from = changed(start(bulky([ID.growl], { item: ITEM.sitrusBerry }), deoxys([ID.bugBite])), (b) => { b.p1.active[0]!.addVolatile('substitute'); });
    every(from, BOTH_FIRST, (outcome) => expect([mine(outcome).item, carryOut(outcome.state).mons[0]!.item]).toEqual(['sitrusberry', ITEM.sitrusBerry]));
  });
});

describe('cartridge details', () => {
  it('ROM flags: Protect, Magic Coat, Snatch and Mirror Move from the ROM bits; punch, sound, heal and Encore from the move-ID lists', () => {
    const rows: [number, string, number | undefined][] = [
      [ID.meanLook, 'protect', 1], [ID.meanLook, 'reflectable', 1], [ID.meanLook, 'mirror', 1], // ROM flags 22
      [ID.wish, 'snatch', undefined], [ID.howl, 'snatch', 1], [ID.howl, 'mirror', undefined],
      [ID.wrap, 'contact', 1], [ID.wrap, 'protect', 1], [ID.wrap, 'mirror', 1], // an inherited move takes them too
      [ID.focusPunch, 'punch', 1], [ID.hammerArm, 'punch', 1], [ID.skyAttack, 'punch', undefined], // sPunchingMoves
      [ID.growl, 'sound', 1], [ID.perishSong, 'sound', 1], [ID.unblockable, 'sound', undefined], [ID.roar, 'sound', 1],
      [ID.whirlwind, 'sound', undefined], // it runs Showdown's Roar, a sound move
      [ID.lunarDance, 'heal', 1], [ID.rest, 'heal', 1], [ID.tackle, 'gravity', undefined],
      [ID.struggle, 'failencore', 1], [ID.metronome, 'failencore', undefined], // sCannotEncoreMoves goes by ROM effect
    ];
    expect(rows.map(([id, flag]) => [id, flag, (dexMove(id).flags as Record<string, number | undefined>)[flag]])).toEqual(rows);
    const tackle = installedMoves().get(ID.tackle)!;
    const flagsOf = (kaizo: typeof tackle) => (showdownMoveData(kaizo) as { flags: Record<string, number> }).flags;
    expect(flagsOf({ ...tackle, romEffect: installedMoves().get(ID.struggle)!.romEffect })['failencore']).toBe(1);
    expect(flagsOf(tackle)['failencore']).toBeUndefined();
  });

  it('Imprison after its user\'s foe fainted this turn reads the fainted foe\'s moves (battle_script.c:6699-6719)', () => {
    const from = start(bulky([ID.imprison, ID.explosion]), [resolvedMon(ID.monferno, 30, [ID.explosion]), little([ID.explosion, ID.growl])]);
    every(changed(from, slowP1), BOTH_FIRST, (outcome) => expect(mine(outcome).volatiles).toHaveProperty('imprison'));
  });

  it('Minimize leaves the marker Stomp reads, and Stomp doubles its power on it (effect_script_0150.s:6-8)', () => {
    const minimized = step(start(bulky([ID.growl]), deoxys([ID.minimize])), BOTH_FIRST);
    expect(foe(minimized).volatiles).toHaveProperty('minimize');
    expect(foe(minimized).boosts.evasion).toBe(2);
    const restored = restore(minimized);
    const stomp = restored.dex.getActiveMove(idOf(ID.stomp));
    const power = () => stomp.basePowerCallback!.call(restored, restored.p1.active[0]!, restored.p2.active[0]!, stomp);
    expect(power()).toBe(180);
    delete restored.p2.active[0]!.volatiles['minimize'];
    expect(power()).toBe(90);
  });

  it('Giratina-Origin without a Griseous Orb is Altered once it is out (bl:6412-6417)', () => {
    const origin = (fields: Partial<ResolvedMon>) => resolvedMon(ID.giratina, 50, [ID.growl], { form: 1, ability: knownAbility(ABILITY.levitate), ...fields });
    const bare = foe(start(bulky([ID.growl]), origin({})));
    expect([bare.species.id, bare.ability]).toEqual(['giratina', 'pressure']);
    expect(foe(start(bulky([ID.growl]), origin({ item: ITEM.griseousOrb }))).species.id).toBe('giratinaorigin');
  });

  it('White Herb restores a stage a battle-start Intimidate lowered, before anyone moves (bl:4152-4160)', () => {
    const herb = () => monferno([ID.growl], { item: ITEM.whiteHerb });
    const from = start(herb(), zigzagoon([ID.growl]), ABILITY.intimidate);
    expect([mine(from).boosts.atk, mine(from).item]).toEqual([0, '']);
    expect(engine.battleStartLog(from).some((line) => line.startsWith('|-enditem|p1a: Monferno|White Herb'))).toBe(true);
    expect(engine.unmodelledIn(from)).toEqual([]);
    expect(mine(start(herb(), zigzagoon([ID.growl]))).item).toBe('whiteherb');
  });

  it('Last Resort by a Pokémon that knows a move caller is noted (bl:3443-3458)', () => {
    const used = (moves: number[]) => changed(start(bulky(moves), deoxys([ID.growl])), (b) => {
      for (const slot of b.p1.active[0]!.moveSlots) if (slot.id !== idOf(ID.lastResort)) slot.used = true;
    });
    every(used([ID.lastResort, ID.tackle, ID.metronome]), BOTH_FIRST, (outcome) => expect(engine.unmodelledIn(outcome.state)).toContain(LAST_RESORT_CALLER_NOTE));
    const plain = every(used([ID.lastResort, ID.tackle]), BOTH_FIRST, (outcome) => expect(engine.unmodelledIn(outcome.state)).toEqual([]));
    expect(plain.some((outcome) => logged(outcome, '|move|p1a: Deoxys|Last Resort|'))).toBe(true);
  });

  it('Last Resort counts afresh after its user switches out and back, by a switch or a Baton Pass (bl:2100-2114)', () => {
    const failsAfter = (out: (state: EngineState) => EngineState) => {
      const tackled = step(start([bulky([ID.lastResort, ID.tackle, ID.batonPass]), bulky([ID.growl, ID.batonPass])], deoxys([ID.growl])), SECOND);
      expect(restore(tackled).p1.active[0]!.moveSlots.find((slot) => slot.id === idOf(ID.tackle))!.used).toBe(true);
      const back = out(tackled);
      expect([mine(back).species.id, mine(back).moveSlots.map((slot) => slot.used)]).toEqual(['deoxys', [false, false, false]]);
      every(back, BOTH_FIRST, (outcome) => {
        expect(logged(outcome, '|move|p1a: Deoxys|Last Resort|')).toBe(true);
        expect(outcome.log.some((line) => line.startsWith('|-damage|p2a:'))).toBe(false);
      });
    };
    failsAfter((state) => step(step(state, { p1: switchTo(1), p2: move(0) }), { p1: switchTo(0), p2: move(0) }));
    const pass = (state: EngineState, slot: number, to: number) => step(phase(expandTurn(state, { p1: move(slot), p2: move(0) }), 'playerMidTurnSwitch'), { p1: switchTo(to) });
    failsAfter((state) => pass(pass(state, 2, 1), 1, 0));
  });
});

/** The power `id` has for the side's active against the other side's, in `state` after `change`. */
function powerOf(state: EngineState, id: number, change: (battle: Battle) => void = () => {}, side: 'p1' | 'p2' = 'p1'): number {
  const restored = restore(state);
  change(restored);
  const user = restored[side].active[0]!;
  const target = restored[side === 'p1' ? 'p2' : 'p1'].active[0]!;
  const active = restored.dex.getActiveMove(idOf(id));
  const power = active.basePowerCallback ? active.basePowerCallback.call(restored, user, target, active) as number : active.basePower;
  return restored.runEvent('BasePower', user, target, active, restored.clampIntRange(power, 1), true) as number;
}

describe('variable power (basePowerCallback, then the BasePower event)', () => {
  const versus = (moves: number[], fields: Partial<PlayerMon> = {}, theirs = deoxys([ID.growl])) => start(bulky(moves, fields), theirs);

  it('Flail: the HP-bar pixel bands out of 64 (bs:4940-4970); Water Spout: power x HP / max HP, at least 1 (bs:6645-6656)', () => {
    const flail = versus([ID.flail]);
    const maxhp = mine(flail).maxhp;
    const at = (from: EngineState, id: number, hp: number) => powerOf(from, id, setHp('p1', hp));
    const firstHpAt = (pixels: number) => Math.ceil((pixels * maxhp) / 64); // the least HP showing `pixels`
    expect([maxhp, 1, firstHpAt(42), firstHpAt(43)].map((hp) => at(flail, ID.flail, hp))).toEqual([20, 200, 40, 20]);
    const spout = versus([ID.waterSpout]);
    const third = Math.floor(maxhp / 3);
    expect([maxhp, third, 1].map((hp) => at(spout, ID.waterSpout, hp))).toEqual([150, Math.floor((150 * third) / maxhp), 1]);
  });

  it('Gyro Ball reads the stored monSpeedValues, not live Speed (bs:7123-7133)', () => {
    const from = versus([ID.gyroBall]); // two equally fast Deoxys: live Speed would give 26
    const at = (p1: number, p2: number, side: 'p1' | 'p2' = 'p1') => powerOf(from, ID.gyroBall, (b) => storeSpeedValues(b, { p1, p2 }), side);
    expect([at(50, 200), at(200, 50), at(30, 200), at(200, 50, 'p2')]).toEqual([101, 7, 150, 101]);
  });

  it('Low Kick and Grass Knot: the weight bands "at most" each bound, on the ROM\'s weights (weight_to_power.h)', () => {
    const against = (theirs: ResolvedMon, id: number = ID.lowKick) => powerOf(versus([ID.lowKick, ID.grassKnot], {}, theirs), id);
    const magikarp = () => resolvedMon(ID.magikarp, 20, [ID.growl]); // exactly 10.0 kg: Showdown's ">= 100 hg" gave 40
    expect([against(magikarp()), against(magikarp(), ID.grassKnot), against(deoxys([ID.growl])), against(resolvedMon(ID.giratina, 50, [ID.growl]), ID.grassKnot)])
      .toEqual([20, 20, 80, 120]);
  });

  it('Shaymin-Sky weighs Shaymin\'s 2.1 kg, its species ID\'s Pokédex entry (Showdown: 5.2)', () => {
    expect(Dex.mod(KAIZO_MOD).species.get('shayminsky').weightkg).toBe(2.1);
    const sky = start(bulky([ID.lowKick]), resolvedMon(ID.shaymin, 50, [ID.growl], { form: 1 }));
    expect([foe(sky).species.id, foe(sky).weighthg, powerOf(sky, ID.lowKick)]).toEqual(['shayminsky', 21, 20]);
  });

  it('Brine and the hack\'s Wring Out double at or below half the target\'s max HP (effect_script_0221.s)', () => {
    const from = versus([ID.brine, ID.wringOut]);
    const half = Math.floor(foe(from).maxhp / 2);
    const at = (id: number, hp: number) => powerOf(from, id, setHp('p2', hp));
    expect([at(ID.brine, half), at(ID.brine, half + 1), at(ID.wringOut, half), at(ID.wringOut, half + 1)]).toEqual([130, 65, 150, 75]);
  });

  it('Facade doubles for poison, paralysis or burn, never another status (Showdown doubled a frozen user\'s)', () => {
    const from = versus([ID.facade]);
    const at = (status: string) => powerOf(from, ID.facade, (b) => { b.p1.active[0]!.status = status as ID; });
    expect(['psn', 'tox', 'par', 'brn', '', 'slp', 'frz'].map(at)).toEqual([160, 160, 160, 160, 80, 80, 80]);
  });

  it('Punishment: 60 + 20 per raised stage of the target, at most 200 (bs:7354-7372)', () => {
    const from = versus([ID.punishment]);
    const at = (boosts: Partial<BoostsTable>) => powerOf(from, ID.punishment, (b) => { Object.assign(b.p2.active[0]!.boosts, boosts); });
    expect([at({}), at({ atk: 2, spe: 1, accuracy: 1, def: -2 }), at({ atk: 6, spa: 6 })]).toEqual([60, 140, 200]);
  });

  it('Payback and the hack\'s Revenge double once the target\'s action is done (bs:7198-7208)', () => {
    const from = versus([ID.payback, ID.revenge]);
    expect([powerOf(from, ID.payback), powerOf(from, ID.revenge)]).toEqual([120, 120]); // outside a turn: no action left
    // In a turn: the slower user's resisted Revenge is twice the faster one's, less the formula's +2.
    const resisted = start(monferno([ID.revenge]), deoxys([ID.growl]), ABILITY.battleArmor);
    const hit = (stage: number) => {
      const set = changed(resisted, (b) => { b.p1.active[0]!.boosts.spe = stage; });
      return Math.max(...distinctLosses(set, expandTurn(set, BOTH_FIRST)));
    };
    expect(hit(-6)).toBeGreaterThanOrEqual(2 * hit(6) - 6);
    expect(hit(-6)).toBeLessThanOrEqual(2 * hit(6));
  });

  /** A move's [type, power] after its ModifyType (and ModifyMove) events, in `state` after `change`. */
  const cast = (state: EngineState, id: number, change: (b: Battle) => void = () => {}) => {
    const restored = restore(state);
    change(restored);
    const [user, target] = [restored.p1.active[0]!, restored.p2.active[0]!];
    const active = restored.dex.getActiveMove(idOf(id));
    restored.singleEvent('ModifyType', active, null, user, target, active, active);
    restored.singleEvent('ModifyMove', active, null, user, target, active, active);
    return [active.type, active.basePowerCallback ? active.basePowerCallback.call(restored, user, target, active) : active.basePower];
  };

  it('Hidden Power takes its type and power from the IVs (bs:6007-6040)', () => {
    for (const ivs of [{ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, { hp: 30, atk: 2, def: 31, spa: 21, spd: 30, spe: 14 }]) {
      const expected = hiddenPower(ivs);
      expect(cast(versus([ID.hiddenPower], { ivs }), ID.hiddenPower)).toEqual([TYPE_NAMES[expected.type], expected.power]);
    }
  });

  it('Weather Ball: the ROM\'s type at base power without usable weather, doubled and typed by it (bs:6843-6872)', () => {
    const from = versus([ID.weatherBall]);
    const weather = (name: string, extra: (b: Battle) => void = () => {}) => (b: Battle) => { b.field.setWeather(name, b.p1.active[0]!); extra(b); };
    expect([cast(from, ID.weatherBall), cast(from, ID.weatherBall, weather('raindance')), cast(from, ID.weatherBall, weather('sandstorm')),
      cast(from, ID.weatherBall, weather('sunnyday', (b) => b.p2.active[0]!.setAbility('cloudnine')))]) // Cloud Nine: the move keeps its data
      .toEqual([['Normal', 50], ['Water', 100], ['Rock', 100], ['Normal', 50]]);
  });

  it('Trump Card: by the PP left after the use, 200 at none (bs:7233-7250)', () => {
    const from = versus([ID.trumpCard]);
    expect([0, 1, 2, 3, 4, 7].map((pp) => powerOf(from, ID.trumpCard, (b) => { b.p1.active[0]!.moveSlots[0]!.pp = pp; }))).toEqual([200, 80, 60, 50, 40, 40]);
  });

  it('SmellingSalt and Wake-Up Slap double on a paralysed or sleeping target, not through a substitute; the hit cures paralysis', () => {
    const from = versus([ID.smellingSalt, ID.wakeUpSlap]);
    const at = (id: number, status: string, sub: boolean) => powerOf(from, id, (b) => {
      b.p2.active[0]!.status = status as ID;
      if (sub) b.p2.active[0]!.addVolatile('substitute');
    });
    expect([at(ID.smellingSalt, 'par', false), at(ID.smellingSalt, 'par', true), at(ID.smellingSalt, '', false)]).toEqual([180, 90, 90]);
    expect([at(ID.wakeUpSlap, 'slp', false), at(ID.wakeUpSlap, 'slp', true), at(ID.wakeUpSlap, 'par', false)]).toEqual([120, 60, 60]);
    // A target left standing is cured (subscript_heal_target_paralysis.s: not at 0 HP).
    const standing = expandTurn(changed(from, (b) => { b.p2.active[0]!.setStatus('par'); }), BOTH_FIRST).filter((outcome) => foe(outcome).hp > 0);
    expect(standing.length).toBeGreaterThan(0);
    for (const outcome of standing) expect(foe(outcome).status).toBe('');
  });

  it('Present draws its pick; Return and Frustration stay plain 121-power hits', () => {
    expect(hasLabel(expandTurn(versus([ID.present]), BOTH_FIRST), 'pick', 'present')).toBe(true);
    expect([dexMove(ID.return).basePower, dexMove(ID.frustration).basePower]).toEqual([121, 121]);
  });
});

/** docs/engine-model.md's unmodelled list: each effect text's moves (the real data's) and reason. */
function documentedUnmodelled(): Map<string, { moves: string[]; reason: string }> {
  const doc = readFileSync('docs/engine-model.md', 'utf8');
  const section = doc.slice(doc.indexOf('<!-- unmodelled-list: start -->'), doc.indexOf('<!-- unmodelled-list: end -->'));
  const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Effect text'));
  return new Map(rows.map((row) => {
    const [text, moves, reason] = row.slice(2, -2).split(' | ');
    return [normaliseEffectText(text!), { moves: moves!.split(', '), reason: reason! }];
  }));
}

describe('the unmodelled list and unmodelledIn', () => {
  it('Metronome calling a move the engine doesn\'t model is noted in that outcome', () => {
    const small = fixtureDex(); // a small install, so the call has few outcomes
    installKaizoDex(small.data, new Map([...small.moves].filter(([id]) => ([ID.metronome, ID.tackle, ID.growl, ID.futureSight] as number[]).includes(id))));
    try {
      const outcomes = expandTurn(start(bulky([ID.metronome]), deoxys([ID.growl])), BOTH_FIRST);
      const called = (name: string) => outcomes.filter((outcome) => logged(outcome, `|move|p1a: Deoxys|${name}|`));
      expect([called('Future Sight').length > 0, called('Tackle').length > 0]).toEqual([true, true]);
      for (const outcome of called('Future Sight')) expect(engine.unmodelledIn(outcome.state)).toContain(metronomeCallNote('Future Sight'));
      for (const outcome of called('Tackle')) expect(engine.unmodelledIn(outcome.state).some((note) => note.startsWith('engine: Metronome called'))).toBe(false);
    } finally {
      installKaizoDex(fixture.data, fixture.moves);
    }
  });

  it('unmodelledIn drops the calc-only notes of moves the engine models: Counter, Mirror Coat, Sleep Talk, Stomp', () => {
    for (const id of [ID.counter, ID.mirrorCoat, ID.sleepTalk, ID.stomp]) expect(installedMoves().get(id)!.unmodelled).not.toBeNull();
    expect(engine.unmodelledIn(start(bulky([ID.counter, ID.mirrorCoat, ID.sleepTalk, ID.stomp]), deoxys([ID.growl])))).toEqual([]);
  });

  it('unmodelledMoves lists each unmodelled move with its reason, by ID; isUnmodelled reads a Showdown move ID', () => {
    expect(engine.installedData()).toBe(fixture.data);
    const list = engine.unmodelledMoves(fixture.moves);
    const reason = (text: string) => (entry(text) as { reason: string }).reason;
    expect(list.find((row) => row.move.id === ID.futureSight)?.reason).toBe(reason('Future Sight effect'));
    expect(list.find((row) => row.move.id === ID.beatUp)?.reason).toBe(reason('Beat Up effect'));
    expect(list.some((row) => [ID.tackle, ID.meanLook, ID.wrap, ID.guillotine].includes(row.move.id as never))).toBe(false);
    expect(list.map((row) => row.move.id)).toEqual(list.map((row) => row.move.id).sort((a, b) => a - b));
    expect([engine.isUnmodelled(idOf(ID.futureSight)), engine.isUnmodelled(idOf(ID.tackle)), engine.isUnmodelled('notahackmove')]).toEqual([true, false, true]);
    expect(engine.unmodelledIn(start(bulky([ID.futureSight]), deoxys([ID.growl])))).toEqual([`Future Sight: ${reason('Future Sight effect')} ("Future Sight effect")`]);
  });

  it('docs/engine-model.md lists every unmodelled effect text with its reason', () => {
    const ours = new Map(Object.entries(ENGINE_EFFECTS).flatMap(([text, effect]) => (effect.kind === 'unmodelled' ? [[text, effect.reason] as const] : [])));
    expect(new Map([...documentedUnmodelled()].map(([text, { reason }]) => [text, reason]))).toEqual(ours);
  });

  it.skipIf(!existsSync('data/docs/Moves.csv'))('on the real data, each documented text\'s moves are unmodelledMoves\' (data/)', () => {
    const byText = new Map<string, string[]>();
    for (const { move } of unmodelledMoves(buildMoves(loadLocalData('data')))) {
      const key = normaliseEffectText(move.effectText);
      byText.set(key, [...(byText.get(key) ?? []), move.name]);
    }
    expect(new Map([...documentedUnmodelled()].map(([text, { moves }]) => [text, moves]))).toEqual(byText);
  });
});
