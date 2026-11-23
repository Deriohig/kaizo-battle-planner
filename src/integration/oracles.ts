// The checker's damage and speed oracles (docs/solver-integration.md section 5): each engine step the checker replays is
// compared with the calc's own numbers. Any mismatch makes the verdict unproven, so both only compare what they can model
// exactly: everything is read from the step's `before` state (battleView.ts), and a hit is skipped (no check counted)
// as soon as anything in the step could have changed what it depends on. `checks` counts the comparisons made. Every
// damaging hit the damage oracle does not compare is named in `skipped` under its move's display name, one per damage
// line or Substitute hit, so the verdict lists the hits nothing cross-checked: the calc gives no result, is
// unbounded or the move is an OHKO move; a multi-hit move; False Swipe; the fallback's roll-dependent KO; a hit a
// Substitute takes; or a hit skipped while reading the log (after a change, a copied or called move, an interruption, a
// Pokémon with no view). Damage no move dealt (`[from]` lines: residuals, recoil, items, abilities, hazards, confusion)
// is never a hit.
//
// The damage oracle. Each move's damage line is a hit. A hit is described by its inputs (who hit whom with which move,
// the attacker's and the defender's HP before it, crit or not) and its value: the damage dealt, or "KO" when it took the
// defender to 0. The checker hands the oracle one outcome at a time, which can only show that a value is possible, not
// that the engine gives it with the right odds: an engine that overstated a hit so that every roll KOs would merge its
// KO leaves into one outcome, and each outcome alone would look fine. So the oracle expands the step itself, once
// (cached by the `before` state and the choices, as plain data), and checks each hit over the whole step, on every
// call (no state is kept between calls, so a check the checker cut short never hides a later one):
// - full check: within the hit's inputs, crits apart, the engine's values with their odds must be the calc's. Each
//   value's share of the group's probability must equal its roll count out of 16 against that HP, or for Psywave the
//   summed weights of the x values that give it out of the cartridge's 65,536 draws (`psywaveValues`,
//   `psywaveWeight`: the calc's 16 roll slots hold Psywave's 11 values, five of them twice, and are not 16 equal odds).
//   Every damage that reaches the HP counts as one value, "KO" (the engine gives those rolls as one `≥hp` option,
//   the same share). It also checks the outcome's own value is among the calc's.
// - fallback, where the full check cannot apply: the outcome's own value must be among the calc's rolls, and a KO is
//   counted only when every roll KOs. It applies when the engine's merged outcomes may put a leaf's probability under
//   another value or another group, through no fault of the engine: some hit's defender in the step has its HP
//   changed again later in a way that can bring different hits to the same state (it faints later, ends at full HP,
//   takes another hit or a damage-dependent change such as recoil or drain), which turns the full check off for the
//   whole step; or something interrupted the hit in some of the step's leaves (an activation or a state change between
//   the move and its damage: Focus Band, Endure; or a defender holding a Focus Sash at full HP, which says so only after
//   the damage); or the oracle's own expansion failed (an engine limit).
// The oracle's own expansion gets the checker's stop (StepContext.shouldStop) as expandTurn's shouldStop. An
// engine STOPPED is no failure of the step: it is rethrown and nothing is cached, so the checker cuts its check short
// and a later call expands the step again.
// The speed oracle checks which side's move came first against the priorities and `speedOrder` (src/sheet/speed.ts).

import PS from 'pokemon-showdown';
import type { KaizoMove } from '../battle/moves.js';
import { damage, type CalcSide, type DamageResult } from '../calc/calc.js';
import type { Choice, Engine, EngineState, Outcome, Rational, Side } from '../contracts/engine.js';
import { add, ZERO } from '../engine/index.js';
import { speedOrder } from '../sheet/speed.js';
import type { DamageOracle, OracleResult, SpeedOracle, StepContext } from '../solver/types.js';
import { type Active, activeOf, type BattleContext, battleOf, buildLookups, fieldOf, type Lookups, requestMoveId } from './battleView.js';

const { toID } = PS;

/** The view's context, and the engine whose steps are checked (the oracle expands a step itself for the full check). */
export interface OracleContext extends BattleContext { engine: Engine }

/** Log lines after which the participants or the field may differ from `before`: no later hit of the step is checked. */
const CHANGES_STATE: ReadonlySet<string> = new Set([
  '-boost', '-unboost', '-setboost', '-clearboost', '-clearallboost', '-clearnegativeboost', '-invertboost', '-copyboost',
  '-swapboost', '-status', '-curestatus', '-cureteam', '-enditem', '-item', '-ability', '-endability', '-transform',
  '-formechange', 'detailschange', '-start', '-end', '-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend',
  'switch', 'drag', 'replace', '-singleturn', '-singlemove', '-mega', '-burst',
]);

/** Activations that change only the hit they come with (it is then not checked): a Protect, Endure, Focus Band or Substitute. */
const HIT_ACTIVATIONS = [/move: Protect/, /move: Detect/, /move: Endure/, /item: Focus Band/, /\|Substitute\|/, /move: Substitute/];
/** Activations that change nothing the calc reads: a trap, confusion's announcement, Quick Claw, infatuation's check. */
const HARMLESS_ACTIVATIONS = [/\|trapped$/, /\|confusion$/, /item: Quick Claw/, /move: Attract/];

/** `[from]` sources of a later HP change that cannot bring two different hits to the same HP (a fixed share of max HP). */
const FIXED_CHANGES: ReadonlySet<string> = new Set([
  'brn', 'psn', 'tox', 'sandstorm', 'hail', 'leechseed', 'nightmare', 'curse', 'baddreams', 'itemleftovers', 'itemblacksludge',
  'itemlifeorb', 'abilityraindish', 'abilityicebody', 'abilitydryskin', 'abilitysolarpower', 'ingrain', 'aquaring',
]);

/** Moves the calc works out differently from the cartridge without saying so: False Swipe leaves 1 HP where it would KO. */
const UNCHECKED_BEHAVIOURS: ReadonlySet<string> = new Set(['False Swipe']);

/** One move's damage line in one outcome. `value` is the damage dealt, or 'KO'. */
interface Hit {
  id: string;                          // `<side>:<move id>:<n>`, the side's n-th move of the step
  by: Active; target: Active; move: KaizoMove; crit: boolean;
  attackerHp: number; before: number; after: number;
  /** The defender's HP changes again later in the outcome in a way that can merge different hits into one state. */
  merges: boolean;
}

const valueOf = (hit: Hit): string => (hit.after === 0 ? 'KO' : `${hit.before - hit.after}`);
const groupOf = (hit: Hit): string => `${hit.id}|${hit.attackerHp}|${hit.before}|${hit.crit}`;

/** A step's `before` battle as the oracles read it, shared by every outcome of the step. */
interface View { battle: Battle; actives: Partial<Record<Side, Active>> }

/** One group's values as the engine gave them: each value's summed probability over the step's outcomes, and their total. */
interface GroupOdds { values: Map<string, Rational>; total: Rational }

/**
 * The step as the oracle expanded it, plain data only (no battle, no Pokémon): each group's odds, the IDs of the hits
 * interrupted somewhere, and whether some hit's defender changes HP later in a way that can merge leaves.
 */
interface Expansion { failed: boolean; merges: boolean; groups: Map<string, GroupOdds>; interrupted: Set<string> }

/** The damage and speed oracles, and the expansions the damage oracle keeps (for tests: plain data). */
export interface Oracles { damage: DamageOracle; speed: SpeedOracle; cachedExpansions(): Expansion[] }

const VIEW_CACHE = 8;
const DAMAGE_CACHE = 4_096;
/**
 * The checker walks depth first (it hands over one outcome of a step, then settles that outcome's whole subtree before
 * the step's next one), and it checks the same steps again for each line it is given. So expansions are kept in a
 * large cache, least recently used first out, each touched whenever one of its outcomes comes.
 */
const EXPANSION_CACHE = 4_096;

/** Keeps at most `limit` entries, dropping the oldest. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  if (cache.size >= limit) cache.delete(cache.keys().next().value as K);
  cache.set(key, value);
  return value;
}

/**
 * Whether a hit on `target`, on `hp` before it, may be saved at 1 HP by an effect that says so only after the damage
 * line, so the line alone can't tell a save from an ordinary roll. In Gen 4 that is Focus Sash alone (Showdown's gen4
 * mod: a silent volatile at `onTryHit` on a full-HP holder, `hp − 1` from `onDamage`, `-enditem` at
 * `onAfterMoveSecondary`). Focus Band and Endure announce themselves before the damage (an activation), Gen 4 Sturdy
 * only stops one-hit KO moves (never checked here), the hack's docs change none of them, and False Swipe is skipped by
 * its behaviour.
 */
function savesAfterwards(target: Active, hp: number): boolean {
  return target.pokemon.item === 'focussash' && hp === target.pokemon.maxhp;
}

/** The HP in an HP field ("40/55", "0 fnt"). */
const hpOf = (field: string | undefined): number | null => {
  const m = /^(\d+)/.exec(field ?? '');
  return m === null ? null : Number(m[1]);
};

/** A protocol ident's side ('p2a: Zigzagoon' → 'p2'); null for anything else. */
const sideOf = (ident: string | undefined): Side | null => (ident?.startsWith('p1') ? 'p1' : ident?.startsWith('p2') ? 'p2' : null);

/** Delayed attacks (by Showdown ID): their hit comes after `-end <target>|move: <name>`, with no move line of its own. */
const DELAYED_ATTACKS: ReadonlySet<string> = new Set(['futuresight', 'doomdesire']);

/** Bide (Showdown ID): its stored hit comes after `-end <user>|move: Bide` (gen4 mod's `onBeforeMove`), with no move line. */
const BIDE = 'bide';

/**
 * A hit a Substitute takes, which logs no `-damage` line (Showdown's gen4 substitute condition): `-activate|<target>|
 * Substitute|[damage]` when the substitute stands, or `-end|<target>|Substitute` when the hit breaks it (its `onEnd`;
 * nothing else ends a Gen 4 substitute, since switching out or fainting clears volatiles without it).
 */
const SUBSTITUTE_HIT = /^\|(?:-activate\|[^|]*\|(?:move: )?Substitute\|\[damage\]|-end\|[^|]*\|Substitute)$/;

/** A line that may be a hit: a `-damage` line, or a Substitute taking one. */
const mayHit = (line: string): boolean => line.startsWith('|-damage|') || SUBSTITUTE_HIT.test(line);

/**
 * The hits of one outcome's log, the IDs of the hits something interrupted between the move and its damage, and every
 * damaging hit of the log by move display name (`damaging`). Parsing for `hits` stops at a line that changes
 * the battle (`CHANGES_STATE`, or an activation not known to be harmless); a hit under way then counts as interrupted.
 * `damaging` never stops: every move's damage line (no `[from]`) or Substitute hit (`SUBSTITUTE_HIT`) on the other
 * side's Pokémon is one hit of the last move line's move (a called or copied one's too), of a delayed attack after its
 * `-end` on the target, or of Bide after its `-end` on its user; no other `-end` changes it, and `cant` and `turn` end
 * it. Every hit in `hits` is one of them, under the same name.
 */
function readHits(lines: readonly string[], view: View, look: Lookups): { hits: Hit[]; interrupted: string[]; damaging: Map<string, number> } {
  const actives = Object.values(view.actives);
  const hp = new Map<string, number>(actives.map((a) => [a.ident, a.pokemon.hp]));
  const maxHp = new Map<string, number>(actives.map((a) => [a.ident, a.pokemon.maxhp]));
  const hits: Hit[] = [];
  const interrupted: string[] = [];
  const damaging = new Map<string, number>();
  const counts: Record<Side, number> = { p1: 0, p2: 0 };
  let current: { id: string; by: Active; move: KaizoMove; crit: boolean; done: boolean } | null = null;
  let attacker: { side: Side; name: string } | null = null;   // whose move a damage line belongs to, for `damaging`
  let stopped = false;
  const interrupt = () => {
    if (current !== null && !current.done) interrupted.push(current.id);
    current = null;
  };
  const nameOf = (move: string): string => look.byId.get(toID(move))?.name ?? move;
  for (const line of lines) {
    const parts = line.split('|');
    const kind = parts[1] ?? '';
    const onSide = sideOf(parts[2]);
    if (kind === 'move') attacker = onSide === null ? null : { side: onSide, name: nameOf(parts[3] ?? '') };
    else if (kind === 'cant' || kind === 'turn') attacker = null;
    else if (kind === '-end' && onSide !== null && parts[3]?.startsWith('move: ')) {
      const move = parts[3].slice('move: '.length);
      const behaviour = toID(look.byId.get(toID(move))?.calc.baseMove ?? move);
      if (DELAYED_ATTACKS.has(behaviour)) attacker = { side: onSide === 'p1' ? 'p2' : 'p1', name: nameOf(move) };
      else if (behaviour === BIDE) attacker = { side: onSide, name: nameOf(move) };
    } else if (((kind === '-damage' && !parts.some((p) => p.startsWith('[from]'))) || SUBSTITUTE_HIT.test(line))
      && attacker !== null && onSide !== null && onSide !== attacker.side) {
      damaging.set(attacker.name, (damaging.get(attacker.name) ?? 0) + 1);
    }
    if (!stopped && kind === '-activate') {
      if (HARMLESS_ACTIVATIONS.some((re) => re.test(line))) continue;
      if (HIT_ACTIVATIONS.some((re) => re.test(line))) {
        interrupt();
        continue;
      }
      interrupt();
      stopped = true;
      continue;
    }
    if (!stopped && CHANGES_STATE.has(kind)) {
      interrupt();
      stopped = true;
      continue;
    }
    if (kind === 'move') {
      if (stopped) continue;
      const by = actives.find((a) => a.ident === parts[2]);
      const side = by?.side;
      if (line.includes('[from]') || by === undefined || side === undefined) {
        current = null;   // a called or copied move (Me First's 1.5x is never logged): not checked
        continue;
      }
      counts[side] += 1;
      const used = look.byId.get(toID(parts[3] ?? ''));
      current = used === undefined ? null : { id: `${side}:${toID(parts[3] ?? '')}:${counts[side]}`, by, move: used, crit: false, done: false };
      continue;
    }
    if (kind === 'cant' || kind === '-miss' || kind === '-fail' || kind === '-immune' || kind === 'turn') current = null;
    if (kind === '-crit' && current !== null) current.crit = true;
    if (kind === '-hitcount') interrupt();
    if (kind === 'faint') {
      for (const hit of hits) if (hit.target.ident === parts[2] && hit.after > 0) hit.merges = true;
      continue;
    }
    if (kind !== '-heal' && kind !== '-sethp' && kind !== '-damage') continue;
    const ident = parts[2] ?? '';
    const after = hpOf(parts[3]);
    const before = hp.get(ident);
    const max = /^\d+\/(\d+)/.exec(parts[3] ?? '');
    if (max !== null) maxHp.set(ident, Number(max[1]));
    if (after !== null) hp.set(ident, after);
    const from = parts.find((p) => p.startsWith('[from]'));
    // A later change to an earlier hit's defender: one that can bring two different hits to the same HP merges them.
    for (const hit of hits) {
      if (hit.target.ident !== ident) continue;
      const fixed = from !== undefined && FIXED_CHANGES.has(toID(from.slice('[from]'.length)));
      if (!fixed || kind === '-sethp' || after === 0 || after === maxHp.get(ident)) hit.merges = true;
    }
    if (kind !== '-damage' || from !== undefined || current === null || current.done || stopped || before === undefined || after === null) continue;
    const target = actives.find((a) => a.ident === ident);
    if (target === undefined || target.side === current.by.side) continue;
    if (savesAfterwards(target, before)) {
      interrupt();   // a Focus Sash save is announced only after its damage line
      continue;
    }
    hits.push({
      id: current.id, by: current.by, target, move: current.move, crit: current.crit,
      attackerHp: hp.get(current.by.ident) ?? current.by.pokemon.hp, before, after, merges: false,
    });
    current.done = true;
  }
  return { hits, interrupted, damaging };
}

/** `a` / `b` against `count` / `of`, exactly (`b` non-zero). */
const shareIs = (a: Rational, b: Rational, count: number, of: number): boolean => a.num * b.den * BigInt(of) === BigInt(count) * b.num * a.den;

/**
 * Psywave's 11 damage values at `level`, the k-th for x = 5 + k (k = 0…10): max(1, floor(level × x / 10)), worked out
 * as the calc does (`psywaveValues`, src/calc/calc.ts:602-609, which it does not export). The calc spreads them over its
 * 16 roll slots, five of them twice, and says not to read those as 16 equal odds (calc.ts:611-619), so the damage check
 * counts these instead, each at `psywaveWeight(k)`. A test pins them to the calc's own note, "Psywave: <values>, each
 * 1/11" (calc.ts:772).
 */
export function psywaveValues(level: number): number[] {
  return Array.from({ length: 11 }, (_, k) => Math.max(1, Math.floor((level * (5 + k)) / 10)));
}

/** The cartridge's battle draws: every battle chance is one 16-bit draw (`BattleSystem_RandNext` returns a u16). */
const DRAWS = 65_536;

/**
 * How many of the cartridge's 65,536 draws give Psywave's x = 5 + k: its `Random 10, 5` takes x = r % 11 + 5 from one
 * 16-bit draw r (effect_script_0088.s, as calc.ts:602-605 cites it), so x weighs the draws with residue k, floor(65536
 * / 11) plus 1 for k < 65536 % 11: 5958 for k = 0…8, 5957 for k = 9 and 10. Not the calc's "each 1/11", which is near
 * but not exact; the engine models the draws.
 */
const psywaveWeight = (k: number): number => Math.floor(DRAWS / 11) + (k < DRAWS % 11 ? 1 : 0);

/** A value list for a message, numbers first in order, then the KO. */
const listOf = (values: Iterable<string>): string => [...values].sort((x, y) => (x === 'KO' ? 1 : y === 'KO' ? -1 : Number(x) - Number(y))).join(', ');

/** The oracles over `ctx` (see the top of the file). */
export function createOracles(ctx: OracleContext): Oracles {
  let lookups: Lookups | null = null;
  const lookup = (): Lookups => (lookups ??= buildLookups(ctx.moves));
  const views = new Map<string, View>();
  const view = (before: EngineState): View => {
    const known = views.get(before.key);
    if (known !== undefined) return known;
    const look = lookup();
    const { battle, trainer } = battleOf(before, ctx);
    const actives: Partial<Record<Side, Active>> = {};
    for (const side of ['p1', 'p2'] as const) {
      const a = activeOf(battle, trainer, side, ctx, look);
      if (a !== null) actives[side] = a;
    }
    return remember(views, before.key, { battle, actives }, VIEW_CACHE);
  };
  const results = new Map<string, DamageResult | null>();
  const calc = (hit: Hit, battle: Battle, beforeKey: string): DamageResult | null => {
    const key = `${beforeKey}|${hit.by.ident}|${hit.attackerHp}|${hit.target.ident}|${hit.before}|${hit.move.id}`;
    if (results.has(key)) return results.get(key)!;
    const field = fieldOf(battle, hit.by, hit.target);
    const attacker: CalcSide = { ...hit.by.calc, curHp: hit.attackerHp };
    const result = field === null ? null : damage(attacker, { ...hit.target.calc, curHp: hit.before }, hit.move, field);
    return remember(results, key, result, DAMAGE_CACHE);
  };
  const expansions = new Map<string, Expansion>();
  /** The step's expansion, touched in the cache (least recently used first out); a stopped one is never cached. */
  const expansion = (step: StepContext, v: View): Expansion => {
    const { before, choices } = step;
    const key = `${before.key}|${JSON.stringify(choices)}`;
    let known = expansions.get(key);
    if (known === undefined) known = expand(before, choices, v, step.shouldStop);
    else expansions.delete(key);
    expansions.set(key, known);
    if (expansions.size > EXPANSION_CACHE) expansions.delete(expansions.keys().next().value!);
    return known;
  };
  /**
   * Expands the step and keeps plain data only: each group's summed odds per value, the interrupted hits, `merges`. An
   * engine error is a failed expansion, but for STOPPED (the checker's stop), which is rethrown (see the top of the file).
   */
  const expand = (before: EngineState, choices: { p1?: Choice; p2?: Choice }, v: View, shouldStop: StepContext['shouldStop']): Expansion => {
    const made: Expansion = { failed: false, merges: false, groups: new Map(), interrupted: new Set() };
    let outcomes: Outcome[];
    try {
      outcomes = ctx.engine.expandTurn(before, choices, shouldStop === undefined ? undefined : { shouldStop });
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'STOPPED') throw e;
      made.failed = true;
      return made;
    }
    for (const outcome of outcomes) {
      const { hits, interrupted } = readHits(outcome.log, v, lookup());
      for (const id of interrupted) made.interrupted.add(id);
      for (const hit of hits) {
        if (hit.merges) made.merges = true;
        let group = made.groups.get(groupOf(hit));
        if (group === undefined) {
          group = { values: new Map(), total: ZERO };
          made.groups.set(groupOf(hit), group);
        }
        const value = valueOf(hit);
        group.values.set(value, add(group.values.get(value) ?? ZERO, outcome.probability));
        group.total = add(group.total, outcome.probability);
      }
    }
    return made;
  };
  /**
   * Compares one hit with the calc (see the top of the file), mismatches going to `mismatches`: true when it counts as a
   * check, false when it is not compared (a multi-hit move, False Swipe, the calc giving no result, unbounded or an OHKO
   * move, or the fallback's roll-dependent KO).
   */
  const compareHit = (hit: Hit, v: View, beforeKey: string, expanded: Expansion, mismatches: string[]): boolean => {
    if (hit.move.calc.hits !== undefined || UNCHECKED_BEHAVIOURS.has(hit.move.calc.baseMove)) return false;
    const calcResult = calc(hit, v.battle, beforeKey);
    if (calcResult === null || !calcResult.bounded || calcResult.ohko) return false;
    // The calc's damages and how many of `of` each takes: the 16 rolls, one each, or Psywave's 11 values, each at its x's
    // weight out of the 65,536 draws, a value two x's give with both weights (its 16 roll slots are not equal odds).
    // Against an immune defender the calc gives no Psywave values, only 16 rolls of 0 (calc.ts:766-768).
    const psywave = hit.move.calc.fixedDamage === 'psywave' && calcResult.max > 0;
    const rolls = psywave ? psywaveValues(hit.by.calc.mon.level) : hit.crit ? calcResult.critRolls : calcResult.rolls;
    const of = psywave ? DRAWS : 16;
    const counts = new Map<string, number>();
    rolls.forEach((roll, k) => {
      const value = roll >= hit.before ? 'KO' : `${roll}`;
      counts.set(value, (counts.get(value) ?? 0) + (psywave ? psywaveWeight(k) : 1));
    });
    const group = expanded.groups.get(groupOf(hit));
    const full = !expanded.failed && !expanded.merges && !expanded.interrupted.has(hit.id) && group !== undefined;
    const own = valueOf(hit);
    // The fallback (see the top of the file): a KO that depends on the roll is not counted.
    if (!full && own === 'KO' && Math.min(...rolls) < hit.before) return false;
    const what = `${hit.by.pokemon.name}'s ${hit.move.name}${hit.crit ? ' (crit)' : ''}`;
    if (!counts.has(own)) {
      mismatches.push(`damage: ${what} took ${hit.target.pokemon.name} from ${hit.before} to ${hit.after} HP; the calc's rolls give ${listOf(counts.keys())}`);
      return true;
    }
    if (!full) return true;
    // The full check, on every call: the group's values and their odds against the calc's counts out of `of`.
    const engine = group.values;
    const sameValues = engine.size === counts.size && [...engine.keys()].every((value) => counts.has(value));
    if (!sameValues) {
      mismatches.push(`damage: ${what} against ${hit.target.pokemon.name} on ${hit.before} HP: the engine's outcomes give ${listOf(engine.keys())}, the calc's rolls give ${listOf(counts.keys())}`);
      return true;
    }
    const off = [...counts].filter(([value, count]) => !shareIs(engine.get(value)!, group.total, count, of));
    if (off.length > 0) {
      const odds = off.map(([value, count]) => {
        const p = engine.get(value)!;
        return `${value}: the engine's odds ${p.num * group.total.den}/${p.den * group.total.num}, the calc's ${count} of ${of}`;
      });
      mismatches.push(`damage: ${what} against ${hit.target.pokemon.name} on ${hit.before} HP: ${odds.join('; ')}`);
    }
    return true;
  };

  return {
    damage: {
      id: 'integration-damage@calc',
      check(step) {
        const result: OracleResult = { checks: 0, mismatches: [] };
        if (!step.outcome.log.some(mayHit)) return result;   // no damage line and no Substitute hit: no hit at all
        const v = view(step.before);
        const { hits, damaging } = readHits(step.outcome.log, v, lookup());
        const compared = new Map<string, number>();
        if (hits.length > 0) {
          const expanded = expansion(step, v);
          for (const hit of hits) {
            if (!compareHit(hit, v, step.before.key, expanded, result.mismatches)) continue;
            result.checks += 1;
            compared.set(hit.move.name, (compared.get(hit.move.name) ?? 0) + 1);
          }
        }
        // Every damaging hit not compared above is named, by the move's display name (the labeler's "Use <Move>" name),
        // whatever kept it out: the calc, a multi-hit move, False Swipe, the fallback's KO, or the parse.
        for (const [move, all] of damaging) {
          const left = all - (compared.get(move) ?? 0);
          if (left > 0) (result.skipped ??= {})[move] = left;
        }
        return result;
      },
    },
    speed: { id: 'integration-speed@sheet', check: (step) => checkSpeed(step, view(step.before), lookup()) },
    cachedExpansions: () => [...expansions.values()],
  };
}

function checkSpeed(step: StepContext, view: View, look: Lookups): OracleResult {
  const none: OracleResult = { checks: 0, mismatches: [] };
  const { before, choices, outcome } = step;
  if (before.phase.kind !== 'turnChoice' || choices.p1?.kind !== 'move' || choices.p2?.kind !== 'move') return none;
  if (outcome.labels.some((label) => label.kind === 'speedTie' || label.kind === 'quickClaw')) return none;
  const movers: Side[] = [];
  for (const line of outcome.log) {
    if (!line.startsWith('|move|') || line.includes('[from]')) continue;
    const side = line.startsWith('|move|p1') ? 'p1' : line.startsWith('|move|p2') ? 'p2' : null;
    if (side !== null && !movers.includes(side)) movers.push(side);
  }
  if (movers.length < 2) return none;
  const { battle } = view;
  const { p1, p2 } = view.actives;
  if (p1 === undefined || p2 === undefined) return none;
  // A Quick Claw or Custap Berry may be drawn outside this step; Unburden and Slow Start change Speed in ways the sheet leaves out.
  const unknown = (a: Active) => ['quickclaw', 'custapberry'].includes(a.pokemon.item) || ['unburden', 'slowstart'].includes(a.pokemon.ability);
  if (unknown(p1) || unknown(p2) || battle.p1.sideConditions['tailwind'] || battle.p2.sideConditions['tailwind']) return none;
  const field = fieldOf(battle, p1, p2);
  if (field === null) return none;
  const priority = (side: Side, slot: number): number | null => {
    const id = requestMoveId(battle, side, slot);
    if (id === undefined) return null;
    if (id === 'struggle') return 0;
    return look.byId.get(id)?.priority ?? null;
  };
  const [a, b] = [priority('p1', choices.p1.slot), priority('p2', choices.p2.slot)];
  if (a === null || b === null) return none;
  let expected: Side;
  if (a !== b) expected = a > b ? 'p1' : 'p2';
  else {
    const order = speedOrder(p1.calc, p2.calc, field);
    if (order === 'tie') return none;
    expected = order === 'a' ? 'p1' : 'p2';
  }
  const actual = movers[0]!;
  if (actual === expected) return { checks: 1, mismatches: [] };
  const name = (side: Side) => (side === 'p1' ? p1 : p2).pokemon.name;
  return { checks: 1, mismatches: [`order: ${name(actual)} moved first, but ${name(expected)} should (priority ${a} against ${b}, then the sheet's Speed order)`] };
}
