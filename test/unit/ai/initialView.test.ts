// initialView (the AI's turn-1 view built from the planner's battle-ready Pokémon), its switch-in effects, worldsFor and
// depsFor, on the engine's fixture species, moves and trainers and the AI fixture's items and type chart.
import { describe, expect, it } from 'vitest';
import { decide } from '../../../src/ai/choose/decide.js';
import {
  BATTLE_TYPE_TRAINER_SINGLES, BATTLER_ENEMY_2, BATTLER_NONE, BATTLER_PLAYER_2, FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_GRAVITY_INIT,
  FIELD_CONDITION_GRAVITY_0, FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_SANDSTORM_PERM, FIELD_CONDITION_SUNNY_PERM,
  FIELD_CONDITION_TRICK_ROOM_0, FIELD_CONDITION_TRICK_ROOM_INIT, GENDER_FEMALE, GENDER_MALE, GENDER_NONE, MON_CONDITION_BURN, MON_CONDITION_FREEZE,
  MON_CONDITION_NONE, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON, MON_CONDITION_TOXIC, TYPE_WATER,
} from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import { depsFor, initialDecision, initialLoad, type InitialViewInput, initialView, worldsFor } from '../../../src/ai/initialView.js';
import { eq, ONE, sum } from '../../../src/ai/odds.js';
import type { AiMemoryData } from '../../../src/ai/memory.js';
import { createTrainerAi } from '../../../src/ai/model.js';
import { type AiRomData, aiScriptOf } from '../../../src/ai/rom/aiData.js';
import type { AiItemRecord } from '../../../src/ai/rom/items.js';
import { checkField, type FiredStep, type LeadFields, overlayLead } from '../../../src/ai/switchIn.js';
import { EMPTY_MON } from '../../../src/ai/view.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { LoadedData, ResolvedMon, ResolvedTrainer } from '../../../src/battle/types.js';
import type { FieldNote } from '../../../src/docs/teams.js';
import { battleField, battleStartLog, createBattle } from '../../../src/engine/index.js';
import { computeStats } from '../../../src/rom/stats.js';
import type { StartStatus } from '../../../src/save/status.js';
import { romSpecies, romTrainer } from '../../fixtures/loadedData.js';
import { BAG, fixtureData, ID, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';
import { emptyKnowledge, fixtureDeps, FX } from './fixtures.js';
import { deepFreeze, thrownBy } from './viewHarness.js';

/** Ability, species and nature IDs: line − 1 of generated/abilities.txt and species.txt; natures by rom/stats.ts's order. */
const AB = {
  DRIZZLE: 2, SAND_STREAM: 45, SNOW_WARNING: 117, LIMBER: 7, INTIMIDATE: 22, TRACE: 36, PRESSURE: 46, DROUGHT: 70, UNBURDEN: 84, DOWNLOAD: 88,
  FRISK: 119, MULTITYPE: 121, FLOWER_GIFT: 122, SWIFT_SWIM: 33, LEVITATE: 26, CLEAR_BODY: 29,
} as const;
const SPECIES = { CHERRIM: 421, GIRATINA: 487, ARCEUS: 493 } as const;
const [ADAMANT, TIMID] = [3, 10]; // +Atk −SpA; +Spe −Atk

/** Pokédex weights in hectograms (vanilla's Zigzagoon 17.5 kg, Monferno 22.0, Bidoof 20.0, Giratina 750.0), 0 elsewhere. */
function weightTable(changes: Record<number, number> = {}): number[] {
  const table = Array<number>(494).fill(0);
  Object.assign(table, { [ID.zigzagoon]: 175, [ID.monferno]: 220, [ID.bidoof]: 200, [SPECIES.GIRATINA]: 7500 }, changes);
  return table;
}

/** The AI fixture's items, type chart and empty script; the other forms' weights have Giratina-Origin's 650.0 kg. */
const deps = fixtureDeps();
const ai: AiRomData = {
  scriptWords: Array.from(deps.script.words), flagEntries: [...deps.script.flagEntries], scriptSha256: deps.script.sha256,
  items: deps.items, typeChart: deps.typeChart, weights: weightTable(), formWeights: weightTable({ [SPECIES.GIRATINA]: 6500 }),
};
/** `ai` with extra item records, by ID. */
function aiWith(...records: AiItemRecord[]): AiRomData {
  const items = [...ai.items];
  for (const record of records) items[record.id] = record;
  return { ...ai, items };
}
/** An item record with only a hold effect and its parameter: line − 1 of items.txt and item_hold_effects.txt. */
const holdItem = (id: number, holdEffect: number, holdParam = 0): AiItemRecord => ({ ...ai.items[0]!, id, holdEffect, holdParam });
const LUM_BERRY = holdItem(157, 12); // HOLD_EFFECT_STATUS_RESTORE
const GRISEOUS_ORB = holdItem(112, 2); // HOLD_EFFECT_GIRATINA_BOOST
const LEPPA_BERRY = holdItem(154, 10, 10); // HOLD_EFFECT_PP_RESTORE, 10 PP
const LIECHI_BERRY = holdItem(201, 36, 4); // HOLD_EFFECT_PINCH_ATK_UP at a quarter HP
const SALAC_BERRY = holdItem(203, 38, 4); // HOLD_EFFECT_PINCH_SPEED_UP at a quarter HP
const WHITE_HERB = holdItem(214, 49); // HOLD_EFFECT_STATDOWN_RESTORE
const HACK_LAVA_COOKIE = holdItem(42, 12); // the hack's: HOLD_EFFECT_STATUS_RESTORE (vanilla's has no hold effect)

const ability = (value: number): ResolvedMon['ability'] => ({ value, source: 'rom', disputed: false, alternatives: [] });
const withAbility = <T extends PlayerMon | ResolvedMon>(mon: T, id: number): T => ({ ...mon, ability: ability(id) });

/** The player's lead: Monferno L30, Adamant, Leftovers, Ember (3 PP Ups) and Tackle (1 PP Up), at 50 HP. */
const monferno = (fields: Partial<PlayerMon> = {}): PlayerMon => playerMon(ID.monferno, 30, [ID.ember, ID.tackle], {
  nature: { value: ADAMANT, source: 'rom', disputed: false, alternatives: [] }, item: FX.item.LEFTOVERS, pp: [20, 35], ppUps: [3, 1], currentHp: 50, ...fields,
});
/** The player's bench: Zigzagoon L25, asleep for 2 more turns, at full HP. */
const zigzagoonBench = (): PlayerMon =>
  playerMon(ID.zigzagoon, 25, [ID.tackle], { status: { kind: 'sleep', turns: 2 }, location: { kind: 'party', slot: 1 } });
/** The trainer's lead: a female Zigzagoon L20 with a Sitrus Berry, Tackle and Mean Look. */
const zigzagoon = (fields: Partial<ResolvedMon> = {}): ResolvedMon =>
  resolvedMon(ID.zigzagoon, 20, [ID.tackle, ID.meanLook], { gender: 'F', item: FX.item.SITRUS_BERRY, ...fields });
/** The trainer's second Pokémon: a genderless Bidoof L25 (Swift Swim) with Water Ball and no item. */
const bidoof = (fields: Partial<ResolvedMon> = {}): ResolvedMon => resolvedMon(ID.bidoof, 25, [ID.waterBall], { gender: null, ...fields });
/** The ROM trainer BAG.potions (bag Potion, X Attack, Potion, Super Potion) with `party`. */
const trainer = (fields: Partial<ResolvedTrainer> = {}, party: ResolvedMon[] = [zigzagoon(), bidoof()]): ResolvedTrainer =>
  resolvedTrainer(BAG.potions, party, fields);
const noted = (field: Omit<FieldNote, 'raw'>, party?: ResolvedMon[]): ResolvedTrainer => trainer({ field: { raw: 'fixture note', ...field } }, party);
const input = (fields: Partial<InitialViewInput> = {}): InitialViewInput =>
  ({ player: [monferno(), zigzagoonBench()], trainer: trainer(), world: { enemy: [] }, ...fields });
const viewOf = (fields: Partial<InitialViewInput> = {}, rom = ai, loaded = fixtureData()) => initialView(input(fields), loaded, rom);
const decisionOf = (fields: Partial<InitialViewInput> = {}, rom = ai, loaded = fixtureData()) => initialDecision(input(fields), loaded, rom);
const statsOf = (mon: PlayerMon | ResolvedMon, nature: number) => computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, nature);
const disputedNature = () => zigzagoon({ nature: { value: ADAMANT, source: 'docs', disputed: true, alternatives: [TIMID] } });
const disputedAbility = () => bidoof({ ability: { value: AB.SWIFT_SWIM, source: 'rom', disputed: true, alternatives: [AB.LEVITATE] } });

/** The AiError `run` throws; fails the test when it throws something else or nothing. */
function aiErrorOf(run: () => unknown): AiError {
  const error = thrownBy(run);
  if (error instanceof AiError) return error;
  throw error ?? new Error('expected an AiError, but nothing was thrown');
}

/** Fixture data with vanilla Personal rows (Zigzagoon's stats) for the borrowed species; 501 is Giratina-Origin's. */
function withRows(data: LoadedData = fixtureData()): LoadedData {
  const baseStats = { ...data.rom.species[ID.zigzagoon]!.baseStats };
  data.rom.species[SPECIES.CHERRIM] = romSpecies(SPECIES.CHERRIM, { baseStats, types: [12, 12], abilities: [122, 122] });
  data.rom.species[SPECIES.GIRATINA] = romSpecies(SPECIES.GIRATINA, { baseStats, types: [7, 16], abilities: [46, 46] });
  data.rom.species[501] = romSpecies(501, { baseStats, types: [7, 16], abilities: [26, 26] });
  data.rom.species[SPECIES.ARCEUS] = romSpecies(SPECIES.ARCEUS, { baseStats, abilities: [121, 121] });
  return data;
}

/** The stat stages in BATTLE_STAT order (HP, Attack, Defense, Speed, Sp. Atk, Sp. Def, accuracy, evasion). */
const stages = (changes: Record<number, number> = {}): number[] => [6, 6, 6, 6, 6, 6, 6, 6].map((stage, i) => stage + (changes[i] ?? 0));
const [ATK, DEF, SPEED, SPATK, SPDEF] = [1, 2, 3, 4, 5];

describe('initialView', () => {
  it('loads the leads into battler slots 0 and 1 as battle start leaves them, the parties in order, EMPTY_MON in 2 and 3', () => {
    const view = viewOf();
    const [player, enemy] = [statsOf(monferno(), ADAMANT), statsOf(zigzagoon(), 0)];
    // Ember 25 PP + 3 PP Ups = 40; Tackle 35 + 1 = 42 (move_table.c:25–33); the trainer's moves have no PP Ups. Weights are
    // weightTable's, friendship the fixture species' base 70, and a Pokémon holding an item can unburden (battle_lib.c:164–166).
    const fresh = { statBoosts: stages(), statusVolatile: 0, moveEffectsMask: 0 };
    const effects = { canUnburden: true, fakeOutTurnNumber: 0, slowStartTurnNumber: 0 };
    expect(view).toMatchObject({
      battleType: BATTLE_TYPE_TRAINER_SINGLES, selectedPartySlot: [0, 0, 0, 0], totalTurns: 0, battleStatusMask: 0, powerMul: 10,
      aiSwitchedPartySlot: [6, 6, 6, 6], quickClawThisTurn: [null, null, null, null], fieldConditionsMask: 0, sideConditionsMask: [0, 0],
      sideConditions: [{ spikesLayers: 0, toxicSpikesLayers: 0 }, { spikesLayers: 0, toxicSpikesLayers: 0 }],
      movePrevByBattler: [0, 0, 0, 0], moveHit: [0, 0, 0, 0], moveProtect: [0, 0, 0, 0], recycleItem: [0, 0, 0, 0],
      moveHitBattler: [BATTLER_NONE, BATTLER_NONE, BATTLER_NONE, BATTLER_NONE], battlersSwitchingMask: (1 << BATTLER_PLAYER_2) | (1 << BATTLER_ENEMY_2),
      unknown: [], turnFlags: Array.from({ length: 4 }, () => ({ roosting: false, helpingHand: false })),
      trainerItems: [17, 57, 17, 26], trainerItemCount: 4, monSpeedValues: [player.spe, enemy.spe, 0, 0],
      mons: [{
        ...fresh, species: ID.monferno, curHP: 50, maxHP: player.hp, moves: [ID.ember, ID.tackle, 0, 0], ppCur: [20, 35, 0, 0], ppMax: [40, 42, 0, 0],
        gender: GENDER_MALE, weight: 220, friendship: 70, heldItem: FX.item.LEFTOVERS, effects, types: [10, 1],
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      }, {
        ...fresh, species: ID.zigzagoon, curHP: enemy.hp, maxHP: enemy.hp, moves: [ID.tackle, ID.meanLook, 0, 0], ppCur: [35, 5, 0, 0],
        ppMax: [35, 5, 0, 0], gender: GENDER_FEMALE, weight: 175, friendship: 70, heldItem: FX.item.SITRUS_BERRY, effects,
      }, {}, {}],
      parties: [[
        { species: ID.monferno, hp: 50, maxHp: player.hp, moves: [ID.ember, ID.tackle, 0, 0], pp: [20, 35, 0, 0], ppMax: [40, 42, 0, 0] }, { species: ID.zigzagoon },
      ], [
        { species: ID.zigzagoon, hp: enemy.hp, maxHp: enemy.hp, heldItem: FX.item.SITRUS_BERRY },
        { species: ID.bidoof, moves: [ID.waterBall, 0, 0, 0], pp: [15, 0, 0, 0], ppMax: [15, 0, 0, 0], heldItem: 0 },
      ]],
    });
    expect(view.mons.slice(2)).toEqual([EMPTY_MON, EMPTY_MON]);
    expect(viewOf({ trainer: trainer({}, [bidoof(), zigzagoon()]) }).mons[1]).toMatchObject({ gender: GENDER_NONE, weight: 200, effects: { canUnburden: false } });
  });

  it('compacts the trainer\'s bag', () => {
    const data = fixtureData();
    data.rom.trainers[20] = romTrainer(20, [], { items: [0, 17, 0, 26] });
    expect(viewOf({ trainer: resolvedTrainer(20, [zigzagoon()]) }, ai, data)).toMatchObject({ trainerItems: [17, 26], trainerItemCount: 2 });
  });

  const drizzler = [withAbility(zigzagoon(), AB.DRIZZLE)];
  it.each<[string, Partial<InitialViewInput>, number]>([
    ['a rain note', { trainer: noted({ weather: 'rain' }) }, FIELD_CONDITION_RAINING_PERM],
    ['a sun note', { trainer: noted({ weather: 'sun' }) }, FIELD_CONDITION_SUNNY_PERM],
    ['a sand note', { trainer: noted({ weather: 'sand' }) }, FIELD_CONDITION_SANDSTORM_PERM],
    ['a hail note', { trainer: noted({ weather: 'hail' }) }, FIELD_CONDITION_HAILING_PERM],
    ['Trick Room and Gravity, at their starting counters', { trainer: noted({ trickRoom: true, gravity: true }) },
      FIELD_CONDITION_TRICK_ROOM_INIT | FIELD_CONDITION_GRAVITY_INIT],
    ['the deep fog, exactly (subscript_overworld_fog.s:11)', { trainer: noted({ fog: true }) }, FIELD_CONDITION_DEEP_FOG],
    ['the input\'s field over the note\'s', { trainer: noted({ weather: 'rain', fog: true }), weather: 'sun', fog: false }, FIELD_CONDITION_SUNNY_PERM],
    ['a lead\'s weather ability', { trainer: trainer({}, drizzler) }, FIELD_CONDITION_RAINING_PERM],
    ['a lead\'s weather ability over the note\'s sun (subscript_drizzle.s:11–12)', { trainer: noted({ weather: 'sun', trickRoom: true }, drizzler) },
      FIELD_CONDITION_RAINING_PERM | FIELD_CONDITION_TRICK_ROOM_INIT],
    ['a lead\'s weather ability, clearing the fog with the weather bits (subscript_drizzle.s:11)', { trainer: noted({ fog: true }, drizzler) },
      FIELD_CONDITION_RAINING_PERM],
  ])('sets the field mask for %s, with nothing unknown', (_name, fields, mask) => {
    const view = viewOf(fields);
    expect([view.fieldConditionsMask, view.unknown]).toEqual([mask, []]);
  });

  it('refuses by name, in checkField, a field the engine\'s battle doesn\'t hold; the engine holds the note\'s', () => {
    // The engine's counters needn't equal the cartridge's starting ones: the AI tests them for non-zero.
    const engine = {
      'Trick Room': FIELD_CONDITION_TRICK_ROOM_0, Gravity: FIELD_CONDITION_GRAVITY_0, 'deep fog': FIELD_CONDITION_DEEP_FOG, weather: FIELD_CONDITION_RAINING_PERM,
    };
    const held = Object.values(engine).reduce((all, bit) => all | bit);
    const cartridge = FIELD_CONDITION_TRICK_ROOM_INIT | FIELD_CONDITION_GRAVITY_INIT | FIELD_CONDITION_DEEP_FOG | FIELD_CONDITION_RAINING_PERM;
    expect(() => checkField(held, cartridge)).not.toThrow();
    for (const [name, bit] of Object.entries(engine)) {
      const error = aiErrorOf(() => checkField(held & ~bit, cartridge));
      expect([error.code, error.message.startsWith(`turn-1 switch-in, ${name}:`)]).toEqual(['UNDEFINED', true]);
    }
    expect(() => checkField(cartridge, 0)).toThrow(/turn-1 switch-in, /);
    const note = noted({ trickRoom: true, gravity: true });
    const battle = createBattle({ player: [monferno()], trainer: note, field: { trickRoom: true, gravity: true }, world: { enemy: [] } });
    expect(battleField(battle)).toEqual({ trickRoom: true, gravity: true });
  });

  it('takes the stats from computeStats, and a nature or ability from the world, disputed or not, else the trainer\'s', () => {
    const stats = (s: ReturnType<typeof statsOf>) => ({ maxHP: s.hp, attack: s.atk, defense: s.def, spAttack: s.spa, spDefense: s.spd, speed: s.spe });
    const world = { enemy: [{ nature: TIMID }, { ability: AB.LEVITATE }] };
    const want = (nature: number, ability: number) => ({
      mons: [stats(statsOf(monferno(), ADAMANT)), stats(statsOf(zigzagoon(), nature)), {}, {}], parties: [[{}, {}], [{}, { ability }]],
    });
    expect(viewOf({ trainer: trainer({}, [disputedNature(), disputedAbility()]), world })).toMatchObject(want(TIMID, AB.LEVITATE));
    expect(viewOf({ world })).toMatchObject(want(TIMID, AB.LEVITATE));
    expect(viewOf()).toMatchObject(want(0, AB.SWIFT_SWIM));
  });

  it('takes the weight from the Pokédex table its form picks: weights for form 0, formWeights for any other', () => {
    // Pokedex_SetupGiratina picks the table by the battler's form (battle_lib.c:145–150, pokedex_data_index.c:14–25).
    const rom = { ...ai, weights: weightTable({ [ID.monferno]: 999, [ID.zigzagoon]: 111 }), formWeights: weightTable({ [ID.deoxys]: 222 }) };
    expect(viewOf({}, rom).mons.slice(0, 2).map((mon) => mon.weight)).toEqual([999, 111]);
    // Deoxys-Attack, with its own Personal row's stats (row 496).
    const attack = resolvedMon(ID.deoxys, 20, [ID.tackle], { form: 1, gender: null, baseStats: { ...fixtureData().rom.species[496]!.baseStats } });
    expect(viewOf({ trainer: trainer({}, [attack]) }, rom).mons[1].weight).toBe(222);
    // Giratina: Altered (form 0) 750.0 kg, Origin (form 1, holding its Griseous Orb) 650.0 kg.
    const giratina = (form: number) => viewOf({
      trainer: trainer({}, [zigzagoon({ species: SPECIES.GIRATINA, form, gender: null, item: GRISEOUS_ORB.id })]),
    }, aiWith(GRISEOUS_ORB), withRows()).mons[1];
    expect([giratina(0).weight, giratina(1).weight, giratina(1).form]).toEqual([7500, 6500, 1]);
  });

  it.each([
    [{ kind: 'none' }, MON_CONDITION_NONE], [{ kind: 'sleep', turns: 3 }, 3], [{ kind: 'poison' }, MON_CONDITION_POISON],
    [{ kind: 'toxic' }, MON_CONDITION_TOXIC], [{ kind: 'burn' }, MON_CONDITION_BURN], [{ kind: 'freeze' }, MON_CONDITION_FREEZE],
    [{ kind: 'paralysis' }, MON_CONDITION_PARALYSIS],
  ] as [StartStatus, number][])('encodes the player\'s status %j as %d', (status, encoded) => {
    const view = viewOf({ player: [monferno({ status }), zigzagoonBench()] });
    // The bench Zigzagoon's sleep counter is 2.
    expect([view.mons[0].status, view.parties[0][0]?.status, view.parties[0][1]?.status, view.mons[1].status]).toEqual([encoded, encoded, 2, MON_CONDITION_NONE]);
  });

  it('compares the battle-start speeds: paralysis quarters one, Swift Swim in the note\'s or a lead\'s rain doubles it', () => {
    // battle_lib.c:1259–1261 and 1228–1238.
    expect([
      viewOf({ player: [monferno({ status: { kind: 'paralysis' } })] }).monSpeedValues[0], viewOf({ trainer: noted({ weather: 'rain' }, [bidoof()]) }).monSpeedValues[1],
      viewOf({ player: [withAbility(monferno(), AB.DRIZZLE)], trainer: trainer({}, [bidoof()]) }).monSpeedValues[1],
    ]).toEqual([Math.trunc(statsOf(monferno(), ADAMANT).spe / 4), statsOf(bidoof(), 0).spe * 2, statsOf(bidoof(), 0).spe * 2]);
  });

  const naturelessWorld = trainer({}, [disputedNature(), bidoof()]);
  const abilitylessWorld = trainer({}, [zigzagoon(), disputedAbility()]);
  it.each<[string, () => unknown, string, (string | RegExp)[]]>([
    ['a double battle', () => viewOf({ trainer: trainer({ battleType: 'double' }) }), 'UNSUPPORTED', []],
    ['a species the weight table doesn\'t reach', () => viewOf({}, { ...ai, weights: ai.weights.slice(0, ID.monferno) }), 'BAD_VIEW', []],
    ['a disputed nature the world leaves unset', () => viewOf({ trainer: naturelessWorld }), 'UNDEFINED', [naturelessWorld.id, /party index 0\b.*nature/]],
    ['a disputed ability the world leaves unset', () => viewOf({ trainer: abilitylessWorld, world: { enemy: [{ nature: TIMID }] } }), 'UNDEFINED',
      [abilitylessWorld.id, /party index 1\b.*ability/]],
    // BattleSystem_TriggerFormChange, battle_lib.c:6412–6458 (outside the Distortion World, which the input can't say).
    ['Giratina-Origin without the Griseous Orb, which the cartridge reverts and the engine doesn\'t',
      () => viewOf({ trainer: trainer({}, [zigzagoon({ species: SPECIES.GIRATINA, form: 1, gender: null, item: 0 })]) }, ai, withRows()), 'UNDEFINED',
      [/^turn-1 switch-in, Giratina-Origin without the Griseous Orb:/]],
    // Equal speeds: SortMonSpeedOrder flips a coin (battle_lib.c:3364–3384) and the slower weather wins (:3739–3793).
    ['two weather abilities on equal-speed leads', () => viewOf({
      player: [withAbility(monferno(), AB.DRIZZLE)], trainer: trainer({}, [resolvedMon(ID.monferno, 30, [ID.ember], { ability: ability(AB.DROUGHT) })]),
    }), 'UNDEFINED', [/^turn-1 switch-in, battle-start chance:/]],
    // The slower Zigzagoon's Quick Claw can put it first (battle_lib.c:1278–1286, 2024); the engine draws the claw too.
    ['two weather abilities whose order a Quick Claw draw decides', () => viewOf({
      player: [withAbility(monferno(), AB.DRIZZLE)], trainer: trainer({}, [withAbility(zigzagoon({ item: FX.item.QUICK_CLAW }), AB.DROUGHT)]),
    }), 'UNDEFINED', [/^turn-1 switch-in, battle-start chance: the engine's battle start ends in different states/]],
    // The hack's Lava Cookie heals any status when held, as Lum Berry does; the engine's is vanilla's, which doesn't.
    ['a held item whose hack data the engine doesn\'t model, when it can act at the start',
      () => viewOf({ player: [monferno({ item: HACK_LAVA_COOKIE.id, status: { kind: 'paralysis' } })] }, aiWith(HACK_LAVA_COOKIE)), 'UNDEFINED',
      [/^turn-1 switch-in, held item:/]],
  ])('refuses %s', (_name, run, code, patterns) => {
    const error = aiErrorOf(run);
    expect(error.code).toBe(code);
    for (const pattern of patterns) expect(error.message).toMatch(pattern);
  });

  it('is pure: it changes none of its inputs and gives the same view each time', () => {
    const [data, frozen] = [deepFreeze(fixtureData()), deepFreeze(input({ trainer: noted({ weather: 'rain', fog: true }) }))];
    expect(initialView(frozen, data, ai)).toEqual(initialView(frozen, data, ai));
  });
});

// initialView runs the leads' switch-in effects (BattleSystem_TriggerEffectOnSwitch, battle_lib.c:3649–4175) through the
// engine; where the engine can't give the cartridge's result, it refuses with a named reason (above).
describe('initialView: the switch-in effects', () => {
  /** The player's lead after the switch-in effects, beside the rest of the turn a case checks. */
  const leadAfter = (fields: Partial<InitialViewInput>, rom: AiRomData, loaded = fixtureData()) => {
    const { view, knowledge, steps } = decisionOf(fields, rom, loaded);
    return {
      ...view.mons[0], party: view.parties[0][0], foe: view.mons[1], foeParty: view.parties[1][0], recycleItem: view.recycleItem,
      speed: view.monSpeedValues[0], unknown: view.unknown, steps, known: knowledge.battlerAbilities[0], knownItem: knowledge.battlerHeldItems[0],
    };
  };
  /** A lone player lead: Monferno with `fields` and, if given, `abilityId`. */
  const solo = (fields: Partial<PlayerMon> = {}, abilityId?: number): Partial<InitialViewInput> =>
    ({ player: [abilityId === undefined ? monferno(fields) : withAbility(monferno(fields), abilityId)] });
  const foe = (mon: ResolvedMon) => trainer({}, [mon]);
  const max = statsOf(monferno(), ADAMANT).hp;
  const half = Math.trunc(max / 2);
  const healed = half + Math.trunc((max * 25) / 100); // Sitrus Berry: maxHP × 25 / 100 at half HP or less (battle_lib.c:4985–4989)
  const quarter = Math.trunc(max / 4); // curHP <= maxHP / 4 (battle_lib.c:5201)
  const speed = statsOf(monferno(), ADAMANT).spe;
  const paralysis = { kind: 'paralysis' } as const;
  /** The lead ate `id` at entry: its slot emptied in battle and in the party, the item kept in recycleItem (RemoveItem). */
  const ate = (id: number) => ({ heldItem: 0, party: { heldItem: 0 }, recycleItem: [id, 0, 0, 0] });
  const heldStep = (id: number) => [`held item ${id} (battler 0)`];
  const intimidator = foe(withAbility(zigzagoon({ item: 0 }), AB.INTIMIDATE));
  const herbInput = input({ player: [monferno({ item: WHITE_HERB.id })], trainer: intimidator });
  const castform = [resolvedMon(ID.castform, 20, [ID.tackle])];
  const rainy = { foe: { types: [TYPE_WATER, TYPE_WATER], form: 2 }, foeParty: { form: 0, types: [0, 0] }, unknown: [] };
  // Grass, as the engine's Cherrim is (Showdown's own data: the fixture has no Cherrim row).
  const cherrim = [zigzagoon({ species: SPECIES.CHERRIM, types: [12, 12], ability: ability(AB.FLOWER_GIFT), item: 0 })];
  type Row = [string, Partial<InitialViewInput>, AiRomData, Record<string, unknown>, LoadedData?];
  it.each<Row>([
    // Forecast (battle_lib.c:6314–6354); the party keeps its form: ChangeForm only redraws the sprite (subscript_form_change.s).
    ['Forecast gives Castform the type and form of the player\'s Drizzle', { ...solo({}, AB.DRIZZLE), trainer: trainer({}, castform) }, ai, rainy],
    ['Forecast gives Castform the type and form of the note\'s rain', { trainer: noted({ weather: 'rain' }, castform) }, ai, rainy],
    ['Forecast keeps Castform\'s Normal form in the note\'s sand', { trainer: noted({ weather: 'sand' }, castform) }, ai, { foe: { types: [0, 0], form: 0 } }],
    // battle_lib.c:6366–6410; Pokemon_GetArceusTypeOf gives Normal for an item that is no plate (pokemon.c:4319–4373).
    ['Cherrim takes its Sunshine form in a lead\'s sun', { ...solo({}, AB.DROUGHT), trainer: trainer({}, cherrim) }, ai, { foe: { form: 1 }, unknown: [] }, withRows()],
    ['Cherrim takes its Sunshine form in the note\'s sun', { trainer: noted({ weather: 'sun' }, cherrim) }, ai, { foe: { form: 1 } }, withRows()],
    ['Arceus without a plate is Normal', { trainer: foe(zigzagoon({ species: SPECIES.ARCEUS, ability: ability(AB.MULTITYPE), item: 0 })) }, ai,
      { foe: { types: [0, 0], form: 0 }, unknown: [] }, withRows()],
    // The player's is the save's, the trainer's its species' base friendship; InitBattleMon copies it (battle_lib.c:136).
    ...[[123, 70], [255, 0]].map(([mine, theirs]): Row => [`friendship ${mine} and ${theirs} come from BattleMon.friendship, exactly`,
      { ...solo({ friendship: mine }), trainer: foe(zigzagoon({ friendship: theirs })) }, ai, { friendship: mine, foe: { friendship: theirs }, unknown: [] }]),
    ['the player\'s Intimidate lowers the foe\'s Attack; its buffered message tells nothing (battle_script.c:2955–2961)', solo({}, AB.INTIMIDATE), ai,
      { statBoosts: stages(), foe: { statBoosts: stages({ [ATK]: -1 }) }, unknown: [], known: 0 }],
    // Zigzagoon L20: Defense 27, Sp. Def 27. Bidoof L25 (invented): Defense 64, Sp. Def 65.
    ['Download raises Sp. Atk where the foe\'s Defense is at least its Sp. Def (battle_lib.c:3815–3859)', solo({}, AB.DOWNLOAD), ai,
      { statBoosts: stages({ [SPATK]: 1 }), unknown: [] }],
    ['Download raises Attack where the foe\'s Sp. Def is higher', { ...solo({}, AB.DOWNLOAD), trainer: foe(bidoof()) }, ai,
      { statBoosts: stages({ [ATK]: 1 }), unknown: [] }],
    // The script sets and records the tracer's ability (subscript_trace.s:7, battle_script.c:3402–3404): Zigzagoon's Gluttony.
    ['the player\'s Trace copies the foe\'s ability into its BattleMon only', solo({}, AB.TRACE), ai,
      { ability: 82, party: { ability: AB.TRACE }, known: 82, unknown: [] }],
    // The AI's Trace message tags the traced battler's ability (subscript_trace.s:9): Monferno's Blaze.
    ['the AI\'s Trace copies the player\'s ability, which the AI learns', { trainer: foe(withAbility(zigzagoon(), AB.TRACE)) }, ai,
      { foe: { ability: 66 }, foeParty: { ability: AB.TRACE }, known: 66 }],
    ['a tracer holding the Griseous Orb never traces (battle_lib.c:3723)', solo({ item: GRISEOUS_ORB.id }, AB.TRACE), aiWith(GRISEOUS_ORB), { ability: AB.TRACE }],
    ['an ability that cures the lead\'s status cures it, in battle and in the party, before the speed comparison', solo({ status: paralysis }, AB.LIMBER), ai,
      { status: MON_CONDITION_NONE, party: { status: MON_CONDITION_NONE }, speed, unknown: [] }],
    ['a Sitrus Berry at half HP is eaten', solo({ item: FX.item.SITRUS_BERRY, currentHp: half }), ai,
      { ...ate(FX.item.SITRUS_BERRY), curHP: healed, party: { hp: healed, heldItem: 0 }, unknown: [] }],
    ['a Sitrus Berry at one HP more stays', solo({ item: FX.item.SITRUS_BERRY, currentHp: half + 1 }), ai, { curHP: half + 1, heldItem: FX.item.SITRUS_BERRY }],
    ['a Lum Berry cures paralysis', solo({ item: LUM_BERRY.id, status: paralysis }), aiWith(LUM_BERRY), { ...ate(LUM_BERRY.id), status: MON_CONDITION_NONE }],
    ['the hack\'s Lava Cookie with no status to cure can\'t act, and the view is exact', solo({ item: HACK_LAVA_COOKIE.id }), aiWith(HACK_LAVA_COOKIE), { unknown: [] }],
    // battle_lib.c:5196–5215: maxHP / 0 is _u32_div_f's x (ARM9 0x020E2178), so curHP <= maxHP at any HP.
    ...([['Ganlon Berry', holdItem(202, 37, 0), DEF], ['Apicot Berry', holdItem(205, 40, 0), SPDEF], ['Shoal Salt', holdItem(70, 36, 0), ATK]] as const)
      .map(([name, item, stat]): Row => [`a ${name} (a hack pinch item with parameter 0) is eaten at entry at full HP, as the cartridge does`,
        solo({ item: item.id, currentHp: max }), aiWith(item), { ...ate(item.id), statBoosts: stages({ [stat]: 1 }), steps: heldStep(item.id), unknown: [] }]),
    // Ember: 0 PP + 10, under its 40 maximum (BattleMon_AddVal, battle_lib.c:1013–1018).
    ['Leppa Berry restores the first empty move\'s PP, in battle and in the party (battle_lib.c:5026–5043)', solo({ item: LEPPA_BERRY.id, pp: [0, 35] }),
      aiWith(LEPPA_BERRY), { ...ate(LEPPA_BERRY.id), ppCur: [10, 35, 0, 0], party: { pp: [10, 35, 0, 0], heldItem: 0 }, steps: heldStep(LEPPA_BERRY.id) }],
    ['a Liechi Berry at a quarter HP raises Attack', solo({ item: LIECHI_BERRY.id, currentHp: quarter }), aiWith(LIECHI_BERRY),
      { ...ate(LIECHI_BERRY.id), statBoosts: stages({ [ATK]: 1 }) }],
    // canUnburden stays as loaded (the berry was held at the load): stage +1 is 15/10, then ×2 (battle_lib.c:1268–1272).
    ['a Salac Berry raises Speed, and Unburden doubles the speed compared', solo({ item: SALAC_BERRY.id, currentHp: quarter }, AB.UNBURDEN), aiWith(SALAC_BERRY),
      { statBoosts: stages({ [SPEED]: 1 }), heldItem: 0, effects: { canUnburden: true }, speed: Math.trunc((speed * 15) / 10) * 2 }],
    ['a Clear Body blocks the foe\'s Intimidate (battle_script.c:2883–2894)', { ...solo({}, AB.CLEAR_BODY), trainer: intimidator }, ai,
      { statBoosts: stages(), steps: ['the foe\'s Intimidate (battler 0)'] }],
    // At the held-item step, after the abilities (battle_lib.c:4152–4160, 5088–5099); its message tags BTLSCR_MSG_TEMP,
    // which records nothing (battle_script.c:11745–11747), and the AI forgets an item once the slot is empty (battle_lib.c:1822).
    ['White Herb restores the stage an Intimidate lowered, as the engine does, and the AI learns no item', herbInput, aiWith(WHITE_HERB),
      { ...ate(WHITE_HERB.id), statBoosts: stages(), unknown: [], knownItem: 0 }],
  ])('%s', (_name, fields, rom, want, loaded) => {
    expect(leadAfter(fields, rom, loaded)).toMatchObject(want);
  });

  it('the AI\'s Intimidate lowers the player\'s Attack, and decide then decides', () => {
    const data = fixtureData();
    data.rom.species[0] = romSpecies(0, { baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } }); // for depsFor
    // An empty bag, so the item check reads no record the AI fixture lacks.
    const bagless = resolvedTrainer(BAG.none, [withAbility(zigzagoon(), AB.INTIMIDATE)]);
    const turn = decisionOf({ trainer: bagless }, ai, data);
    expect([turn.view.mons[0].statBoosts, turn.view.unknown]).toEqual([stages({ [ATK]: -1 }), []]);
    const actions = decide(turn.view, depsFor(bagless, data, ai), turn.knowledge);
    expect(eq(sum(actions.map((action) => action.probability)), ONE)).toBe(true);
  });

  it('the engine path\'s initialMemory knows what initialDecision knows at the same battle start', () => {
    // A weather ability whose own _PERM bit the note set runs no subscript (battle_lib.c:3749), nor in the engine, which
    // starts the note weather itself as a plain -weather line; any other weather ability announces.
    type Start = ['rain' | 'sun' | 'sand' | 'hail' | undefined, number, InitialViewInput, AiRomData];
    const lead = (weather: Start[0], weatherAbility: number, known: number): Start =>
      [weather, known, input({ player: [withAbility(monferno(), weatherAbility), zigzagoonBench()], trainer: weather ? noted({ weather }) : trainer() }), ai];
    const starts: Start[] = [
      lead(undefined, AB.DRIZZLE, AB.DRIZZLE), lead('rain', AB.DRIZZLE, 0), lead('sun', AB.DRIZZLE, AB.DRIZZLE), lead('rain', AB.DROUGHT, AB.DROUGHT),
      lead('sun', AB.DROUGHT, 0), lead('sand', AB.SAND_STREAM, 0), lead('hail', AB.SNOW_WARNING, 0), lead('hail', AB.SAND_STREAM, AB.SAND_STREAM),
      [undefined, 0, herbInput, aiWith(WHITE_HERB)],
    ];
    for (const [weather, known, start, rom] of starts) {
      const data = fixtureData();
      const turn = initialDecision(start, data, rom);
      const state = createBattle({ player: start.player, trainer: start.trainer, field: weather === undefined ? {} : { weather }, world: start.world });
      const memory = createTrainerAi(data, rom).initialMemory(state).data as AiMemoryData;
      const plain = battleStartLog(state).filter((line) => line.startsWith('|-weather|') && !line.includes('[from]'));
      expect([memory.knowledge, turn.knowledge.battlerAbilities[0], plain.length]).toEqual([turn.knowledge, known, weather === undefined ? 0 : 1]);
    }
  });

  it('initialDecision gives initialView\'s view and the battle-start knowledge; a lead no step changes is initialLoad\'s', () => {
    // Plain leads, and leads whose only switch-in effect is a message (Pressure, Frisk, battle_lib.c:3861–4113).
    const leads = [
      input(), input({ trainer: noted({ weather: 'rain', trickRoom: true }) }),
      input({ player: [withAbility(monferno(), AB.PRESSURE), zigzagoonBench()], trainer: trainer({}, [withAbility(zigzagoon(), AB.FRISK), bidoof()]) }),
    ];
    for (const lead of leads) {
      const turn = initialDecision(lead, fixtureData(), ai);
      expect([turn.steps, turn.view, turn.view]).toEqual([[], initialLoad(lead, fixtureData(), ai), initialView(lead, fixtureData(), ai)]);
    }
    expect(decisionOf().knowledge).toEqual(emptyKnowledge());
  });

  it('overlayLead takes an engine field only from a fired step that changes it, with the C\'s stage change (BAD_VIEW otherwise)', () => {
    const view = initialLoad(input(), fixtureData(), ai);
    const loaded: LeadFields = { mon: view.mons[0], party: view.parties[0][0]!, recycleItem: 0 };
    const withStages = (changes: Record<number, number>): LeadFields => ({ ...loaded, mon: { ...loaded.mon, statBoosts: stages(changes) } });
    const delta = (changes: Record<number, number>) => stages(changes).map((stage) => stage - 6);
    const lowered = withStages({ [ATK]: -1 });
    const error = aiErrorOf(() => overlayLead(loaded, lowered, [], 0));
    expect([error.code, error.message]).toEqual(['BAD_VIEW', expect.stringMatching(/battler 0's statBoosts .* no switch-in step that changes it fired \(fired: none\)/)]);
    const loose: FiredStep = { step: 'the foe\'s Intimidate', fields: ['statBoosts'] };
    expect(overlayLead(loaded, lowered, [loose], 0).mon.statBoosts).toEqual(stages({ [ATK]: -1 }));
    // Not into a field the step doesn't change: an ability under the foe's Intimidate.
    expect(aiErrorOf(() => overlayLead(loaded, { ...loaded, mon: { ...loaded.mon, ability: AB.TRACE } }, [loose], 0)).message)
      .toMatch(/ability .*fired: the foe's Intimidate\)/);
    expect(overlayLead(loaded, loaded, [], 0)).toEqual(loaded);
    // With the C's stages: the C lowers Attack and the engine didn't; Download raised Sp. Atk on the cartridge, Attack in
    // the engine; both on one lead add up.
    const intimidate: FiredStep = { ...loose, stages: delta({ [ATK]: -1 }) };
    const download: FiredStep = { step: 'Download', fields: ['statBoosts'], stages: delta({ [SPATK]: 1 }) };
    expect(overlayLead(loaded, lowered, [intimidate], 0).mon.statBoosts).toEqual(stages({ [ATK]: -1 }));
    expect(aiErrorOf(() => overlayLead(loaded, loaded, [intimidate], 0)).message).toMatch(/statBoosts .*the C's .*the foe's Intimidate/);
    expect(aiErrorOf(() => overlayLead(loaded, withStages({ [ATK]: 1 }), [download], 0)).code).toBe('BAD_VIEW');
    expect(overlayLead(loaded, withStages({ [ATK]: -1, [SPATK]: 1 }), [intimidate, download], 0).mon.statBoosts).toEqual(stages({ [ATK]: -1, [SPATK]: 1 }));
  });
});

describe('worldsFor', () => {
  it('gives every combination of the disputed candidates, the earlier field varying slowest, or one empty world', () => {
    expect(worldsFor(trainer())).toEqual([{ enemy: [{}, {}] }]);
    const disputed = trainer({}, [zigzagoon({ nature: { value: ADAMANT, source: 'docs', disputed: true, alternatives: [TIMID, 12] } }), disputedAbility()]);
    const worlds = worldsFor(disputed);
    expect(worlds).toEqual([ADAMANT, TIMID, 12].flatMap((nature) => [AB.SWIFT_SWIM, AB.LEVITATE].map((value) => ({ enemy: [{ nature }, { ability: value }] }))));
    for (const world of worlds) expect(() => viewOf({ trainer: disputed, world })).not.toThrow();
    // A nature no source gives: its alternatives alone.
    const unsourced = trainer({}, [zigzagoon({ nature: { value: null, source: 'docs', disputed: true, alternatives: [0, 1] } })]);
    expect(worldsFor(unsourced)).toEqual([{ enemy: [{ nature: 0 }] }, { enemy: [{ nature: 1 }] }]);
  });
});

describe('depsFor', () => {
  /** The fixture data with pl_personal record 0 and ROM trainer 21 under `aiMask`. */
  function depsOf(aiMask: number, romFlags: ResolvedTrainer['aiFlags'], flags = romFlags, drop0 = false) {
    const data = fixtureData();
    data.rom.species[0] = romSpecies(0, { baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } });
    if (drop0) delete data.rom.species[0];
    data.rom.trainers[21] = romTrainer(21, [], { aiMask, aiFlags: romFlags });
    return { data, run: () => depsFor(resolvedTrainer(21, [zigzagoon()], { aiFlags: flags }), data, ai) };
  }

  it('takes aiFlags from the ROM mask (bits past the named flags too), the script from the AI data, the rest from the data', () => {
    expect([depsOf(0b111, ['Basic', 'EvalAttack', 'Expert']).run().aiFlags, depsOf((1 << 31) | 1, ['Basic']).run().aiFlags]).toEqual([7, 2 ** 31 + 1]);
    const { data, run } = depsOf(1, ['Basic']);
    const result = run();
    expect(result.script).toEqual(aiScriptOf(ai));
    const want = [data.rom.moves, data.rom.species, ai.items, ai.typeChart];
    [result.moves, result.species, result.items, result.typeChart].forEach((got, i) => expect(got).toBe(want[i]));
    // Refused: flag names that don't match the ROM mask, and data without species record 0 (LoadBattlerAbility reads it).
    expect(aiErrorOf(depsOf(0b1, ['Basic'], ['Expert']).run).code).toBe('BAD_VIEW');
    const error = aiErrorOf(depsOf(1, ['Basic'], ['Basic'], true).run);
    expect([error.code, error.message]).toEqual(['BAD_VIEW', expect.stringContaining('species record 0')]);
  });
});
