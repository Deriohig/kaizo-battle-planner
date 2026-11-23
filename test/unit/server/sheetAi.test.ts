// The trainer AI's odds per sheet pair (src/server/sheetAi.ts), over the engine's fixture battles and the AI's
// hand-assembled scripts: the situation each pair is worked out in, the labels, disputed values and the batch.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { buildMoves } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon, ResolvedTrainer } from '../../../src/battle/types.js';
import type { AiMemoryData } from '../../../src/ai/memory.js';
import type { CalcField } from '../../../src/calc/field.js';
import type { ActionSupport, AiMemory, EnemyModel } from '../../../src/contracts/ai.js';
import type { EngineState, Rational } from '../../../src/contracts/engine.js';
import { battleStartLog, cmp, createBattle, installKaizoDex, ONE, rat, restore } from '../../../src/engine/index.js';
import type { SheetAiPairJson } from '../../../src/server/apiTypes.js';
import {
  createSheetAi, pairSituation, SHOWDOWN_SHEET_ENGINE, type SheetAiDeps, type SheetAiListener, type SheetAiQuery,
} from '../../../src/server/sheetAi.js';
import type { ServerData } from '../../../src/server/state.js';
import { buildSheet } from '../../../src/sheet/sheet.js';
import { ABILITY, BAG, fixtureData, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';
import { aiThatNeverThinks, COINS, fixtureAi, NOTHING, withAiRecords } from './aiFixture.js';

const data = withAiRecords(fixtureData());
const moves = buildMoves(data);
const serverData: ServerData = { local: data, catalog: buildCatalog(data), moves };
beforeAll(() => installKaizoDex(data, moves));

const SAVE = { savedAt: '2026-11-09T10:00:00.000Z', savePath: '/saves/game.dsv' };

/** Monferno (L30; Ember, Tackle) in party slot `slot`. */
const monferno = (slot: number, fields: Partial<PlayerMon> = {}): PlayerMon =>
  playerMon(ID.monferno, 30, [ID.ember, ID.tackle], { location: { kind: 'party', slot }, ...fields });
const zigzagoon = (moveIds: number[] = [ID.tackle, ID.growl], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 20, moveIds, fields);
const bidoof = (moveIds: number[] = [ID.tackle]) => resolvedMon(ID.bidoof, 25, moveIds);
const pikachu = () => resolvedMon(ID.pikachu, 22, [ID.growl]);
/** A single-battle trainer with no bag (the bag fixtures' X Attack would pass its turn-1 check). */
const trainerOf = (party: ResolvedMon[], fields: Partial<ResolvedTrainer> = {}) => resolvedTrainer(BAG.none, party, fields);
const query = (trainer: ResolvedTrainer, team: PlayerMon[]): SheetAiQuery => ({ data: serverData, trainer, variant: 0, team, save: SAVE });

type Engine = typeof SHOWDOWN_SHEET_ENGINE;
const deps = (model: EnemyModel, engine: Engine = SHOWDOWN_SHEET_ENGINE): SheetAiDeps => ({ model, engine });
const aiWith = (model: EnemyModel, engine?: Engine) => createSheetAi({ deps: () => deps(model, engine), buildSheet });
const nothing = () => fixtureAi(data, NOTHING);
/** The answer's pairs for `party` against `team` (Monferno alone by default). */
const pairsOf = async (model: EnemyModel, party: ResolvedMon[], team = [monferno(1)], trainer: Partial<ResolvedTrainer> = {}) =>
  (await aiWith(model).odds(query(trainerOf(party, trainer), team))).pairs;
const both = (pair: SheetAiPairJson | undefined) => [pair!.next, pair!.ifFaints];

/** The sheet engine with each createBattle input recorded; `onBattle` runs with the count before each battle. */
function counting(onBattle: (count: number) => void = () => undefined) {
  const inputs: Parameters<typeof createBattle>[0][] = [];
  const engine: Engine = {
    ...SHOWDOWN_SHEET_ENGINE,
    createBattle: (input: Parameters<typeof createBattle>[0]) => { inputs.push(input); onBattle(inputs.length); return createBattle(input); },
  };
  return { engine, inputs };
}

const mv = (slot: number, probability: Rational = ONE): ActionSupport => ({ choice: { kind: 'move', slot }, probability });
const sw = (index: number, probability: Rational = ONE): ActionSupport => ({ choice: { kind: 'switch', index }, probability });
const [TIE, TACKLE, GROWL] = [[mv(0, rat(1, 2)), mv(1, rat(1, 2))], [mv(0)], [mv(1)]];
/** A stand-in model; if the lead faints it sends in the battle's index 1. */
const stub = (support: EnemyModel['support'], replacementSupport: EnemyModel['replacementSupport'] = () => [sw(1)]): EnemyModel => ({
  id: 'stub', initialMemory: () => ({ key: 'stub', data: null }), remember: (memory) => memory, support, replacementSupport,
});

const choice = (label: string, kind: 'move' | 'switch' | 'item', probability: string) => ({ label, kind, probability });
const ok = (...choices: ReturnType<typeof choice>[]) => ({ status: 'ok', choices });
const MOVE_TIE = [choice('Growl', 'move', '1/2'), choice('Tackle', 'move', '1/2')];
const TIED = ok(...MOVE_TIE);
const TACKLE_SURE = [choice('Tackle', 'move', '1/1')];
const sendsIn = (name: string) => ok(choice(name, 'switch', '1/1'));
const NONE_LEFT = { status: 'none', reason: 'Nothing left to send in' };

describe('next and ifFaints', () => {
  it.each<[string, () => EnemyModel, () => ResolvedMon[], number, unknown[]]>([
    ['two tied moves are 1/2 each, by their hack names; one Pokémon alone has nothing left to send in', nothing, () => [zigzagoon()], 0, [TIED, NONE_LEFT]],
    // With the trainer's party index 1 in front, the battle's index 1 is the trainer's first Pokémon, Bidoof.
    ['labels a move by its hack name, a switch "Switches to <name>", an item by its bag name; one label sums its choices', () => stub(() => [
      mv(1, rat(1, 4)), sw(1, rat(1, 8)), { choice: { kind: 'item', item: 'fullrestore' }, probability: rat(1, 8) },
      { choice: { kind: 'item', item: 'fullrestore', consumeSlots: [0, 1] }, probability: rat(1, 4) }, mv(0, rat(1, 4)),
    ]), () => [bidoof(), zigzagoon()], 1, [
      ok(choice('Full Restore', 'item', '3/8'), choice('Growl', 'move', '1/4'), choice('Tackle', 'move', '1/4'), choice('Switches to Bidoof', 'switch', '1/8')),
      sendsIn('Bidoof'),
    ]],
    // With the third in front the battle's party is party[2], party[1], party[0]: index 1 is slot 2, index 2 slot 1.
    ['two of one species in an answer get their party slot; one alone its species name', () => stub(() => [sw(1, rat(1, 2)), sw(2, rat(1, 2))], () => [sw(2)]),
      () => [zigzagoon(), zigzagoon(), zigzagoon()], 2,
      [ok(choice('Switches to Zigzagoon (slot 1)', 'switch', '1/2'), choice('Switches to Zigzagoon (slot 2)', 'switch', '1/2')), sendsIn('Zigzagoon')]],
    ['odds that do not sum to exactly 1 are unproven, never shown', () => stub(() => [mv(0, rat(3, 4))]), () => [zigzagoon(), bidoof()], 0,
      [{ status: 'unproven', code: 'BAD_SUPPORT', reason: 'The AI\'s odds sum to 3/4, not 1' }, sendsIn('Bidoof')]],
  ])('%s', async (_name, model, party, k, expected) => {
    expect(both((await pairsOf(model(), party()))[k])).toEqual(expected);
  });

  it('the odds are model.support\'s on the situation built by hand: the pair\'s Pokémon in front, the rest after', async () => {
    // Zigzagoon at party index 1 knows three moves, which COINS scores unequally after the tie-break (RandNext() % 3).
    const model = fixtureAi(data, COINS);
    const party = [bidoof(), zigzagoon([ID.tackle, ID.growl, ID.meanLook])];
    const team = [monferno(1), monferno(2, { moves: [ID.tackle], pp: [35], ppUps: [0] })];
    const pairs = await pairsOf(model, party, team);
    // The second player against the second enemy: team[1] leads, team[0] follows; the trainer leads with party[1].
    const byHand = createBattle({ player: [team[1]!, team[0]!], trainer: trainerOf([party[1]!, party[0]!]), field: {} });
    const names = ['Tackle', 'Growl', 'Mean Look'];
    const expected = model.support(byHand, model.initialMemory(byHand))
      .map(({ choice: c, probability }) => ({ label: c.kind === 'move' ? names[c.slot]! : '?', probability }))
      .sort((a, b) => cmp(b.probability, a.probability) || a.label.localeCompare(b.label))
      .map(({ label, probability }) => choice(label, 'move', `${probability.num}/${probability.den}`));
    expect(expected.map((c) => c.probability)).toEqual(['43691/131072', '87381/262144', '87381/262144']);
    expect(pairs[3]).toMatchObject({ player: 'party:2', enemy: 'enemy:1', next: { status: 'ok', choices: expected } });
    // ifFaints follows the swapped party too: with index 2 in front, its slot holds the trainer's first Pokémon.
    // BattleAI_PostKOSwitchIn picks the bench Pokémon whose moves deal the most damage: Tackle, over Pikachu's Growl.
    const swapped = await pairsOf(nothing(), [bidoof(), pikachu(), zigzagoon()]);
    expect(swapped.map((p) => p.ifFaints)).toEqual([sendsIn('Zigzagoon'), sendsIn('Bidoof'), sendsIn('Bidoof')]);
  });

  it('an AiError is unproven with its code; the other pairs and its own switch-in are unaffected', async () => {
    // Bidoof's decision runs a script with no such opcode; Zigzagoon's runs NOTHING.
    const [good, bad] = [nothing(), aiThatNeverThinks(data)];
    const mixed: EnemyModel = { ...good, support: (state, memory) => (restore(state).p2.active[0]!.species.name === 'Bidoof' ? bad : good).support(state, memory) };
    expect(await aiWith(mixed).odds(query(trainerOf([zigzagoon(), bidoof()]), [monferno(1)]))).toEqual({ ...SAVE, pairs: [
      { player: 'party:1', enemy: 'enemy:0', next: TIED, ifFaints: sendsIn('Bidoof') },
      { player: 'party:1', enemy: 'enemy:1', next: { status: 'unproven', code: 'UNKNOWN_OPCODE', reason: expect.stringMatching(/.+/) }, ifFaints: sendsIn('Zigzagoon') },
    ] });
  });

  it('a double battle is unsupported for every pair; a pair whose weather is not settled, for that pair alone', async () => {
    const singles = { status: 'unsupported', reason: 'The AI odds are for single battles only' };
    const double = await pairsOf(nothing(), [zigzagoon(), bidoof()], [monferno(1), monferno(2)], { battleType: 'double' });
    expect(double.map(both)).toEqual(Array(4).fill([singles, singles]));
    // Drizzle against Drought: whoever came in last sets the weather. Plain Monferno meets Drought's sun.
    const drought = zigzagoon([ID.tackle, ID.growl], { ability: knownAbility(ABILITY.drought) });
    const [drizzle, plain] = await pairsOf(nothing(), [drought], [monferno(1, { ability: knownAbility(ABILITY.drizzle) }), monferno(2)]);
    const unsettled = { status: 'unsupported', reason: 'The weather is not settled for this pair' };
    expect([both(drizzle), plain!.next.status]).toEqual([[unsettled, unsettled], 'ok']);
  });
});

describe('the situation for a pair', () => {
  const situation = (team: PlayerMon[], trainer: ResolvedTrainer, enemy: number, field: CalcField, engine?: Engine, model = nothing(), player = team[0]!) =>
    pairSituation(deps(model, engine), { team, player, trainer, enemy, field });
  const RAIN_NOTE = { raw: 'PERMANENT RAIN, TRICK ROOM, GRAVITY', weather: 'rain' as const, trickRoom: true, gravity: true };
  const RAIN_FIELD = { weather: 'rain' as const, trickRoom: true, gravity: true };

  it('P leads as its PlayerMon is, then the next five in team order; the trainer\'s slots 0 and k swap; its note is not the pair\'s field', () => {
    // The lead held Leftovers in the save, and its draft takes it away.
    const third = { ...monferno(3, { nickname: 'Third', item: ITEM.leftovers }), currentHp: 7, status: { kind: 'burn' as const }, item: 0 };
    const team = [monferno(1), monferno(2, { nickname: 'Second' }), third];
    const s = situation(team, trainerOf([bidoof(), pikachu(), zigzagoon()], { field: { raw: 'PERMANENT RAIN', weather: 'rain' } }), 2, {}, undefined, undefined, third);
    const battle = restore(s.state);
    const { hp, status, item } = battle.p1.active[0]!;
    expect([[hp, status, item], battle.p1.team.map((set) => set.name), battle.p2.team.map((set) => set.name), s.party.map((mon) => mon.name)]).toEqual([
      [7, 'brn', ''], ['Third', 'Monferno', 'Second'], ['Zigzagoon', 'Pikachu', 'Bidoof'], ['Zigzagoon', 'Pikachu', 'Bidoof'],
    ]);
    expect([battle.p2.pokemon.every((pokemon) => pokemon.hp === pokemon.maxhp), battle.field.weather]).toEqual([true, '']);
    const thirteen = Array.from({ length: 13 }, (_, i) => monferno(i + 1, { nickname: `M${i + 1}` }));
    expect(restore(situation(thirteen, trainerOf([zigzagoon()]), 0, {}, undefined, undefined, thirteen[9]).state).p1.team.map((set) => set.name))
      .toEqual(['M10', 'M1', 'M2', 'M3', 'M4', 'M5']);
  });

  it('sets the pair\'s field: a permanent weather, Trick Room and Gravity; the memory is the created battle\'s', () => {
    const model = nothing();
    const team = [monferno(1)];
    const trainer = trainerOf([zigzagoon()]);
    const s = situation(team, trainer, 0, RAIN_FIELD, undefined, model);
    const { field } = restore(s.state);
    expect([s.state.turn, s.state.phase.kind, field.weather, field.weatherState.duration ?? 0, Object.keys(field.pseudoWeather).sort()])
      .toEqual([1, 'turnChoice', 'raindance', 0, ['gravity', 'trickroom']]);
    expect(s.memory).toEqual(model.initialMemory(createBattle({ player: team, trainer, field: {} })));
    expect(model.support(s.state, s.memory).length).toBeGreaterThan(0);
  });

  it('gives the battle the trainer\'s note where it matches the pair: a Drizzle lead under a rain note stays silent', () => {
    // The cartridge sets the note's rain before the leads come in, so Drizzle's subscript never runs.
    const model = nothing();
    const team = [monferno(1, { ability: knownAbility(ABILITY.drizzle) })];
    const trainer = trainerOf([zigzagoon()], { field: { raw: 'PERMANENT RAIN', weather: 'rain' } });
    const s = situation(team, trainer, 0, { weather: 'rain' }, undefined, model);
    const noNote = (field: CalcField) => model.initialMemory(createBattle({ player: team, trainer: { ...trainer, field: null }, field }));
    const abilitiesKnown = (memory: AiMemory) => (memory.data as AiMemoryData).knowledge.battlerAbilities;
    expect(s.memory).toEqual(noNote({ weather: 'rain' }));
    // Without the note the engine's Drizzle announces itself, and the AI would learn it.
    expect([abilitiesKnown(s.memory), abilitiesKnown(noNote({}))]).toEqual([[0, 0, 0, 0], [ABILITY.drizzle, 0, 0, 0]]);
  });

  it('passes the note\'s Trick Room, Gravity and fog, and its weather only when it is the pair\'s; the engine path sees the same field', () => {
    const { engine, inputs } = counting();
    const sheet = situation([monferno(1)], trainerOf([zigzagoon()], { field: RAIN_NOTE }), 0, RAIN_FIELD, engine);
    situation([monferno(1)], trainerOf([zigzagoon()], { field: RAIN_NOTE }), 0, { ...RAIN_FIELD, weather: 'sun' }, engine);   // a Drought lead's sun
    situation([monferno(1)], trainerOf([zigzagoon()], { field: { raw: 'FOG', fog: true } }), 0, { fog: true }, engine);
    expect(inputs.map((input) => input.field)).toEqual([RAIN_FIELD, { trickRoom: true, gravity: true }, { fog: true }]);
    const summary = (state: EngineState) => {
      const { field } = restore(state);
      return [field.weather, field.weatherState['duration'], Object.fromEntries(Object.entries(field.pseudoWeather).map(([id, st]) => [id, st['duration']]))];
    };
    const direct = createBattle(inputs[0]!);   // the engine path: createBattle over the same input
    expect([summary(sheet.state), summary(direct)]).toEqual(Array(2).fill(['raindance', 0, { trickroom: 0, gravity: 0 }]));
    // The plain |-weather| line the AI memory folds permanent weather from.
    expect(battleStartLog(direct)).toContain('|-weather|RainDance');
  });

  it.each([
    ['deep fog, which Showdown lacks, as the note bit', 1 << 15, { raw: 'FOG', fog: true }],
    ['permanent rain', 1 << 1, { raw: 'PERMANENT RAIN', weather: 'rain' as const }],
  ])('the AI reads %s from the trainer\'s note', async (_name, mask, field) => {
    const model = fixtureAi(data, `IfFieldConditionsMask ${mask}, Yes\nPopOrEnd\nYes: IfMoveEqualTo ${ID.tackle}, Up\nPopOrEnd\nUp: AddToMoveScore 1\nPopOrEnd`);
    const [noted, clear] = [await pairsOf(model, [zigzagoon()], undefined, { field }), await pairsOf(model, [zigzagoon()])];
    expect([noted[0]!.next, clear[0]!.next]).toEqual([ok(...TACKLE_SURE), TIED]);
  });
});

describe('disputed trainer values: every candidate world', () => {
  const [STURDY, GLUTTONY] = [5, 82];
  const [HARDY, ADAMANT, BOLD, TIMID] = [0, 3, 5, 10];
  // +1 to Tackle when the AI's own Pokémon (battler 1) has Sturdy: LoadBattlerAbility reads its raw field.
  const WHEN_STURDY = `LoadBattlerAbility 1\nIfTempEqualTo ${STURDY}, Sturdy\nPopOrEnd\nSturdy: IfMoveEqualTo ${ID.tackle}, Up\nPopOrEnd\nUp: AddToMoveScore 1\nPopOrEnd`;
  const disputedNature = (value: number | null, alternatives: number[]) => ({ value, source: 'docs' as const, disputed: true, alternatives });
  /** Zigzagoon (Tackle, Growl) whose ability is Gluttony or Sturdy. */
  const sturdyOrNot = (fields: Partial<ResolvedMon> = {}) =>
    zigzagoon([ID.tackle, ID.growl], { ability: { value: GLUTTONY, source: 'rom', disputed: true, alternatives: [STURDY] }, ...fields });
  const hardyOrTimid = () => sturdyOrNot({ nature: disputedNature(HARDY, [TIMID]) });
  const bidoofOf = (nature: ReturnType<typeof disputedNature>) => resolvedMon(ID.bidoof, 25, [ID.tackle, ID.growl], { nature });
  const onSturdy = (on = "Zigzagoon's ability") => ({ status: 'depends', on, cases: [{ when: 'Gluttony', choices: MOVE_TIE }, { when: 'Sturdy', choices: TACKLE_SURE }] });
  /** A stand-in model whose next move is `pick`'s, from the lead's nature ("Timid") and ability ("sturdy"). */
  const leadModel = (pick: (nature: string, ability: string) => ActionSupport[]) =>
    stub((state) => { const lead = restore(state).p2.active[0]!; return pick(lead.set.nature, lead.baseAbility); });

  it.each<[string, () => ResolvedMon[], unknown[]]>([
    ['one disputed value decides: a case per candidate', () => [sturdyOrNot()], [[onSturdy(), NONE_LEFT]]],
    // The script reads only the attacker's ability. With Bidoof in front its slot is 0: Zigzagoon's Sturdy goes to slot 1,
    // never to Bidoof, whose two moves would then stop tying.
    ['by the swapped party\'s worlds', () => [sturdyOrNot(), bidoofOf(disputedNature(0, [3]))], [[onSturdy(), sendsIn('Bidoof')], [TIED, sendsIn('Zigzagoon')]]],
    ['the first value that decides, in party order', () => [bidoofOf(disputedNature(HARDY, [ADAMANT])), sturdyOrNot()],
      [[TIED, sendsIn('Zigzagoon')], [onSturdy(), sendsIn('Bidoof')]]],
    ['two of one species: `on` names the slot', () => [zigzagoon(), sturdyOrNot()],
      [[TIED, sendsIn('Zigzagoon')], [onSturdy("Zigzagoon (slot 2)'s ability"), sendsIn('Zigzagoon')]]],
  ])('depends on the value that decides the odds: %s', async (_name, party, expected) => {
    expect((await pairsOf(fixtureAi(data, WHEN_STURDY), party())).map(both)).toEqual(expected);
  });

  it.each<[string, () => ResolvedMon[], unknown[] | number]>([
    ['a script that ignores the disputed value', () => [sturdyOrNot()], [{ enemy: [{ ability: GLUTTONY }] }, { enemy: [{ ability: STURDY }] }]],
    ['nothing disputed (one world per pair)', () => [zigzagoon(), bidoof()], [{ enemy: [] }, { enemy: [] }]],
    ['candidates that all agree', () => [hardyOrTimid()], 4],
  ])('%s: ok with the shared odds, after every world', async (_name, party, worlds) => {
    const { engine, inputs } = counting();
    const answer = await aiWith(nothing(), engine).odds(query(trainerOf(party()), [monferno(1)]));
    expect([answer.pairs[0]!.next, typeof worlds === 'number' ? inputs.length : inputs.map((input) => input.world)]).toEqual([TIED, worlds]);
  });

  it.each<[string, () => ResolvedMon, (nature: string, ability: string) => ActionSupport[], unknown]>([
    ['a disputed nature: a case per outcome, the listed one first', () => zigzagoon(undefined, { nature: disputedNature(TIMID, [HARDY]) }),
      (nature) => (nature === 'Timid' ? TACKLE : TIE),
      { status: 'depends', on: "Zigzagoon's nature", cases: [{ when: 'Timid', choices: TACKLE_SURE }, { when: 'Hardy', choices: MOVE_TIE }] }],
    ['agreeing candidates joined, "Hardy or Bold"', () => zigzagoon(undefined, { nature: disputedNature(HARDY, [TIMID, BOLD]) }),
      (nature) => (nature === 'Timid' ? TACKLE : TIE),
      { status: 'depends', on: "Zigzagoon's nature", cases: [{ when: 'Hardy or Bold', choices: MOVE_TIE }, { when: 'Timid', choices: TACKLE_SURE }] }],
    ['two values that change it only together', hardyOrTimid, (nature, ability) => (nature === 'Timid' && ability === 'sturdy' ? TACKLE : TIE),
      { status: 'unproven', code: 'DISPUTED', reason: "Depends on the trainer's disputed natures and abilities" }],
    ['two values that each change it, neither alone deciding', hardyOrTimid,
      (nature, ability) => (nature === 'Timid') === (ability === 'sturdy') ? TIE : nature === 'Timid' ? TACKLE : GROWL,
      { status: 'unproven', code: 'DISPUTED', reason: "Depends on Zigzagoon's nature (Hardy or Timid); Zigzagoon's ability (Gluttony or Sturdy)" }],
  ])('%s', async (_name, mon, pick, next) => {
    expect((await pairsOf(leadModel(pick), [mon()]))[0]!.next).toEqual(next);
  });

  it('more than 16 candidate worlds are unproven for every pair, both parts, without a battle', async () => {
    // No source gives the nature: all 25, of which the five neutral ones fight alike, so 21 worlds.
    const { engine, inputs } = counting();
    const unknown = zigzagoon([ID.tackle, ID.growl], { nature: disputedNature(null, Array.from({ length: 25 }, (_, i) => i)) });
    const answer = await aiWith(nothing(), engine).odds(query(trainerOf([unknown, bidoof()]), [monferno(1), monferno(2)]));
    const capped = { status: 'unproven', code: 'DISPUTED', reason: 'Too many disputed natures and abilities to check (21 combinations)' };
    expect([answer.pairs.map(both), inputs]).toEqual([Array(4).fill([capped, capped]), []]);
  });

  it('an AiError in a world that is not the listed one is unproven with its code, and every world is still worked out', async () => {
    // The second world (Hardy, Sturdy) runs a script with no such opcode; the others NOTHING.
    const [good, bad] = [nothing(), aiThatNeverThinks(data)];
    let decisions = 0;
    const isHardySturdy = (state: EngineState) => { const lead = restore(state).p2.active[0]!; return lead.set.nature === 'Hardy' && lead.baseAbility === 'sturdy'; };
    const mixed: EnemyModel = { ...good, support: (state, memory) => { decisions++; return (isHardySturdy(state) ? bad : good).support(state, memory); } };
    expect([(await pairsOf(mixed, [hardyOrTimid()]))[0]!.next, decisions]).toEqual([{ status: 'unproven', code: 'UNKNOWN_OPCODE', reason: expect.stringMatching(/.+/) }, 4]);
  });

  it('ifFaints follows the same rule: whom it sends in depends on a disputed ability', async () => {
    // Bidoof leads; it sends in Zigzagoon (the battle's index 1) when Zigzagoon is Sturdy, else Pikachu (index 2).
    const model = stub(() => TIE, (state) => [sw(restore(state).p2.pokemon[1]!.baseAbility === 'sturdy' ? 1 : 2)]);
    expect(both((await pairsOf(model, [bidoof([ID.tackle, ID.growl]), sturdyOrNot(), pikachu()]))[0])).toEqual([TIED, {
      status: 'depends', on: "Zigzagoon's ability",
      cases: [{ when: 'Gluttony', choices: [choice('Pikachu', 'switch', '1/1')] }, { when: 'Sturdy', choices: [choice('Zigzagoon', 'switch', '1/1')] }],
    }]);
  });
});

describe('the batch and its streams', () => {
  const q = query(trainerOf([zigzagoon(), bidoof()]), [monferno(1)]);
  const at = (savedAt: string, savePath = SAVE.savePath) => ({ ...q, save: { savedAt, savePath } });
  const second = (i: number) => `2026-11-10T00:00:${String(i).padStart(2, '0')}.000Z`;
  /** A listener that writes down `start` with the total, then each pair as "<player> <enemy>". */
  function recorder() {
    const told: string[] = [];
    const listener: SheetAiListener = { start: (total) => told.push(`start ${total}`), pair: (pair) => told.push(`${pair.player} ${pair.enemy}`) };
    return { told, listener };
  }
  /** An AI over the counting engine whose model runs `onSupport` before each decision. */
  function counted(onSupport: () => void = () => undefined) {
    const { engine, inputs } = counting();
    const base = nothing();
    return { inputs, ai: aiWith({ ...base, support: (state, memory) => { onSupport(); return base.support(state, memory); } }, engine) };
  }
  // The sheet's order: players outer, in team order, then by party slot.
  const SHEET_ORDER = ['start 4', 'party:2 enemy:0', 'party:2 enemy:1', 'party:1 enemy:0', 'party:1 enemy:1'];
  const q4 = () => query(trainerOf([zigzagoon(), bidoof()]), [monferno(2), monferno(1)]);
  const CLOSED = 'Every request for these AI odds has closed';

  it('caches: concurrent requests share one computation; a new savedAt or savePath computes again; 16 are kept', async () => {
    const { inputs, ai } = counted();
    const [a, b] = await Promise.all([ai.odds(q), ai.odds({ ...q, team: [...q.team] })]);
    const battlesAfter = async (asked: SheetAiQuery) => { await ai.odds(asked); return inputs.length; };
    expect([a, await battlesAfter(q), await battlesAfter(at('2026-11-09T10:05:00.000Z')), await battlesAfter(at(SAVE.savedAt, '/saves/other.dsv'))]).toEqual([b, 2, 4, 6]);
    // 16 more saves: the first query is evicted, the last kept.
    for (let i = 0; i < 16; i++) await ai.odds(at(second(i)));
    expect([await battlesAfter(at(second(15))), await battlesAfter(q)]).toEqual([38, 40]);
  });

  it('an answer for another draft is never reused: the key holds each team member whole, by value', async () => {
    const { inputs, ai } = counted();
    const team = [monferno(1, { item: ITEM.leftovers }), monferno(2)];
    const trainer = trainerOf([zigzagoon()]);
    const leads: Partial<PlayerMon>[] = [{}, { currentHp: 1 }, { status: { kind: 'burn' } }, { item: 0 }, { level: 31 }, {}];
    const battles: number[] = [];
    // Each lead asked twice, as fresh copies: two battles a batch (two team members against one Zigzagoon).
    for (const lead of leads.flatMap((lead) => [lead, lead])) {
      await ai.odds(query(trainer, structuredClone([{ ...team[0]!, ...lead }, team[1]!])));
      battles.push(inputs.length);
    }
    expect(battles).toEqual([2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 10, 10]);
  });

  it('yields to the event loop before its first pair and between every two pairs; the deps load after a yield too', async () => {
    let [ticks, ticking] = [0, true];
    const tick = () => { ticks++; if (ticking) setImmediate(tick); };
    setImmediate(tick);
    const base = nothing();
    const seen: number[] = [];
    const model: EnemyModel = { ...base, support: (state, memory) => { seen.push(ticks); return base.support(state, memory); } };
    let depsAt: number | null = null;
    const ai = createSheetAi({ deps: () => { depsAt = ticks; return deps(model); }, buildSheet });
    const answer = ai.odds(query(trainerOf([zigzagoon()]), [monferno(1), monferno(2), monferno(3)]));
    expect(depsAt).toBeNull();                                   // nothing in the request's own synchronous part
    await answer;
    ticking = false;
    expect([Number(depsAt) > 0, seen.length, seen[0]! > 0, seen[1]! > seen[0]!, seen[2]! > seen[1]!]).toEqual([true, 3, true, true, true]);
  });

  it('evicts the oldest batch that has finished, never one still running', async () => {
    const { inputs, ai } = counted();
    const one = query(trainerOf([zigzagoon()]), [monferno(1)]);
    // 17 batches at once, all running: none is evicted, so the first's request joins its batch.
    const first = ai.odds(one);
    const others = Array.from({ length: 16 }, (_, i) => ai.odds({ ...one, save: { ...SAVE, savedAt: second(i) } }));
    const again = ai.odds(one);
    await Promise.all([first, again, ...others]);
    expect([inputs.length, await again === await first]).toEqual([17, true]);
  });

  it('a stream is told start with the number of pairs, then each pair in the sheet\'s order as it is worked out; once kept, all at once', async () => {
    const { told, listener } = recorder();
    const toldAtDecision: number[] = [];
    const { inputs, ai } = counted(() => toldAtDecision.push(told.length));
    const answer = await ai.stream(q4(), listener);
    expect([told, toldAtDecision, answer.pairs.map((p) => `${p.player} ${p.enemy}`)]).toEqual([SHEET_ORDER, [1, 2, 3, 4], SHEET_ORDER.slice(1)]);
    const replay = recorder();
    const replayed = ai.stream(q4(), replay.listener);
    expect(replay.told).toEqual(SHEET_ORDER);
    expect([await replayed, await ai.odds(q4()), inputs.length]).toEqual([answer, answer, 4]);
  });

  it('a stream that joins mid-batch is told start and the finished pairs at once, then the rest; the batch runs once', async () => {
    let reached!: () => void;
    const third = new Promise<void>((resolve) => { reached = resolve; });
    let decisions = 0;
    const { inputs, ai } = counted(() => { if (++decisions === 3) reached(); });
    const [first, second] = [recorder(), recorder()];
    const firstDone = ai.stream(q4(), first.listener);
    await third;
    const joined = ai.stream(q4(), second.listener);
    // At once, before any more of the batch runs: start and more than one pair, but not every pair.
    expect([second.told, second.told.length > 1, second.told.length < SHEET_ORDER.length]).toEqual([first.told, true, true]);
    expect(await joined).toBe(await firstDone);
    expect([first.told, second.told, inputs.length]).toEqual([SHEET_ORDER, SHEET_ORDER, 4]);
  });

  it('a stream or request is a waiter: the batch carries on while one is open; once every one has closed it stops, unkept', async () => {
    const [a, b] = [new AbortController(), new AbortController()];
    let decisions = 0;
    // The stream closes during the second pair, then the request during the third.
    const { inputs, ai } = counted(() => { decisions++; if (decisions === 2) a.abort(); if (decisions === 3) b.abort(); });
    const first = recorder();
    const closing = ai.stream(q4(), first.listener, a.signal);
    const staying = ai.odds(q4(), b.signal);
    await expect(closing).rejects.toThrow(CLOSED);
    await expect(staying).rejects.toThrow(CLOSED);
    expect([first.told, inputs.length]).toEqual([SHEET_ORDER.slice(0, 2), 3]);
    const again = recorder();
    await ai.stream(q4(), again.listener);
    expect([again.told, inputs.length]).toEqual([SHEET_ORDER, 7]);
  });

  it('a batch that fails as a whole rejects its streams, told nothing, and is not kept: the next request tries again', async () => {
    let fail = true;
    const ai = createSheetAi({ deps: () => { if (fail) throw new Error('no AI data'); return deps(nothing()); }, buildSheet });
    const { told, listener } = recorder();
    await expect(ai.stream(q4(), listener)).rejects.toThrow('no AI data');
    await expect(ai.odds(q4())).rejects.toThrow('no AI data');
    fail = false;
    expect([told, (await ai.odds(q4())).pairs.length]).toEqual([[], 4]);
  });
});

it('app.ts and sheetAi.ts never load src/integration/deps.ts: main.ts injects the AI odds deps', () => {
  // The module graph from app.ts by its value imports and re-exports (a type import loads nothing).
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const specs = fs.readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm);
    for (const [, spec] of specs) visit(path.resolve(path.dirname(file), spec!.replace(/\.js$/, '.ts')));
  };
  visit(path.resolve('src/server/app.ts'));
  expect([seen.has(path.resolve('src/server/sheetAi.ts')), seen.has(path.resolve('src/integration/deps.ts'))]).toEqual([true, false]);
});
