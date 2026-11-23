// The solver's BattleResolver over the save and the trainers (docs/solver-integration.md section 2): MonRef to
// MonInfo from the box the server read, and FightSpec to FightInfo from the trainer catalog, with one world per
// combination of disputed enemy data.

import type { KaizoMove } from '../battle/moves.js';
import type { PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, ResolvedMon, ResolvedTrainer, TrainerCatalog } from '../battle/types.js';
import type { FieldSpec, WorldAssignment } from '../contracts/engine.js';
import type { FightSpec, MonRef } from '../contracts/solver.js';
import type { LocalData } from '../data/load.js';
import type { FieldNote } from '../docs/teams.js';
import { computeStats } from '../rom/stats.js';
import type { StartStatus } from '../save/status.js';
import type { BattleResolver, FightInfo, MonInfo } from './fight.js';

/** What a resolver reads: the data and its catalog and moves (`ServerData`), and the box's eligible Pokémon by MonRef. */
export interface ResolverSource {
  data: Pick<LocalData, 'rom'>; catalog: TrainerCatalog; moves: ReadonlyMap<number, KaizoMove>;
  mons: ReadonlyMap<MonRef, PlayerMon>;
}

/**
 * The resolver over `src`. `mon(ref)` reads `src.mons` (the eligible Pokémon only), `fight(spec)` the catalog; both throw
 * an Error naming the unknown ref, trainer or variant.
 */
export function createResolver(src: ResolverSource): BattleResolver {
  let names: Map<MonRef, string> | null = null;
  return {
    mon(ref: MonRef): MonInfo {
      const mon = src.mons.get(ref);
      if (mon === undefined) throw new Error(`No eligible Pokémon at ${ref} in the save`);
      names ??= pageNames(src.mons);
      return { ...monInfo(ref, mon, src.data), label: names.get(ref) ?? monLabel(mon.nickname, mon.name) };
    },
    fight(spec: FightSpec): FightInfo {
      const listed = src.catalog.byId(spec.trainerId);
      if (listed === undefined) throw new Error(`No trainer ${spec.trainerId}`);
      const variant = spec.variant ?? 0;
      const trainer = variant === 0 ? listed : listed.variants[variant - 1];
      if (trainer === undefined || !Number.isInteger(variant) || variant < 0) {
        throw new Error(`${listed.name} (${spec.trainerId}) has no variant ${variant}: it has ${1 + listed.variants.length} copies`);
      }
      return {
        spec: { ...spec }, trainer, field: fieldSpec(trainer.field), worlds: fightWorlds(trainer.party),
        label: variant === 0 ? trainer.name : `${trainer.name} (copy ${variant + 1})`,
        benchMonotone: false,
      };
    },
  };
}

/**
 * MonInfo for `mon` at `ref`: the stat formula's max HP, each move's max PP with its PP Ups (floor(base × (5 + ups) / 5),
 * the ROM's base PP), the save's status (a box Pokémon's is none: `toPlayerMon`), the page's name for it, and the
 * pre-statuses the solver may propose.
 */
export function monInfo(ref: MonRef, mon: PlayerMon, data: Pick<LocalData, 'rom'>): MonInfo {
  const fullPp = mon.moves.map((id, k) => {
    const base = data.rom.moves[id]?.pp;
    if (base === undefined) throw new Error(`${ref}: the ROM has no move ${id}`);
    return Math.floor((base * (5 + (mon.ppUps[k] ?? 0))) / 5);
  });
  return {
    ref, mon, maxHp: computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, mon.nature.value ?? 0).hp, fullPp,
    status: { ...mon.status }, label: monLabel(mon.nickname, mon.name), preStatusCandidates: preStatusCandidates(mon),
  };
}

/**
 * Every Pokémon's page name, by MonRef (the one naming rule for MonInfo.label and the labeler): `monLabel`, and where
 * several share that name, a tie-breaker: " (Lv <level>)" when their levels all differ, else their place, " (party 2)"
 * or " (box 1 slot 1)".
 */
export function pageNames(mons: ReadonlyMap<MonRef, PlayerMon>): Map<MonRef, string> {
  const byName = new Map<string, [MonRef, PlayerMon][]>();
  for (const [ref, mon] of mons) {
    const name = monLabel(mon.nickname, mon.name);
    const same = byName.get(name);
    if (same === undefined) byName.set(name, [[ref, mon]]);
    else same.push([ref, mon]);
  }
  const names = new Map<MonRef, string>();
  for (const [name, same] of byName) {
    if (same.length === 1) {
      names.set(same[0]![0], name);
      continue;
    }
    const byLevel = new Set(same.map(([, mon]) => mon.level)).size === same.length;
    for (const [ref, mon] of same) {
      const where = mon.location.kind === 'party' ? `party ${mon.location.slot}` : `box ${mon.location.box} slot ${mon.location.slot}`;
      names.set(ref, `${name} (${byLevel ? `Lv ${mon.level}` : where})`);
    }
  }
  return names;
}

/** The page's name for a Pokémon: its nickname, or its species when it has none or the game's default (the species in capitals). */
export function monLabel(nickname: string, species: string): string {
  return nickname === '' || nickname.toLowerCase() === species.toLowerCase() ? species : nickname;
}

const ABILITY = { naturalCure: 30, guts: 62, marvelScale: 63, poisonHeal: 90, quickFeet: 95 } as const;
const MOVE = { snore: 173, sleepTalk: 214 } as const;
const PRE_SLEEP: StartStatus = { kind: 'sleep', turns: 1 };
const ANY_STATUS: StartStatus[] = [{ kind: 'burn' }, { kind: 'poison' }, { kind: 'toxic' }, { kind: 'paralysis' }];

/**
 * The statuses the solver may propose for `mon`: only ones that change its fight.
 * Guts, Marvel Scale and Quick Feet gain from any status; Poison Heal from poison; Natural Cure sheds a pre-sleep or
 * poison on switching out, which blocks the AI's worse status; a Sleep Talk or Snore user may start asleep. A third
 * case (a Pokémon whose likeliest death is the AI's status move) depends on the fight and is not proposed here.
 */
export function preStatusCandidates(mon: BattleMon): StartStatus[] {
  const ability = mon.ability.value;
  if (ability === ABILITY.guts || ability === ABILITY.marvelScale || ability === ABILITY.quickFeet) return ANY_STATUS.map((s) => ({ ...s }));
  if (ability === ABILITY.poisonHeal) return [{ kind: 'poison' }, { kind: 'toxic' }];
  if (ability === ABILITY.naturalCure) return [{ ...PRE_SLEEP }, { kind: 'poison' }];
  if (mon.moves.includes(MOVE.sleepTalk) || mon.moves.includes(MOVE.snore)) return [{ ...PRE_SLEEP }];
  return [];
}

/** The engine's FieldSpec for a docs field note: its weather, fog, Trick Room and Gravity; none gives `{}`. */
export function fieldSpec(note: FieldNote | null): FieldSpec {
  const field: FieldSpec = {};
  if (note?.weather !== undefined) field.weather = note.weather;
  if (note?.fog === true) field.fog = true;
  if (note?.trickRoom === true) field.trickRoom = true;
  if (note?.gravity === true) field.gravity = true;
  return field;
}

/**
 * A nature's proof-relevant numbers for `mon`: all six stats and the stat it lowers (the flavour it dislikes, which a
 * confusion berry reads; any Pokémon can come to hold one through Thief, Covet, Trick, Bug Bite, Pluck and the like).
 * Nothing is left out for a stat the Pokémon seems not to use: the AI's post-KO replacement reads a fainted Pokémon's
 * Special Attack whatever its moves (docs/solver-integration.md section 2: judge conservatively). Natures with the same
 * key fight alike.
 */
function natureKey(mon: BattleMon, nature: number): string {
  const stats = computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, nature);
  const lowers = Math.floor(nature / 5) !== nature % 5 ? nature % 5 : -1;
  return `${JSON.stringify(stats)}|${lowers}`;
}

/** The candidate natures of one enemy Pokémon, one per proof-relevant group, the trainer's value first. */
function natureCandidates(mon: BattleMon): number[] {
  const all = [mon.nature.value, ...mon.nature.alternatives].filter((n): n is number => n !== null);
  const seen = new Set<string>();
  const kept: number[] = [];
  for (const nature of all) {
    const key = natureKey(mon, nature);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(nature);
  }
  return kept;
}

/**
 * The fight's worlds (docs/solver-integration.md section 2): for each enemy party index, the nature candidates
 * (`value` plus `alternatives`, collapsed where they give the same proof-relevant numbers: `natureKey`) and the ability
 * candidates (all kept), then their product over the party, the trainer's own values first. An index with one
 * candidate of each gets `{}`; a fight with nothing disputed gives `[{ enemy: [] }]`.
 */
export function fightWorlds(party: readonly ResolvedMon[]): WorldAssignment[] {
  const options = party.map((mon) => {
    const natures = natureCandidates(mon);
    const abilities = [...new Set([mon.ability.value, ...mon.ability.alternatives])];
    const entries: WorldAssignment['enemy'][number][] = [];
    const disputedNature = natures.length > 1;
    const disputedAbility = abilities.length > 1;
    for (const nature of disputedNature ? natures : [undefined]) {
      for (const ability of disputedAbility ? abilities : [undefined]) {
        entries.push({ ...(nature !== undefined && { nature }), ...(ability !== undefined && { ability }) });
      }
    }
    return entries;
  });
  if (options.every((entries) => entries.length === 1 && Object.keys(entries[0]!).length === 0)) return [{ enemy: [] }];
  let worlds: WorldAssignment['enemy'][] = [[]];
  for (const entries of options) worlds = worlds.flatMap((prefix) => entries.map((entry) => [...prefix, { ...entry }]));
  return worlds.map((enemy) => ({ enemy }));
}
