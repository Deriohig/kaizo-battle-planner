// A fight's battle start, shared by the line builder (src/server/lines.ts) and the solver (src/solver/inputs.ts and
// types.ts re-export it): the mon and fight info a BattleResolver gives, the PlanLabeler, and how a fight's battle is
// built. The team is kept in canonical (request) order; the engine sees the lead first and the rest in canonical order,
// so carries and pre-statuses are re-indexed both ways.
// CarryState convention (the toy and the real engine agree): `pp` lists the limited-PP moves only, in move order.
// The engine always gets an explicit carry. Without one it would start from the save's HP, PP and status, so a
// heal ("heal here", healBefore) is the healed carry, never "no carry".

import type { PlayerMon } from '../battle/playerMon.js';
import type { ResolvedTrainer } from '../battle/types.js';
import type { BattleInput, CarryState, Choice, EngineState, FieldSpec, Outcome, Side, WorldAssignment } from '../contracts/engine.js';
import type { FightSpec, MonRef } from '../contracts/solver.js';
import type { StartStatus } from '../save/status.js';

/**
 * `status`: the Pokémon's starting status: the save's own, or for a Pokémon from the draft pool its drafted status (its
 * HP is the drafted HP too). `fullPp`: each limited-PP move's max PP including PP Ups, in CarryState.pp order (what a
 * heal restores; `healedCarry` below).
 */
export interface MonInfo { ref: MonRef; mon: PlayerMon; maxHp: number; fullPp: number[]; status: StartStatus; label: string; preStatusCandidates: StartStatus[] }

/**
 * `worlds` has at least one entry ([{ enemy: [] }] when nothing is disputed). `benchMonotone`: no Roar/Whirlwind and no
 * AI read of the player's bench.
 */
export interface FightInfo { spec: FightSpec; trainer: ResolvedTrainer; field: FieldSpec; worlds: WorldAssignment[]; label: string; benchMonotone: boolean }

/** Both methods throw Error for an unknown id. */
export interface BattleResolver { mon(ref: MonRef): MonInfo; fight(spec: FightSpec): FightInfo }

export interface PlanLabeler {
  choice(state: EngineState, side: Side, choice: Choice): string;      // "Use Close Combat", "Switch to Staraptor"
  outcome(outcome: Outcome): string;                                    // "Rock Slide crits"
  killCause(outcome: Outcome, turn: number): string;                    // "enemy crit Rock Slide on turn 3 kills Staravia"
}

/** `team` in canonical (request) order; `startStatus` by MonRef (refs outside the team are ignored). */
export interface ArenaFight { info: FightInfo; team: MonInfo[]; startStatus: Record<MonRef, StartStatus>; healBefore: boolean }

/** Canonical team indices in engine order: the lead, then the others in canonical order (engine position → canonical index). */
export function engineOrder(size: number, lead: number): number[] {
  if (!Number.isInteger(lead) || lead < 0 || lead >= size) throw new RangeError(`lead ${lead} is outside a team of ${size}`);
  return [lead, ...Array.from({ length: size }, (_, i) => i).filter((i) => i !== lead)];
}

/** A mon's save HP, PP and status, as a carry entry. */
function savedCarry(info: MonInfo): CarryState['mons'][number] {
  return { hp: info.mon.currentHp, pp: [...info.mon.pp], status: info.status };
}

/** The team healed (canonical order): each mon at its max HP, its full PP (`fullPp`) and no status. */
export function healedCarry(team: readonly MonInfo[]): CarryState {
  return { mons: team.map((info) => ({ hp: info.maxHp, pp: [...info.fullPp], status: { kind: 'none' } })) };
}

/**
 * The canonical carry `fight` starts from: `carry` when given (the previous fight's end); else the healed carry when the
 * fight has `healBefore` (fight 0 included); else each mon's save HP, PP and status. The arena and the checker both
 * read a fight's start from here.
 */
export function startCarry(fight: ArenaFight, carry: CarryState | null): CarryState {
  const { team } = fight;
  if (carry !== null) {
    if (carry.mons.length !== team.length) throw new RangeError(`carry has ${carry.mons.length} mons for a team of ${team.length}`);
    return carry;
  }
  return fight.healBefore ? healedCarry(team) : { mons: team.map(savedCarry) };
}

/**
 * The battle for `lead` (a canonical team index) in `world`. `player` is the team with team[lead] moved to the front;
 * the start carry (startCarry: `carry`, else healed after `healBefore`, else the save's; canonical order) and
 * `startStatus` (by MonRef) are re-indexed to that order, so the input always has a carry. `ArenaFight.startStatus` is
 * applied at that fight's start, after the carry (the solve layer passes manual pre-status for fight 0 only).
 */
export function battleInput(fight: ArenaFight, lead: number, carry: CarryState | null, world: WorldAssignment): BattleInput {
  const { team } = fight;
  const order = engineOrder(team.length, lead);
  const start = startCarry(fight, carry);
  const input: BattleInput = {
    player: order.map((i) => team[i]!.mon), trainer: fight.info.trainer, field: fight.info.field, world, carry: { mons: order.map((i) => start.mons[i]!) },
  };
  const startStatus: Record<number, StartStatus> = {};
  order.forEach((canonical, position) => {
    const status = fight.startStatus[team[canonical]!.ref];
    if (status !== undefined) startStatus[position] = status;
  });
  if (Object.keys(startStatus).length > 0) input.startStatus = startStatus;
  return input;
}

/**
 * Engine order (lead first) → canonical order. The inverse of battleInput's re-indexing. Requires Engine.carryOut to
 * list p1 in battle-start (BattleInput.player) order regardless of switches.
 */
export function toCanonicalCarry(carry: CarryState, lead: number): CarryState {
  const order = engineOrder(carry.mons.length, lead);
  const mons: CarryState['mons'] = new Array(order.length);
  order.forEach((canonical, position) => {
    mons[canonical] = carry.mons[position]!;
  });
  return { mons };
}
