/**
 * The plan screen's pure helpers: the pool of Pokémon a plan may use, the two moves it shows and the exchange's tone, the
 * turn order in one line, and the words its one status region says. Nothing here works out an outcome.
 */
import type {
  AiOddsLevel, BoxMonJson, DraftMonJson, LineDamageJson, LineMoveDamageJson, MonRef,
} from '../../../../src/server/apiTypes.js';
import { formatOdds } from '../../format.js';
import { monName, speedOrderText } from '../../labels.js';
import type { Plan, PlanMon, PlanPick, PlanStart, ResolvedTurn } from '../../plan.js';
import { hpBarText, likeliestMove, likeliestMoveAt, type StepPanel } from '../../tree.js';
import { same } from '../../useDraft.js';

/** The tree's `LineNodeJson` fields a step answer shares (web/src/tree.ts). */
export type { StepPanel };

/** The draft's entry for `ref`, or a bare `{ ref }`. */
export const entryOf = (draft: readonly DraftMonJson[], ref: MonRef): DraftMonJson => draft.find((d) => d.ref === ref) ?? { ref };

export function planMonOf(mon: BoxMonJson, draft: readonly DraftMonJson[]): PlanMon {
  return { key: mon.key, ref: mon.ref, name: monName(mon), entry: entryOf(draft, mon.ref) };
}

export function startOf(
  fight: { trainerId: string; variant: number }, lead: MonRef, team: readonly MonRef[], mons: ReadonlyMap<MonRef, BoxMonJson>,
  draft: readonly DraftMonJson[], enemies: readonly string[],
): PlanStart | null {
  const leadMon = mons.get(lead);
  if (leadMon === undefined) return null;
  const pool = team.filter((ref) => mons.has(ref)).map((ref) => planMonOf(mons.get(ref)!, draft));
  return { trainerId: fight.trainerId, variant: fight.variant, world: 0, mons: pool, lead: leadMon.key, enemies: [...enemies] };
}

/**
 * The team in order, then the plan's other pool Pokémon (a tried box Pokémon) that the box still has; each as the draft has
 * it now. A pool Pokémon is found by its key (the PID), never by its old ref, which after a save change may be another
 * Pokémon's: the one still at its ref first, else wherever the box has it now. One the team already holds is not added again.
 */
export function poolNow(
  plan: Plan, team: readonly MonRef[], mons: ReadonlyMap<MonRef, BoxMonJson>, draft: readonly DraftMonJson[],
): PlanMon[] {
  const out: PlanMon[] = team.filter((ref) => mons.has(ref)).map((ref) => planMonOf(mons.get(ref)!, draft));
  const held = (m: BoxMonJson) => out.some((o) => o.key === m.key || o.ref === m.ref);
  for (const pm of plan.start.mons) {
    if (out.some((o) => o.key === pm.key)) continue;
    const at = mons.get(pm.ref);
    let mon = at !== undefined && at.key === pm.key && !held(at) ? at : undefined;
    if (mon === undefined) for (const m of mons.values()) if (m.key === pm.key && !held(m)) { mon = m; break; }
    if (mon !== undefined) out.push(planMonOf(mon, draft));
  }
  return out;
}

export function poolDiffers(plan: Plan, next: readonly PlanMon[]): boolean {
  const view = (m: PlanMon) => ({ key: m.key, ref: m.ref, entry: m.entry });
  return !same(plan.start.mons.map(view), next.map(view));
}

/** Every trainer's Pokémon index marked fainted up to and including the last turn's mark. */
export function markedTheirs(turns: readonly ResolvedTurn[]): number[] {
  const last = turns[turns.length - 1];
  if (!last) return [];
  return last.fainted.theirs && last.theirs !== null ? [...last.faintedBefore.theirs, last.theirs] : [...last.faintedBefore.theirs];
}

export function markedMine(turns: readonly ResolvedTurn[]): string[] {
  const last = turns[turns.length - 1];
  if (!last) return [];
  return last.fainted.mine && last.mine !== null ? [...last.faintedBefore.mine, last.mine] : [...last.faintedBefore.mine];
}

export function shownMine(step: StepPanel | null, pick: PlanPick | null): LineMoveDamageJson | null {
  if (step === null || pick === null || pick.kind !== 'move' || !step.damage) return null;
  return step.damage.yours.find((m) => m.slot === pick.slot) ?? null;
}

/**
 * Their move the exchange shows: the one picked in the reply list, else their likeliest, with its odds. Below the full AI
 * odds (aiOdds.ts) it has no odds (`percent` and `exact` null) but its place in the AI's order (`rank`, null where the AI
 * gives none; `tied` when another shares it), and with no likeliest to show (`off`, or a top that is no move) it is their
 * first move, so the exchange still shows both sides.
 */
export function shownTheirs(
  step: StepPanel | null, picked: string | null, level: AiOddsLevel = 'full',
): { move: LineMoveDamageJson; likeliest: boolean; percent: string | null; exact: string | null; rank?: number | null; tied?: boolean } | null {
  const theirs = step?.damage?.theirs;
  if (!step || !theirs) return null;
  const choices = step.aiOdds?.choices;
  if (level !== 'full') {
    const ranked = level === 'off' ? [] : (choices ?? []);
    const pickedMove = picked === null ? undefined : theirs.find((m) => m.name === picked);
    const top = likeliestMoveAt(step, level);
    const move = pickedMove ?? theirs.find((m) => m.name === top) ?? theirs[0];
    if (move === undefined) return null;
    const rank = ranked.find((c) => c.label === move.name)?.rank ?? null;
    return {
      move, likeliest: pickedMove === undefined && top !== null, percent: null, exact: null,
      rank, tied: rank !== null && ranked.filter((c) => c.rank === rank).length > 1,
    };
  }
  /** The move's odds as a percent and as the exact fraction (every odds figure keeps its `title`). */
  const oddsOf = (name: string): { percent: string | null; exact: string | null } => {
    const c = choices?.find((x) => x.label === name);
    if (!c?.probability) return { percent: null, exact: null };
    const { percent, exact } = formatOdds(`${c.probability.num}/${c.probability.den}`);
    return { percent, exact };
  };
  if (picked !== null) {
    const move = theirs.find((m) => m.name === picked);
    if (move) return { move, likeliest: false, ...oddsOf(move.name) };
  }
  // The likeliest is the reply list's own (`likeliestMove`), so the list, the split rows and his card's band agree on a tie.
  const name = likeliestMove(step);
  const move = name === null ? undefined : theirs.find((m) => m.name === name);
  return move === undefined ? null : { move, likeliest: true, ...oddsOf(move.name) };
}

/**
 * The tone of the exchange line for a move on his Pokémon, as the likelihood list has it: 'danger' when one hit
 * can KO him, 'warn' when only a crit can (or a held item he has survives the hit that would), else none.
 */
export function koStripe(move: LineMoveDamageJson): 'danger' | 'warn' | null {
  const k1 = move.koExact?.[0];
  if (move.status || k1 === undefined) return null;
  const can = k1.num !== '0';
  if (move.survives != null) return can ? 'warn' : null;
  if (can) return 'danger';
  return move.koCritExact !== null && move.koCritExact.num !== '0' ? 'warn' : null;
}

/**
 * Who moves first, by name, in one line beside "Your action", in `speedOrderText`'s words (the start rows' and
 * Matchups' too): "Miltank moves first · Speed 65 vs 52", the first mover's Speed first; "Speed tie at 21: either moves
 * first". " · at equal priority" when any move on the field has another
 * priority, and the items that can change it, as `turnOrderText` words them. "Speed order not worked out here." when the
 * numbers have no order; null without numbers.
 */
export function orderLine(damage: LineDamageJson | undefined, mine: string, theirs: string): string | null {
  if (damage === undefined) return null;
  const { order } = damage;
  if (order === null) return 'Speed order not worked out here.';
  const { first, player, enemy, changers } = order;
  const prioritised = [...damage.yours, ...damage.theirs].some((m) => m.priority !== 0);
  const words = speedOrderText(first, mine, theirs, player, enemy) + (first !== 'tie' && prioritised ? ' · at equal priority' : '');
  return changers.length === 0 ? words : `${words} · ${changers.join(' or ')} can change this`;
}

export function turnSaid(turn: ResolvedTurn, step: StepPanel | null): string {
  const head = `Turn ${turn.turn}.`;
  const mine = step?.view.player.active;
  const theirs = step?.view.enemy.active;
  if (!mine || !theirs) return head;
  const his = monName({ nickname: mine.name, species: mine.species });
  return `${head} ${his} ${mine.hp}/${mine.maxHp} against ${theirs.name} ${hpBarText(theirs)}.`;
}

export const planWorkingText = (turn: number, slow: boolean): string => (slow ? `Still working out turn ${turn}.` : `Working out turn ${turn}…`);

export const clearedText = (turns: number): string => `Plan cleared (${turns} ${turns === 1 ? 'turn' : 'turns'}).`;

/** What the plan's one status region holds, and the arrival, `slow`, notices and cleared plan it was said for. */
export interface Heard { seq: number; slow: boolean; notices: readonly string[]; cleared: number | null; text: string }

/**
 * What the status region says next, or null when nothing it speaks of changed:
 * - an arrival says its sentence (`arrival()`), then the notices that came with it, so one event is one announcement;
 * - a cleared plan says `clearedText`; when that offer goes with nothing arriving it is taken back;
 * - a notice that shows by itself is said alone; one that shows while a step is worked out (`busy`) waits for the step's end;
 * - once a step is slow it says `working()`, and a step that stops being slow with nothing arriving takes that back.
 */
export function hear(
  prev: Heard, now: { seq: number; slow: boolean; busy: boolean; notices: readonly string[]; cleared: number | null }, arrival: () => string | null,
  working: () => string,
): Heard | null {
  const notices = now.busy ? prev.notices : now.notices;
  if (now.seq === prev.seq && now.slow === prev.slow && same(notices, prev.notices) && now.cleared === prev.cleared) return null;
  const fresh = notices.filter((notice) => !prev.notices.includes(notice));
  let text = prev.text;
  if (now.seq !== prev.seq) text = [arrival(), ...fresh].filter((words): words is string => words !== null).join(' ') || prev.text;
  else if (now.cleared !== null && prev.cleared === null) text = clearedText(now.cleared);
  else if (fresh.length > 0) text = fresh.join(' ');
  else if (now.slow && !prev.slow) text = working();
  else if (!now.slow && prev.slow) text = '';
  else if (now.cleared === null && prev.cleared !== null) text = '';
  return { seq: now.seq, slow: now.slow, notices, cleared: now.cleared, text };
}
