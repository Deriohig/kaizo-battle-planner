// What a line node shows of a real engine state, over the engine's fixture battles: its damage numbers (lineDamage.ts: the
// sheet's calc on the node's sides, each move's facts and crit chance, Focus Sash, the turn order, a mid-fight level-up)
// and its view (lineView.ts).

import { beforeAll, describe, expect, it } from 'vitest';
import { normaliseEffectText, UNMODELLED_EFFECTS } from '../../../src/battle/effectMap.js';
import { buildMoves } from '../../../src/battle/moves.js';
import { atLevel, type PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { hitChance } from '../../../src/calc/accuracy.js';
import { damage } from '../../../src/calc/calc.js';
import type { BattleInput, EngineState } from '../../../src/contracts/engine.js';
import { createBattle, expandTurn, installKaizoDex, moveId, restore, snapshot } from '../../../src/engine/index.js';
import { activeOf, buildLookups } from '../../../src/integration/battleView.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { computeStats } from '../../../src/rom/stats.js';
import { critChanceOf } from '../../../src/server/critChance.js';
import { createLineDamage } from '../../../src/server/lineDamage.js';
import { createLineView } from '../../../src/server/lineView.js';
import { effectiveSpeed, speedOrder } from '../../../src/sheet/speed.js';
import { ABILITY, BAG, emberTurn, fixtureData, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';

/** Not in the shared fixture: Double Kick (move 24, hits twice), Focus Sash (item 275), Mold Breaker (ability 104). */
const DOUBLE_KICK = 24;
const FOCUS_SASH = 275;
const MOLD_BREAKER = 104;

const data = fixtureData();
data.rom.moves[DOUBLE_KICK] = { id: DOUBLE_KICK, effect: 44, category: 'physical', power: 30, type: 1, accuracy: 100, pp: 30, effectChance: 0, target: 0, priority: 0, flags: 115 };
data.docs.moves.push({
  id: DOUBLE_KICK, name: 'Double Kick', effectText: 'Hits twice', category: 'physical', power: 30, type: '', accuracy: 100, pp: 30, effectChance: 0, targets: '', priority: 0, contact: false,
});
data.rom.species[ID.magikarp]!.baseExp = 152;                         // a KO of a level 21 Magikarp pays 684 EXP
data.rom.learnsets[ID.monferno] = [{ move: ID.slash, level: 31 }];    // so a level-up teaches a move
data.names = buildNameIndex(data.docs);
const moves = buildMoves(data);
beforeAll(() => installKaizoDex(data, moves));

type Live = ReturnType<typeof restore>;
const mv = (id: number) => moves.get(id)!;
const me = (ids: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, ids, fields);
const foe = (ids: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 20, ids, fields);
const mine = me([ID.ember, ID.tackle]);
const zig = foe([ID.tackle, ID.growl]);
const sashed = foe([ID.tackle, ID.growl], { item: FOCUS_SASH });
const ratio = (num: number, den: number) => ({ num: String(num), den: String(den) });
const exact = (e: { count: bigint; total: bigint }) => ({ num: String(e.count), den: String(e.total) });

const battle = (player: PlayerMon, enemy: ResolvedMon, field: BattleInput['field'] = {}) =>
  createBattle({ player: [player], trainer: resolvedTrainer(BAG.none, [enemy]), field });
const numbersOf = (state: EngineState, player: PlayerMon[], enemy: ResolvedMon) =>
  createLineDamage({ data, moves, player, trainer: () => resolvedTrainer(BAG.none, [enemy]) })(state)!;
/** The numbers at the start of `player` against `enemy` (his side read from `read`, default `[player]`), after `edit`. */
function damageAt(player = mine, enemy = zig, opts: { edit?: (live: Live) => void; read?: PlayerMon[]; field?: BattleInput['field'] } = {}) {
  let state: EngineState = battle(player, enemy, opts.field);
  if (opts.edit) {
    const live = restore(state);
    opts.edit(live);
    state = snapshot(live);
  }
  return numbersOf(state, opts.read ?? [player], enemy);
}
type Out = ReturnType<typeof damageAt>;
type MoveOut = Out['yours'][number];

describe('createLineDamage: the numbers', () => {
  it("each move's numbers are the sheet's calc on the node's sides, stages and field counted, exact KO fractions; a status move has none", () => {
    const out = damageAt();
    const ember = damage({ mon: mine }, { mon: zig }, mv(ID.ember), {})!;
    const crit = damage({ mon: mine }, { mon: zig }, mv(ID.ember), {}, { crit: true })!;
    expect([out.against, out.yours.map((m) => [m.name, m.slot])]).toEqual(['Monferno', [['Ember', 0], ['Tackle', 1]]]);
    expect(out.yours[0]).toMatchObject({
      status: false, note: null, percent: ember.percent, critPercent: crit.percent, ko: ember.koChance![0]!.chance, koCrit: crit.koChance![0]!.chance,
      hitChance: hitChance({ mon: mine }, { mon: zig }, mv(ID.ember), {}),
      koExact: ember.koExact!.map(exact), koCritExact: exact(crit.koExact![0]!), hp: [ember.min, ember.max], critHp: [crit.min, crit.max],
    });
    expect(out.theirs.map((m) => [m.name, m.slot])).toEqual([['Tackle', undefined], ['Growl', undefined]]);
    expect(out.theirs[0]).toMatchObject({ percent: damage({ mon: zig }, { mon: mine }, mv(ID.tackle), {})!.percent, status: false, note: null });
    expect(out.theirs[1]).toMatchObject({
      name: 'Growl', status: true, percent: null, critPercent: null, ko: null, koCrit: null, koExact: null, koCritExact: null, hp: null, critHp: null, note: null,
    });
    expect(() => JSON.stringify(out)).not.toThrow();                                  // no bigint left
    const weaker = resolvedMon(ID.zigzagoon, 17, [ID.tackle, ID.growl]);             // Ember KOs it 1/16 of the time
    expect(damage({ mon: mine }, { mon: weaker }, mv(ID.ember), {})!.koExact![0]).toEqual({ hits: 1, count: 1n, total: 16n });
    expect(damageAt(mine, weaker).yours[0]!.koExact![0]).toEqual(ratio(1, 16));
    // Stat stages count (Tackle after Growl), and so does the field (Ember in rain).
    const growler = resolvedMon(ID.zigzagoon, 60, [ID.growl]);
    const start = battle(mine, growler);
    const after = expandTurn(start, { p1: { kind: 'move', slot: 1 }, p2: { kind: 'move', slot: 0 } }).find((o) => o.state.phase.kind === 'turnChoice')!;
    const [before, lowered] = [numbersOf(start, [mine], growler).yours[1]!, numbersOf(after.state, [mine], growler).yours[1]!];
    const [dry, rain] = [damageAt().yours[0]!, damageAt(mine, zig, { field: { weather: 'rain' } }).yours[0]!];
    expect([lowered.percent![1] < before.percent![1], lowered.percent, rain.percent![1] < dry.percent![1], rain.percent]).toEqual([
      true, damage({ mon: mine, boosts: { atk: -1 } }, { mon: growler }, mv(ID.tackle), {})!.percent,
      true, damage({ mon: mine }, { mon: zig }, mv(ID.ember), { weather: 'rain' })!.percent,
    ]);
  });

  it("an unread side gives no numbers and no order, names whose state on both lists, and keeps each move's facts", () => {
    const note = (who: string) => `can't calculate here: ${who} Pokémon's state is not one the calculator reads`;
    const notes = (out: Out) => [...out.yours, ...out.theirs].map((m) => [m.name, m.note]);
    const transformed = (live: Live) => { live.p2.active[0]!.transformed = true; };   // battleView does not read it
    const sides: [string, Parameters<typeof damageAt>[2]][] = [['your', { read: [] }], ['their', { edit: transformed }], ['the', { read: [], edit: transformed }]];
    for (const [who, opts] of sides) {
      expect(notes(damageAt(mine, zig, opts)), who).toEqual([['Ember', note(who)], ['Tackle', note(who)], ['Tackle', note(who)], ['Growl', null]]);
    }
    const out = damageAt(me([ID.ember, ID.growl]), foe([DOUBLE_KICK, ID.tackle], { item: FOCUS_SASH }), { read: [] });
    const none = { koExact: null, koCritExact: null, hp: null, critHp: null, percent: null, critChance: null, survives: null, priority: 0 };
    expect([out.order, out.yours]).toMatchObject([null, [
      { ...none, name: 'Ember', type: 'Fire', category: 'special', power: 40, multiHit: false },
      { ...none, name: 'Growl', type: 'Normal', category: 'status', power: null, multiHit: false, status: true },
    ]]);
    expect(out.theirs).toMatchObject([{ ...none, name: 'Double Kick', multiHit: true }, { ...none, name: 'Tackle', type: 'Normal', category: 'physical', power: 35, multiHit: false }]);
  });

  it('after a knockout levels him up mid-fight, inPartyOrder reads him at the new level with the learned move; without it, no numbers', () => {
    const enemy = [resolvedMon(ID.magikarp, 21, [ID.growl]), resolvedMon(ID.zigzagoon, 21, [ID.growl])];
    const trainer = resolvedTrainer(BAG.none, enemy);
    const hero = playerMon(ID.monferno, 30, [ID.plainHit], { exp: 24293 });          // one EXP below level 31
    const start = createBattle({ player: [hero], trainer, field: {} });
    const ko = expandTurn(start, { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } }).find((o) => o.state.phase.kind === 'enemyReplacement')!;
    expect(ko.log).toContain('|-kaizolevel|p1a: Monferno|31');
    const next = expandTurn(ko.state, { p2: { kind: 'switch', index: 1 } })[0]!.state;
    const out = createLineDamage({ data, moves, player: [hero], trainer: () => trainer, inPartyOrder: true })(next)!;
    expect([out.yours.map((m) => [m.name, m.note]), out.yours[0]!.percent])
      .toEqual([[['Plain Hit', null], ['Slash', null]], damage({ mon: atLevel(hero, 31) }, { mon: enemy[1]! }, mv(ID.plainHit), {})!.percent]);
    expect(createLineDamage({ data, moves, player: [hero], trainer: () => trainer })(next)!.yours[0]!.note).toMatch(/^can't calculate here: your/);
  });
});

describe("createLineDamage: each move's facts and crit chance", () => {
  it("sends each move's type, category, power, priority and multiHit; power null for fixed and variable damage", () => {
    const facts = (list: MoveOut[]) => list.map((m) => [m.name, m.type, m.category, m.power, m.priority]);
    const out = damageAt(me([ID.ember, ID.tackle, ID.growl, ID.fakeOut]));
    expect(facts(out.yours)).toEqual([
      ['Ember', 'Fire', 'special', 40, 0], ['Tackle', 'Normal', 'physical', 35, 0], ['Growl', 'Normal', 'status', null, 0],
      ['Fake Out', expect.any(String), expect.any(String), mv(ID.fakeOut).power, 3],
    ]);
    expect(facts(out.theirs)).toEqual([['Tackle', 'Normal', 'physical', 35, 0], ['Growl', 'Normal', 'status', null, 0]]);
    const fixed = damageAt(me([ID.seismicToss, ID.dragonRage, ID.flail, ID.payback])).yours;
    expect(facts(fixed).slice(0, 3)).toEqual([['Seismic Toss', 'Fighting', 'physical', null, 0], ['Dragon Rage', 'Dragon', 'special', null, 0], ['Flail', 'Normal', 'physical', null, 0]]);
    // Seismic Toss does its level; Payback keeps its base power.
    expect([mv(ID.seismicToss).calc.fixedDamage, fixed[0]!.hp, fixed[3]!.power, fixed[3]!.power! > 1]).toEqual(['level', [30, 30], mv(ID.payback).power, true]);
    // multiHit marks a move that hits more than once in a use, on both sides; Beat Up and Triple Kick are matched by effect text.
    const multi = damageAt(me([ID.furyAttack, ID.beatUp, ID.tackle, ID.growl]), foe([DOUBLE_KICK, ID.tackle]));
    expect([multi.yours.map((m) => m.multiHit), multi.theirs.map((m) => m.multiHit), mv(DOUBLE_KICK).calc.hits]).toEqual([[true, true, false, false], [true, false], 2]);
    const hitsOf = (text: string) => { const spec = UNMODELLED_EFFECTS[normaliseEffectText(text)]; return spec === undefined ? 'no such effect' : spec.hits; };
    expect(['Beat Up effect', 'Hits the target up to 3 times; increases power by 10 with each hit'].map(hitsOf)).toEqual([undefined, undefined]);
  });

  const [r0, r16, r8, r4] = [ratio(0, 1), ratio(1, 16), ratio(1, 8), ratio(1, 4)];
  const chant = (live: Live) => { live.p2.addSideCondition('luckychant', live.p2.active[0]!); };
  it.each([
    { name: 'plain 1/16, high-crit Slash 1/8', player: me([ID.tackle, ID.slash]), enemy: zig, yours: [r16, r8], theirs: [r16, null] },
    { name: 'a Scope Lens adds a stage, on either side', player: me([ID.tackle, ID.slash], { item: ITEM.scopeLens }), enemy: foe([ID.tackle], { item: ITEM.scopeLens }), yours: [r8, r4], theirs: [r8] },
    { name: 'no Scope Lens under Klutz', player: me([ID.tackle], { item: ITEM.scopeLens, ability: knownAbility(ABILITY.klutz) }), enemy: zig, yours: [r16], theirs: [r16, null] },
    { name: 'Super Luck adds a stage', player: me([ID.slash, ID.tackle], { ability: knownAbility(ABILITY.superLuck) }), enemy: zig, yours: [r4, r8], theirs: [r16, null] },
    { name: 'Battle Armor blocks crits into it alone', player: me([ID.slash, ID.tackle]), enemy: foe([ID.tackle], { ability: knownAbility(ABILITY.battleArmor) }), yours: [r0, r0], theirs: [r16] },
    { name: "Lucky Chant on the defender's side", player: me([ID.tackle]), enemy: zig, edit: chant, yours: [r0], theirs: [r16, null] },
    { name: 'fixed damage 0/1, Flail 1/16', player: me([ID.seismicToss, ID.dragonRage, ID.flail]), enemy: zig, yours: [r0, r0, r16], theirs: [r16, null] },
    { name: 'Counter, Mirror Coat and Metal Burst 0/1', player: me([ID.counter, ID.mirrorCoat, ID.metalBurst, ID.tackle]), enemy: zig, yours: [r0, r0, r0, r16], theirs: [r16, null] },
  ])('crit chance: $name; crit figures only where a crit can land', ({ player, enemy, edit, yours, theirs }) => {
    const out = damageAt(player, enemy, { edit });
    expect([out.yours.map((m) => m.critChance), out.theirs.map((m) => m.critChance)]).toEqual([yours, theirs]);
    for (const m of [...out.yours, ...out.theirs].filter((x) => x.hp !== null)) {
      expect(m.critHp === null, m.name).toBe(m.critChance!.num === '0');
      if (m.critHp === null) expect([m.critPercent, m.koCrit, m.koCritExact], m.name).toEqual([null, null, null]);
    }
  });

  it("critChanceOf: Focus Energy adds 2 stages (capped at 1/2); the engine move's stage or always-crit wins; Mold Breaker crits through Battle Armor", () => {
    const chanceOf = (player: PlayerMon, move: number, sim?: { critRatio?: number; willCrit?: boolean } | null, focus = false) => {
      const live = restore(battle(player, zig));
      const view = activeOf(live, resolvedTrainer(BAG.none, [zig]), 'p1', { data, moves, player: [player], trainer: () => resolvedTrainer(BAG.none, [zig]) }, buildLookups(moves))!;
      if (focus) view.pokemon.addVolatile('focusenergy');
      return critChanceOf(data.rom.items, view.calc, view.pokemon, mv(move), true, sim === undefined ? live.dex.moves.get(moveId(mv(move))) : sim);
    };
    const plain = me([ID.tackle, ID.slash]);
    const lucky = me([ID.slash], { item: ITEM.scopeLens, ability: knownAbility(ABILITY.superLuck) });
    expect(mv(ID.tackle).calc.critStage).toBeUndefined();
    expect([
      chanceOf(plain, ID.tackle, undefined, true), chanceOf(plain, ID.slash, undefined, true), chanceOf(lucky, ID.slash, undefined, true),
      chanceOf(plain, ID.tackle, { critRatio: 2 }), chanceOf(plain, ID.tackle, { critRatio: 1, willCrit: true }), chanceOf(plain, ID.slash, { critRatio: 1 }),
      chanceOf(plain, ID.slash), chanceOf(plain, ID.tackle), chanceOf(plain, ID.slash, null),
    ]).toEqual([r4, ratio(1, 3), ratio(1, 2), r8, ratio(1, 1), r16, r8, r16, r8]);
    // On a node, battleView keeps the focusenergy volatile, so the node reads the +2 stages too.
    const focus = (live: Live) => { live.p1.active[0]!.addVolatile('focusenergy'); };
    expect(damageAt(me([ID.tackle]), zig, { edit: focus }).yours[0]!.critChance).toEqual(r4);
    const armoured = foe([ID.tackle, ID.growl], { ability: knownAbility(ABILITY.battleArmor) });
    const breaker = me([ID.ember, ID.tackle], { ability: knownAbility(MOLD_BREAKER) });
    const crit = damage({ mon: breaker }, { mon: armoured }, mv(ID.ember), {}, { crit: true })!;
    expect(crit.max).toBeGreaterThan(damage({ mon: breaker }, { mon: armoured }, mv(ID.ember), {})!.max);
    expect(damageAt(breaker, armoured).yours[0]).toMatchObject({
      critHp: [crit.min, crit.max], critPercent: crit.percent, koCrit: crit.koChance![0]!.chance, koCritExact: exact(crit.koExact!.find((e) => e.hits === 1)!),
    });
  });
});

describe('createLineDamage: Focus Sash', () => {
  const held = me([ID.ember, ID.tackle], { item: FOCUS_SASH });
  it.each([
    { name: 'on his moves against a full-HP holder', player: mine, enemy: sashed, expected: ['Focus Sash', 'Focus Sash'] },
    { name: 'none below full HP', player: mine, enemy: sashed, edit: (live: Live) => { live.p2.active[0]!.hp -= 1; }, expected: [null, null] },
    { name: 'none without the item', player: mine, enemy: zig, expected: [null, null] },
    { name: 'none under Klutz', player: mine, enemy: foe([ID.tackle, ID.growl], { item: FOCUS_SASH, ability: knownAbility(ABILITY.klutz) }), expected: [null, null] },
    { name: 'on their moves into his holder, none on a status move', player: held, enemy: zig, theirs: true, expected: ['Focus Sash', null] },
    { name: 'none for Fury Attack and Beat Up', player: me([ID.furyAttack, ID.beatUp, ID.tackle]), enemy: sashed, expected: [null, null, 'Focus Sash'] },
    { name: 'none for a fixed two hits (Double Kick)', player: held, enemy: foe([DOUBLE_KICK, ID.tackle]), theirs: true, expected: [null, 'Focus Sash'] },
  ])('survives: $name', ({ player, enemy, edit, theirs, expected }) => {
    const out = damageAt(player, enemy, { edit });
    const list = theirs ? out.theirs : out.yours;
    expect(list.map((m) => m.survives)).toEqual(expected);
    expect(list[0]!.koExact).not.toBeNull();
  });
});

describe('createLineDamage: turn order', () => {
  it("is the sheet's effective Speeds and speedOrder; Trick Room flips who goes first, the Speeds unchanged", () => {
    const order = damageAt().order!;
    expect([speedOrder({ mon: mine }, { mon: zig }, {}), order])
      .toEqual(['a', { player: effectiveSpeed({ mon: mine }, {}), enemy: effectiveSpeed({ mon: zig }, {}), first: 'player', changers: [] }]);
    expect(damageAt(mine, zig, { field: { trickRoom: true } }).order).toEqual({ ...order, first: 'enemy' });
  });

  const clawed = me([ID.ember, ID.tackle], { item: ITEM.quickClaw });
  const twin = (item: number) => resolvedMon(ID.monferno, 30, [ID.tackle, ID.growl], { item });
  it.each([
    { name: 'a Quick Claw on the slower side', player: mine, enemy: foe([ID.tackle], { item: ITEM.quickClaw }), first: 'player', changers: ['Quick Claw'] },
    { name: 'no Quick Claw on the faster side', player: clawed, enemy: zig, first: 'player', changers: [] },
    { name: 'a Custap Berry on the slower side', player: mine, enemy: foe([ID.tackle], { item: ITEM.custapBerry }), first: 'player', changers: ['Custap Berry'] },
    { name: 'either side on a tie, player first', player: clawed, enemy: twin(ITEM.custapBerry), first: 'tie', changers: ['Quick Claw', 'Custap Berry'] },
    { name: 'each changer once on a tie', player: clawed, enemy: twin(ITEM.quickClaw), first: 'tie', changers: ['Quick Claw'] },
  ])('names $name', ({ player, enemy, first, changers }) => {
    expect(damageAt(player, enemy).order).toMatchObject({ first, changers });
  });
});

describe('createLineView', () => {
  const view = createLineView(moves);
  /** The outcomes of Monferno's Ember (L30) against a Zigzagoon of `level` using Growl. */
  const emberInto = (level: number) => expandTurn(battle(mine, resolvedMon(ID.zigzagoon, level, [ID.growl])), { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } });

  it('shows both active Pokémon, their sets and forms, both parties and the field, and what a step changes', () => {
    const v = view(createBattle({ ...emberTurn(), field: { weather: 'rain', trickRoom: true, gravity: true, fog: true } }), ['Blaze']);
    const [ivs, evs] = [31, 0].map((n) => ({ hp: n, atk: n, def: n, spa: n, spd: n, spe: n }));
    const hp = computeStats({ hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, ivs!, evs!, 30, 0).hp;
    expect(v.player.active).toMatchObject({
      ident: 'Monferno', name: 'Blaze', species: 'Monferno', speciesId: 391, level: 30, hp, maxHp: hp, percent: 100, status: null, boosts: {}, item: null, ability: 'Blaze',
      fainted: false, active: true,
    });
    expect(v.player.active?.moves?.map((m) => [m.name, m.pp, m.maxPp])).toEqual([['Ember', 25, 25], ['Tackle', expect.any(Number), expect.any(Number)]]);
    expect(v.enemy.active).toMatchObject({ name: 'Zigzagoon', species: 'Zigzagoon', speciesId: 263, level: 20, percent: 100, ability: 'Gluttony', fainted: false });
    expect([v.enemy.active?.moves, 'formId' in v.enemy.active!, v.player.party.length, v.enemy.party.map((m) => m.name)]).toEqual([undefined, false, 1, ['Zigzagoon']]);
    expect([v.field.weather, v.field.conditions.sort(), v.field.player, v.field.enemy]).toEqual(['Rain', ['Deep fog', 'Gravity', 'Trick Room'], [], []]);
    expect(view(createBattle(emberTurn()), ['Blaze']).field).toEqual({ weather: null, conditions: [], player: [], enemy: [] });
    // A formId when the battle species is a form with a sprite of its own.
    for (const [forme, num, form] of [['Rotom-Wash', 479, 2], ['Giratina-Origin', 487, 1], ['Castform-Sunny', 351, 1]] as const) {
      const live = restore(createBattle(emberTurn()));
      live.p2.active[0]!.setSpecies(live.dex.species.get(forme), null);
      expect(view(snapshot(live), ['Blaze']).enemy.active, forme).toMatchObject({ speciesId: num, formId: form });
    }
    // A bench: the whole team in team order, the bench not active and without moves.
    const bench = view(createBattle({
      player: [me([ID.ember]), playerMon(ID.bidoof, 25, [ID.tackle])],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook]), resolvedMon(ID.pikachu, 22, [ID.growl])]), field: {},
    }), ['Blaze', 'Doofus']);
    expect(bench.player.party.map((m) => [m.name, m.species, m.active, m.moves === undefined])).toEqual([['Blaze', 'Monferno', true, false], ['Doofus', 'Bidoof', false, true]]);
    expect(bench.enemy.party.map((m) => [m.name, m.active])).toEqual([['Zigzagoon', true], ['Pikachu', false]]);
    // After a step: status and stat stages, the trainer's HP as its 48-pixel bar shows it, a fainted one at 0 with no status.
    const outcomes = emberInto(60);
    expect(outcomes.some((o) => view(o.state, ['Blaze']).enemy.active?.status === 'burned')).toBe(true);
    const after = view(outcomes[0]!.state, ['Blaze']);
    expect([after.player.active?.boosts, after.enemy.active?.boosts, after.player.active?.percent]).toEqual([{ atk: '-1' }, {}, 100]);
    const enemy = after.enemy.active!;
    expect([enemy.hp > 0 && enemy.hp < enemy.maxHp, enemy.percent]).toEqual([true, Math.round(((Math.floor((enemy.hp * 48) / enemy.maxHp) * 100) / 48) * 10) / 10]);
    expect(view(emberInto(5)[0]!.state, ['Blaze']).enemy.active).toMatchObject({ hp: 0, percent: 0, fainted: true, status: null, active: false });
  });
});
