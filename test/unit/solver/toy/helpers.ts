// Inputs for the toy engine: move and mon builders, placeholder PlayerMon and ResolvedTrainer records that name
// registry entries, a whole BattleInput, and a short text form of a Choice.

import type { PlayerMon } from '../../../../src/battle/playerMon.js';
import type { ResolvedTrainer } from '../../../../src/battle/types.js';
import type { BattleInput, Choice } from '../../../../src/contracts/engine.js';
import type { ToyMon, ToyMove, ToyRegistry } from './game.js';

export const mv = (name: string, damage: number[], extra: Partial<ToyMove> = {}): ToyMove => ({ name, damage, ...extra });
export const mon = (name: string, maxHp: number, speed: number, moves: ToyMove[], extra: Partial<ToyMon> = {}): ToyMon => ({ name, maxHp, speed, moves, ...extra });

const NO_STATS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

/** A PlayerMon whose `nickname` (and `name`) is a toy mon's registry key, the only field the toy engine reads. */
export function toyPlayerMon(name: string): PlayerMon {
  return {
    species: 0, form: 0, name, nickname: name, level: 1, gender: null, ivs: { ...NO_STATS }, evs: { ...NO_STATS },
    nature: { value: null, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: 0, source: 'rom', disputed: false, alternatives: [] },
    item: 0, moves: [], baseStats: { ...NO_STATS }, types: [0, 0], friendship: 255,
    status: { kind: 'none' }, currentHp: 0, pp: [], ppUps: [], location: { kind: 'party', slot: 0 }, notes: [],
  };
}

/** A ResolvedTrainer whose `id` (and `name`) is a toy trainer's key; 'double' only when `registry` marks it double. */
export function toyTrainer(id: string, registry?: ToyRegistry): ResolvedTrainer {
  return {
    id, name: id, split: 'toy', location: 'toy', order: 0, romIndex: 0, trainerClass: 0,
    battleType: registry?.trainers[id]?.double ? 'double' : 'single', aiFlags: [], field: null,
    tags: { starred: false, raw: [] }, levelMismatch: false, party: [], variants: [],
  };
}

/** `p1` lists registry mon keys, lead first; `field` is `{}`; `extra` (carry, startStatus, world…) is spread last. */
export function toyInput(registry: ToyRegistry, p1: string[], trainerId: string, extra?: Partial<BattleInput>): BattleInput {
  return { player: p1.map(toyPlayerMon), trainer: toyTrainer(trainerId, registry), field: {}, ...extra };
}

/** 'm0' (move slot 0), 's2' (switch to party index 2), 'i:potion' (bag item). */
export function choiceKey(c: Choice): string {
  switch (c.kind) {
    case 'move': return `m${c.slot}`;
    case 'switch': return `s${c.index}`;
    case 'item': return `i:${c.item}`;
  }
}
