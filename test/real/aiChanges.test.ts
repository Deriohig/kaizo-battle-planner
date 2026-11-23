// Real-data check: one test per item on the docs' AI Changes tab, each on a hand-built turn-1 view run with the hack's
// own script and move data (data/rom, from PK_ROM). Each test scores move slots under the one AI flag its item
// concerns (slotScores with aiFlags set to that flag alone) and checks the score each slot ends with, from the start
// score of 100. docs/ai-changes.md maps each item to its mechanism; each test names the label there that implements it.
//
// The views come from initialView with hand-picked Pokémon (species, level, ability and moves from the hack's data, an
// ability set by hand where a test needs one), hosted by a real single-battle trainer for its ROM record. A test then
// sets what it pins by hand: the AI's HP (out of a maximum of 100, so HP and percent agree), the two speeds, a stat
// stage, and what the AI knows of the player's ability.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { slotScores } from '../../src/ai/choose/moves.js';
import {
  ABILITY_DRY_SKIN, ABILITY_LEVITATE, AI_FLAG_BASIC, AI_FLAG_EVAL_ATTACK, AI_FLAG_EXPERT, AI_FLAG_RISKY, BATTLE_STAT,
} from '../../src/ai/constants.js';
import { depsFor, initialView, type InitialViewInput } from '../../src/ai/initialView.js';
import { initialMemoryData } from '../../src/ai/memory.js';
import { type AiRomData, aiScriptOf, loadAiData } from '../../src/ai/rom/aiData.js';
import { type AiScript, extractAiScript } from '../../src/ai/rom/script.js';
import type { AiDeps, AiKnowledge, AiView } from '../../src/ai/view.js';
import { buildCatalog } from '../../src/battle/catalog.js';
import type { PlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData, ResolvedTrainer } from '../../src/battle/types.js';
import { loadLocalData } from '../../src/data/load.js';
import { computeStats } from '../../src/rom/stats.js';
import type { Stats } from '../../src/rom/types.js';
import { type CacheStatus, DATA_DIR, needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';

/** Vanilla US Platinum (game code CPUE). Like PK_ROM, it can be overridden by the environment variable of the same name. */

const caches = inject('realCaches');
const ROM_DIR = join(DATA_DIR, 'rom');
/** data/rom, which `npm run extract` writes: the planner's ROM data and the AI's (trainer-ai.json). */
const romExtract: CacheStatus = {
  name: 'ROM extract', dir: ROM_DIR,
  skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
    ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
};
const suite = needFiles("the docs' AI Changes tab on the hack's script", { PK_ROM }, [caches.docs, romExtract]);
const vanillaSuite = needFiles("the docs' AI Changes tab: the hack's script against vanilla's", { PK_ROM, PK_VANILLA_ROM }, [caches.docs, romExtract]);

/** One hand-picked Pokémon: the hack's species and moves, by name; the ability by name, any the test needs. */
interface MonSpec { species: string; ability: string; moves: string[]; level?: number }

/** What a test sets by hand on initialView's view. */
interface Patch {
  /** The AI's current HP, its maximum set to 100, so the percent the script reads is this number. */
  aiHp?: number;
  /** The AI's HP out of a maximum other than 100: [current, maximum]. */
  aiHpOf?: [number, number];
  aiSpeed?: number; playerSpeed?: number;
  aiAttackStage?: number;
}

/** "num/den", or "num" when the denominator is 1: a score's probability, readable in a failure. */
type ScoreDist = Record<number, string>;

let data: LoadedData;
let ai: AiRomData;
let hackScript: AiScript;
/** A real single-battle trainer, for the ROM record initialView reads (its bag); its party is replaced. */
let host: ResolvedTrainer;
let hostDeps: AiDeps;

function load(): void {
  data = loadLocalData(DATA_DIR);
  ai = loadAiData(ROM_DIR);
  hackScript = aiScriptOf(ai);
  // The cached script must be the ROM's: data/rom could be stale.
  expect(hackScript.sha256).toBe(extractAiScript(readFileSync(PK_ROM)).sha256);
  host = buildCatalog(data).trainers.find((trainer) => trainer.battleType === 'single')!;
  hostDeps = depsFor(host, data, ai);
}

function moveId(name: string): number {
  const id = data.names.moveId(name);
  if (id === null) throw new Error(`the hack has no move ${name}`);
  return id;
}

function abilityId(name: string): number {
  const id = data.names.abilityId(name);
  if (id === null) throw new Error(`no ability ${name}`);
  return id;
}

/** A Lv 50 (or `spec.level`) Pokémon with 31 IVs, no EVs, a neutral nature (Hardy), no item, full HP and PP. */
function mon(spec: MonSpec): PlayerMon {
  const found = data.names.speciesId(spec.species);
  if (found === null) throw new Error(`the hack has no species ${spec.species}`);
  const record = data.rom.species[found.id]!;
  const level = spec.level ?? 50;
  const ivs: Stats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const evs: Stats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const moves = spec.moves.map(moveId);
  return {
    species: found.id, form: found.form, name: spec.species, nickname: spec.species, level, gender: null, ivs, evs,
    nature: { value: 0, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: abilityId(spec.ability), source: 'rom', disputed: false, alternatives: [] },
    item: 0, moves, pp: moves.map((move) => data.rom.moves[move]!.pp), ppUps: moves.map(() => 0),
    baseStats: { ...record.baseStats }, types: [record.types[0], record.types[1]], friendship: 70,
    status: { kind: 'none' }, currentHp: computeStats(record.baseStats, ivs, evs, level, 0).hp, location: { kind: 'party', slot: 0 },
    notes: [],
  };
}

/** initialView for `aiMon` against `player`, then `patch`. The views list nothing unknown. */
function view(aiMon: MonSpec, player: MonSpec, patch: Patch = {}, field: Pick<InitialViewInput, 'weather'> = {}): AiView {
  const v = initialView({
    player: [mon(player)], trainer: { ...host, field: null, party: [mon(aiMon)] }, world: { enemy: [{}] }, ...field,
  }, data, ai);
  expect(v.unknown).toEqual([]);
  const aiBattler = { ...v.mons[1], statBoosts: [...v.mons[1].statBoosts] };
  const playerBattler = { ...v.mons[0] };
  if (patch.aiHp !== undefined) [aiBattler.curHP, aiBattler.maxHP] = [patch.aiHp, 100];
  if (patch.aiHpOf !== undefined) [aiBattler.curHP, aiBattler.maxHP] = patch.aiHpOf;
  if (patch.aiSpeed !== undefined) aiBattler.speed = patch.aiSpeed;
  if (patch.playerSpeed !== undefined) playerBattler.speed = patch.playerSpeed;
  if (patch.aiAttackStage !== undefined) aiBattler.statBoosts[BATTLE_STAT.ATTACK] = patch.aiAttackStage;
  return {
    ...v,
    mons: [playerBattler, aiBattler, v.mons[2], v.mons[3]],
    parties: [v.parties[0], [{ ...v.parties[1][0]!, hp: aiBattler.curHP, maxHp: aiBattler.maxHP }]],
    // What the battle-start speed comparison writes, with neutral stages, no items and no speed abilities.
    monSpeedValues: [playerBattler.speed, aiBattler.speed, 0, 0],
  };
}

/** Zero knowledge (battle start), or with the player's ability revealed. */
function knowledge(playerAbility?: string): AiKnowledge {
  const k = initialMemoryData(null).knowledge;
  if (playerAbility !== undefined) k.battlerAbilities[0] = abilityId(playerAbility);
  return k;
}

/** Slot `slot`'s final score under `flag` alone, each score with its probability. */
function scores(v: AiView, flag: number, slot: number, k: AiKnowledge = knowledge(), script: AiScript = hackScript): ScoreDist {
  const d: AiDeps = { ...hostDeps, script, aiFlags: flag };
  return Object.fromEntries(slotScores(v, d, k, slot).map(({ score, probability }) => [
    score, probability.den === 1n ? `${probability.num}` : `${probability.num}/${probability.den}`,
  ]));
}

/** Each slot of `v`'s AI that holds a move, in order, scored under `flag`. */
function allSlots(v: AiView, flag: number, k?: AiKnowledge): ScoreDist[] {
  return v.mons[1].moves.flatMap((move, slot) => (move === 0 ? [] : [scores(v, flag, slot, k)]));
}

const VAPOREON_HYDRO_PUMP: MonSpec = { species: 'Vaporeon', ability: 'Hydration', moves: ['Hydro Pump'] };
const TOXICROAK: MonSpec = { species: 'Toxicroak', ability: 'Dry Skin', moves: ['Poison Jab'] };

describe.skipIf(suite.skip)(suite.title, () => {
  beforeAll(load);

  it('Dry Skin is respected: Basic_CheckForImmunity branches on ABILITY_DRY_SKIN to Basic_CheckWaterAbsorption2 (−12)', () => {
    // Basic (bit 0) damage-scores Hydro Pump (a plain Water hit, effect 0), so it reaches Basic_CheckForImmunity.
    expect(data.rom.moves[moveId('Hydro Pump')]).toMatchObject({ effect: 0, type: 11, category: 'special' });
    const v = view(VAPOREON_HYDRO_PUMP, TOXICROAK);
    // The hack's Toxicroak has Dry Skin in both ability slots, so with nothing revealed the AI takes it to have Dry
    // Skin either way of LoadBattlerAbility's coin (trainer_ai.c:1191–1199).
    expect(scores(v, AI_FLAG_BASIC, 0)).toEqual({ 88: '1' });
    // Revealed: the same.
    expect(scores(v, AI_FLAG_BASIC, 0, knowledge('Dry Skin'))).toEqual({ 88: '1' });
    // Against a target known to have another ability, no penalty.
    expect(scores(v, AI_FLAG_BASIC, 0, knowledge('Anticipation'))).toEqual({ 100: '1' });
    expect(scores(view(VAPOREON_HYDRO_PUMP, { species: 'Snorlax', ability: 'Thick Fat', moves: ['Body Slam'] }), AI_FLAG_BASIC, 0)).toEqual({ 100: '1' });
    // A Mold Breaker attacker skips the ability checks (Basic_NoImmunityAbility).
    const moldBreaker = view({ ...VAPOREON_HYDRO_PUMP, ability: 'Mold Breaker' }, TOXICROAK);
    expect(scores(moldBreaker, AI_FLAG_BASIC, 0, knowledge('Dry Skin'))).toEqual({ 100: '1' });
  });

  it('half-recoil moves use the intended routine: effect 48 reaches Expert_RecoilMove; Head Smash (269) is the exception', () => {
    const attacker = (ability: string): MonSpec => ({ species: 'Aggron', ability, moves: ['Hyper Beam', 'Draco Meteor', 'Giga Impact', 'Head Smash'] });
    // The tab's 1/2-recoil moves have effect 48 in the hack (vanilla's RECOIL_QUARTER); Head Smash keeps RECOIL_HALF.
    expect(['Hyper Beam', 'Draco Meteor', 'Giga Impact', 'Head Smash'].map((name) => data.rom.moves[moveId(name)]!.effect)).toEqual([48, 48, 48, 269]);
    const snorlax: MonSpec = { species: 'Snorlax', ability: 'Thick Fat', moves: ['Body Slam'], level: 100 };
    const bronzong: MonSpec = { species: 'Bronzong', ability: 'Levitate', moves: ['Gyro Ball'], level: 100 };
    const gengar: MonSpec = { species: 'Gengar', ability: 'Shadow Tag', moves: ['Shadow Ball'], level: 100 };

    // Expert (bit 2): Expert_RecoilMove (script.s:1661 for effect 48, :1806 for 269) gives a Rock Head or Magic Guard
    // attacker +1 unless the target is immune or resists. Snorlax resists none of the four; Bronzong resists all four;
    // Gengar is immune to the two Normal moves only.
    expect(allSlots(view(attacker('Rock Head'), snorlax), AI_FLAG_EXPERT)).toEqual([{ 101: '1' }, { 101: '1' }, { 101: '1' }, { 101: '1' }]);
    expect(allSlots(view(attacker('Magic Guard'), snorlax), AI_FLAG_EXPERT)).toEqual([{ 101: '1' }, { 101: '1' }, { 101: '1' }, { 101: '1' }]);
    expect(allSlots(view(attacker('Sturdy'), snorlax), AI_FLAG_EXPERT)).toEqual([{ 100: '1' }, { 100: '1' }, { 100: '1' }, { 100: '1' }]);
    expect(allSlots(view(attacker('Rock Head'), bronzong), AI_FLAG_EXPERT)).toEqual([{ 100: '1' }, { 100: '1' }, { 100: '1' }, { 100: '1' }]);
    expect(allSlots(view(attacker('Rock Head'), gengar), AI_FLAG_EXPERT)).toEqual([{ 100: '1' }, { 101: '1' }, { 100: '1' }, { 101: '1' }]);

    // The exception: effect 48 isn't in sNoDamageCalcMoveEffects (trainer_ai.c:31–46), so the AI damage-scores the
    // three; RECOIL_HALF is, so it never damage-scores Head Smash. Under EvalAttack (bit 1), FlagMoveDamageScore gives
    // a move that a damage-scored slot out-damages −1 (AI_NOT_HIGHEST_DAMAGE). Aggron's Attack beats its Sp. Atk, so
    // Giga Impact out-damages Hyper Beam and Draco Meteor; Head Smash's 150-power Rock STAB would out-damage them all,
    // but it isn't estimated (damage 0), so Giga Impact keeps 100 and Head Smash, never compared, keeps 100 too. A
    // Lv 50 Aggron can't knock out a Lv 100 Snorlax, so no kill bonus.
    expect(allSlots(view(attacker('Rock Head'), snorlax), AI_FLAG_EVAL_ATTACK)).toEqual([{ 99: '1' }, { 99: '1' }, { 100: '1' }, { 100: '1' }]);
  });

  it('quarter-recoil routine: effect 182 reaches Expert_Superpower, its −1s at exactly 59% and 40%, and a fourth condition', () => {
    // Take Down, Close Combat and Brave Bird have effect 182 in the hack (vanilla's LOWER_OWN_ATK_AND_DEF), which Expert
    // sends to Expert_Superpower (script.s:1735, routine at :4467).
    const moves = ['Take Down', 'Close Combat', 'Brave Bird'];
    expect(moves.map((name) => data.rom.moves[moveId(name)]!.effect)).toEqual([182, 182, 182]);
    const heracross: MonSpec = { species: 'Heracross', ability: 'Guts', moves };
    const garchomp: MonSpec = { species: 'Garchomp', ability: 'Sand Veil', moves: ['Earthquake'] };
    /** Each of the three moves' score under Expert, for one view. */
    const expert = (v: AiView) => allSlots(v, AI_FLAG_EXPERT);
    const each = (score: number) => [{ [score]: '1' }, { [score]: '1' }, { [score]: '1' }];
    const SLOWER = { aiSpeed: 100, playerSpeed: 200 };
    const FASTER = { aiSpeed: 200, playerSpeed: 100 };
    const TIE = { aiSpeed: 150, playerSpeed: 150 };

    // Garchomp takes all three neutrally, so only HP, speed and the Attack stage decide.
    // Slower and HP >= 60% (IfHPPercentLessThan 60 skips the −1): −1. At exactly 59%, nothing.
    expect(expert(view(heracross, garchomp, { ...SLOWER, aiHp: 60 }))).toEqual(each(99));
    expect(expert(view(heracross, garchomp, { ...SLOWER, aiHp: 59 }))).toEqual(each(100));
    // Faster and HP > 40% (IfHPPercentGreaterThan 40): −1. At exactly 40%, nothing.
    expect(expert(view(heracross, garchomp, { ...FASTER, aiHp: 41 }))).toEqual(each(99));
    expect(expert(view(heracross, garchomp, { ...FASTER, aiHp: 40 }))).toEqual(each(100));
    // Each boundary in the other speed order: 59% faster is above 40% (−1); 40% slower is below 60% (nothing).
    expect(expert(view(heracross, garchomp, { ...FASTER, aiHp: 59 }))).toEqual(each(99));
    expect(expert(view(heracross, garchomp, { ...SLOWER, aiHp: 40 }))).toEqual(each(100));
    // The percent is curHP * 100 / maxHP in C integers (trainer_ai.c:596): 89/150 is 59.3%, read as 59.
    expect(expert(view(heracross, garchomp, { ...SLOWER, aiHpOf: [89, 150] }))).toEqual(each(100));
    expect(expert(view(heracross, garchomp, { ...SLOWER, aiHpOf: [90, 150] }))).toEqual(each(99));
    // A speed tie counts as faster: the routine tests only COMPARE_SPEED_SLOWER, and a tie's coin gives FASTER or TIE.
    expect(expert(view(heracross, garchomp, { ...TIE, aiHp: 41 }))).toEqual(each(99));
    expect(expert(view(heracross, garchomp, { ...TIE, aiHp: 59 }))).toEqual(each(99));
    expect(expert(view(heracross, garchomp, { ...TIE, aiHp: 40 }))).toEqual(each(100));

    // Resisted or immune: −1, whatever the HP and speed (here faster at 40%, which alone gives nothing).
    const resisted = { ...FASTER, aiHp: 40 };
    // Bronzong (Steel/Psychic) resists Take Down and Brave Bird; Close Combat is neutral (Steel ×2, Psychic ×½).
    expect(expert(view(heracross, { species: 'Bronzong', ability: 'Levitate', moves: ['Gyro Ball'] }, resisted))).toEqual([{ 99: '1' }, { 100: '1' }, { 99: '1' }]);
    // Aggron (Steel/Rock) takes a quarter from Take Down and Brave Bird; Close Combat is super-effective (×4).
    expect(expert(view(heracross, { species: 'Aggron', ability: 'Sturdy', moves: ['Iron Tail'] }, resisted))).toEqual([{ 99: '1' }, { 100: '1' }, { 99: '1' }]);
    // Gengar is immune to Take Down and Close Combat; Brave Bird hits it.
    expect(expert(view(heracross, { species: 'Gengar', ability: 'Shadow Tag', moves: ['Shadow Ball'] }, resisted))).toEqual([{ 99: '1' }, { 99: '1' }, { 100: '1' }]);

    // The fourth condition, which the tab leaves out: the attacker's Attack stage below 6 (IfStatStageLessThan
    // AI_BATTLER_ATTACKER, BATTLE_STAT_ATTACK, 6): −1. At stage 6, nothing.
    expect(expert(view(heracross, garchomp, { ...resisted, aiAttackStage: 5 }))).toEqual(each(99));
    expect(expert(view(heracross, garchomp, { ...resisted, aiAttackStage: 6 }))).toEqual(each(100));
    // The conditions don't add up: the first that holds gives −1 and ends the routine.
    expect(expert(view(heracross, { species: 'Gengar', ability: 'Shadow Tag', moves: ['Shadow Ball'] }, { ...SLOWER, aiHp: 100, aiAttackStage: 0 })))
      .toEqual(each(99));
  });

  it('Triple Axel and Fury Cutter are Risky (effect 88 in Risky_RiskyEffects); Triple Kick and Rock Wrecker (104) are not', () => {
    const moves = ['Triple Axel', 'Fury Cutter', 'Triple Kick', 'Rock Wrecker'];
    expect(moves.map((name) => data.rom.moves[moveId(name)]!.effect)).toEqual([88, 88, 104, 104]);
    const v = view({ species: 'Heracross', ability: 'Guts', moves }, { species: 'Snorlax', ability: 'Thick Fat', moves: ['Body Slam'] });
    // Risky (bit 4): an effect in Risky_RiskyEffects (script.s:6536–6562) gets +2 unless IfRandomLessThan 128 skips it,
    // which is RandNext() % 256 < 128: half of the time.
    expect(allSlots(v, AI_FLAG_RISKY)).toEqual([{ 100: '1/2', 102: '1/2' }, { 100: '1/2', 102: '1/2' }, { 100: '1' }, { 100: '1' }]);
  });

  it('Hurricane does not use the Thunder routine: no Expert routine tests effect 141, and Expert_Thunder never runs', () => {
    // Hurricane has effect 141 (BATTLE_EFFECT_UNUSED_141), which no Expert_Main entry tests. Thunder keeps 152, and
    // Expert_Main's Thunder line tests SKIP_CHARGE_TURN_IN_SUN instead (script.s:1718–1719, the vanilla bug the hack
    // keeps), so neither gets Expert_Thunder's +1 in rain or its −3 (80%) in sun, nor anything else under Expert.
    expect(['Hurricane', 'Thunder'].map((name) => data.rom.moves[moveId(name)]!.effect)).toEqual([141, 152]);
    const aiMon: MonSpec = { species: 'Charizard', ability: 'Blaze', moves: ['Hurricane', 'Thunder'] };
    const snorlax: MonSpec = { species: 'Snorlax', ability: 'Thick Fat', moves: ['Body Slam'] };
    for (const weather of [undefined, 'rain', 'sun'] as const) {
      const v = view(aiMon, snorlax, {}, weather === undefined ? {} : { weather });
      expect(allSlots(v, AI_FLAG_EXPERT), weather ?? 'clear').toEqual([{ 100: '1' }, { 100: '1' }]);
    }
  });
});

describe.skipIf(vanillaSuite.skip)(vanillaSuite.title, () => {
  let vanillaScript: AiScript;

  beforeAll(() => {
    load();
    vanillaScript = extractAiScript(readFileSync(PK_VANILLA_ROM));
  });

  it('Dry Skin: vanilla\'s Basic_CheckForImmunity tests ABILITY_LEVITATE twice, so it gives no penalty (script.s:78)', () => {
    const v = view(VAPOREON_HYDRO_PUMP, TOXICROAK);
    expect(scores(v, AI_FLAG_BASIC, 0, knowledge('Dry Skin'), vanillaScript)).toEqual({ 100: '1' });
    expect(scores(v, AI_FLAG_BASIC, 0, knowledge('Dry Skin'), hackScript)).toEqual({ 88: '1' });
  });

  it('"bugged targeting" (1/2 recoil): not found in AI code; the scripts differ in the Dry Skin word alone', () => {
    // The tab says the half-recoil moves now follow the intended routine "instead of having bugged targeting".
    // docs/ai-changes.md ("1/2 recoil", "Bugged targeting") finds nothing in the AI that matches: the script differs
    // from vanilla's in one word, the Dry Skin argument, and the rest of overlay 14 only by relocations
    // (aiChangesDoc.test.ts checks the generated block). If the fix is real, it's in battle data, not the AI. There is
    // no targeting change for an AI test to score, so this test records the finding instead: it fails if the hack's
    // script gains any other change. Both scripts run from overlay 14 offset 0x4C84 to the overlay's end.
    const hack = extractAiScript(readFileSync(PK_ROM));
    expect(hack.words.length).toBe(vanillaScript.words.length);
    const differ = [...hack.words.keys()].filter((at) => hack.words[at] !== vanillaScript.words[at]);
    expect(differ).toHaveLength(1);
    expect([vanillaScript.words[differ[0]!], hack.words[differ[0]!]]).toEqual([ABILITY_LEVITATE, ABILITY_DRY_SKIN]);
  });
});
