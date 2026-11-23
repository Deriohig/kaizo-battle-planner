// The line builder's damage numbers (`LineDamageJson`, src/contracts/api.ts): at a node, each of the player's moves against the
// enemy's active Pokémon and each move the enemy knows against his, worked out the way the matchup sheet works a pair's
// cells (`damage()` and `hitChance()`, src/calc), with each side read from the node's own battle state through
// battleView.ts as the checker's oracles read theirs (`battleOf`, `activeOf`, `fieldOf`). So stat stages, HP, status,
// weather, screens and the draft's edits (the state's Pokémon are as drafted: level, item, moves and the rest) all count.
//
// Per move: the damage of one hit in HP and as a percent of the defender's max HP (lowest and highest), the same for a
// crit, the chance 1, 2, 3 and 4 hits in a row KO from the defender's current HP with no crit and the chance one crit
// does (the calc's exact fractions as decimal strings; the rounded `ko` and `koCrit` beside them are not printed), and
// the hit chance. The crit figures are there only where a crit can land: by the calc's own rule (`critLands`), none for a
// fixed-damage move and none against Battle Armor or Shell Armor unless the attacker has Mold Breaker; and by the
// engine's, none under Lucky Chant on the defender's side and none for a move whose damage the engine sets before its
// crit (`skipsCrit`: Counter, Mirror Coat, Metal Burst). A status move has none. Where battleView has no view of a Pokémon (it is transformed, its ability or type changed, a volatile the calc
// cannot model, or no set of his matches), or the calc's result is unbounded or an OHKO move's, there are no numbers and
// `note` says why: "can't calculate here: …", naming the side that could not be read on both lists ("the Pokémon's" when
// neither could). Every move, numbers or not, carries its priority from the dex (0 for a move the dex does not know, and
// for Struggle) and whether it hits more than once in a use (`multiHit`, as below), and what a move button shows: its type
// by name (src/rom/tables.ts `TYPE_NAMES`, null for "???"), category and power (`factsOf`), all null for a move the dex
// does not know; power is null for a move with no single power (`PLACEHOLDER_POWER`). Where both sides are read, a
// damaging move also carries the chance one hit is a crit (`critChance`, src/server/critChance.ts): 0/1 where no crit can
// land (as for the crit figures, and a one-hit KO move), null for a status move, a move the installed dex does not know,
// and on a side that could not be read.
//
// A move with numbers also says the held item that keeps the defender at 1 HP from its one hit (`survives`): a Focus Sash
// on a defender at full HP, its current HP the calc's own max HP (`calcHp`, as `damage()` works it). The item is matched
// by its hold effect in the ROM's item data (`ctx.data.rom.items`), not by its name, and Klutz takes it away as
// `heldEffect` (src/calc/battler.ts) has it; that table holds only the hold effects accuracy and turn order read, so the
// Sash's is read from the ROM data here. A move that hits more than once in a use has none, since its second hit breaks
// the Sash: the calc's `hits` (`KaizoMove.calc.hits`), and Beat Up and Triple Kick, which the calc runs as one plain hit
// and whose effect texts are matched here. A move without numbers has none.
//
// With the moves, the turn order at equal priority (`order`): the two sides' effective Speeds and who moves first, by the
// sheet's own rules (`effectiveSpeed` and `speedOrder`, src/sheet/speed.ts) on the same two sides and the node's field
// (`fieldOf` leaves out the weather under Cloud Nine or Air Lock, as the sheet's speed field does), and the held Quick
// Claw or Custap Berry that can change it: one on a side that would not surely move first (on a tie, either side), as the
// matchup sheet counts them (src/sheet/sheet.ts). No order where either side cannot be read, or the weather is one the
// calculator does not know. The dex must be installed (`installKaizoDex`).

import { normaliseEffectText } from '../battle/effectMap.js';
import type { KaizoMove } from '../battle/moves.js';
import { hitChance } from '../calc/accuracy.js';
import { abilityName, heldEffect } from '../calc/battler.js';
import { type CalcSide, damage, type DamageResult } from '../calc/calc.js';
import type { LineDamageJson, LineMoveDamageJson, LineOrderJson, LineRationalJson } from '../contracts/api.js';
import type { EngineState } from '../contracts/engine.js';
import { moveId } from '../engine/index.js';
import { type Active, activeOf, type BattleContext, battleOf, buildLookups, fieldOf, type Lookups, requestMoveId } from '../integration/battleView.js';
import { calcHp } from '../rom/stats.js';
import { TYPE_NAMES } from '../rom/tables.js';
import { effectiveSpeed, speedOrder } from '../sheet/speed.js';
import { critChanceOf } from './critChance.js';

const CANT = "can't calculate here";

/** A move's fields when it has no numbers. */
const NO_NUMBERS = {
  percent: null, critPercent: null, ko: null, koCrit: null, koExact: null, koCritExact: null, hp: null, critHp: null, survives: null,
} as const;

/** The ROM's item records, by item ID: their hold effects. */
type Items = BattleContext['data']['rom']['items'];

/**
 * The held items that keep their holder at 1 HP from one hit at full HP, by the hold effect in the ROM's item data (a
 * line of pokeplatinum's generated/item_hold_effects.txt less one), as the page names them. In the hack ROM's item data
 * the Focus Sash, item 275, has hold effect 103, and no other item has it (test/real/lineSash.test.ts checks this).
 */
const SURVIVORS: Readonly<Record<number, string>> = { 103: 'Focus Sash' };

/**
 * The effect texts of the moves that hit more than once in a use but carry no `hits` in their calc spec, because the
 * calc runs them as one plain hit: Beat Up and Triple Kick. The texts are copied from their entries in
 * src/battle/effectMap.ts `UNMODELLED_EFFECTS` ("Damage from something other than the formula"), the source list: when
 * an entry there changes, gains `hits`, or a multi-hit text without `hits` joins it, change this set with it.
 * test/unit/server/lineSash.test.ts fails if either text stops being an `UNMODELLED_EFFECTS` key.
 */
const UNCOUNTED_MULTI_HIT: ReadonlySet<string> = new Set(['Beat Up effect', 'Hits the target up to 3 times; increases power by 10 with each hit'].map(normaliseEffectText));

/** Whether `move` hits once in a use: no `hits` above 1 in its calc spec, and not one of `UNCOUNTED_MULTI_HIT`. */
const hitsOnce = (move: KaizoMove): boolean =>
  (move.calc.hits === undefined || move.calc.hits === 1) && !UNCOUNTED_MULTI_HIT.has(normaliseEffectText(move.effectText));

/** The abilities that stop a crit, as the calc's `critBlocker` (src/calc/calc.ts) has them. */
const CRIT_BLOCKERS: readonly string[] = ['Battle Armor', 'Shell Armor'];

/**
 * Whether a crit of `move` from `attacker` can land on `defender`, by the calc's own rules (`damage()` and `critBlocker`,
 * src/calc/calc.ts): not a fixed-damage move, and no Battle Armor or Shell Armor on the defender unless the attacker has
 * Mold Breaker. Where it cannot, the calc's crit result is the plain hit's, so the page is sent no crit figures at all.
 */
const critLands = (attacker: CalcSide, defender: CalcSide, move: KaizoMove): boolean =>
  move.calc.fixedDamage === undefined && (abilityName(attacker.mon) === 'Mold Breaker' || !CRIT_BLOCKERS.includes(abilityName(defender.mon)));

/**
 * The held item that keeps `defender` at 1 HP from one hit, or null: one of `SURVIVORS` by its hold effect in `items`,
 * none under Klutz (as `heldEffect` reads a held item), and only at full HP, `curHp` the calc's max HP.
 */
function survivorOf(items: Items, defender: CalcSide): string | null {
  const { mon } = defender;
  if (abilityName(mon) === 'Klutz') return null;
  const name = SURVIVORS[items[mon.item]?.holdEffect ?? -1];
  if (name === undefined) return null;
  const maxHp = calcHp(mon.baseStats.hp, mon.ivs.hp, mon.evs.hp, mon.level);
  return (defender.curHp ?? maxHp) >= maxHp ? name : null;
}

/** One of the calc's exact KO chances (already reduced) as JSON. */
const exact = ({ count, total }: { count: bigint; total: bigint }): LineRationalJson => ({ num: String(count), den: String(total) });

/** A move's priority: the dex's, or 0 for a move it does not know and for Struggle. */
const priorityOf = (move: KaizoMove | undefined): number => (move === undefined || move.name === 'Struggle' ? 0 : move.priority);

/** Whether a move hits more than once in a use (not `hitsOnce`); false for a move the dex does not know. */
const multiHitOf = (move: KaizoMove | undefined): boolean => move !== undefined && !hitsOnce(move);

/** The held items that can move their holder first at equal priority, by hold effect, as the page names them. */
const CHANGERS: Readonly<Record<string, string>> = { SOMETIMES_PRIORITY: 'Quick Claw', PINCH_PRIORITY: 'Custap Berry' };

/**
 * Who moves first at equal priority between `mine` and `theirs` on `battle`'s field, by the sheet's rules; null for a
 * weather the calculator does not know. A Quick Claw or Custap Berry counts on a side that is not `first`.
 */
function orderOf(battle: Battle, mine: Active, theirs: Active): LineOrderJson | null {
  const field = fieldOf(battle, mine, theirs);
  if (field === null) return null;
  const first = ({ a: 'player', b: 'enemy', tie: 'tie' } as const)[speedOrder(mine.calc, theirs.calc, field)];
  const changers: string[] = [];
  for (const [side, who] of [[mine, 'player'], [theirs, 'enemy']] as const) {
    const name = CHANGERS[heldEffect(side.calc.mon)?.effect ?? ''];
    if (name !== undefined && first !== who && !changers.includes(name)) changers.push(name);
  }
  return { player: effectiveSpeed(mine.calc, field), enemy: effectiveSpeed(theirs.calc, field), first, changers };
}

/**
 * The ROM power of a damaging move with no single power. In the hack ROM's move data (read 2026-11-21) the damaging moves
 * with power 1 are exactly the variable-power ones (Low Kick, Grass Knot, Flail, Reversal, Gyro Ball, Hidden Power,
 * Present, Natural Gift, Fling, Trump Card, Punishment), the fixed-damage ones (Seismic Toss, Night Shade, Sonic Boom,
 * Dragon Rage, Super Fang, Endeavor), the one-hit KO moves, and Counter, Mirror Coat, Metal Burst and Bide. A move whose
 * power only doubles on a condition (Payback, Stomp, Pursuit) keeps its real ROM power. The installed dex's
 * `basePowerCallback` is not the test: the engine sets a neutral one on Return and Frustration, plain 121-power hits in
 * the hack (src/engine/dex.ts `REQUEST_POWER_IDS`), and Showdown's own sits on every doubling move.
 */
const PLACEHOLDER_POWER = 1;

/** A move's type, category and power as a move button shows them (`LineMoveDamageJson`); all null for an unknown move. */
function factsOf(move: KaizoMove | undefined): Pick<LineMoveDamageJson, 'type' | 'category' | 'power'> {
  if (move === undefined) return { type: null, category: null, power: null };
  const type = TYPE_NAMES[move.type];
  return {
    type: type === undefined || type === '???' ? null : type, category: move.category,
    power: move.category === 'status' || move.power <= PLACEHOLDER_POWER || move.calc.fixedDamage !== undefined ? null : move.power,
  };
}

/** No crit: the chance where none can land. */
const NO_CRIT: LineRationalJson = { num: '0', den: '1' };

/**
 * The installed dex's move for `move`, the one the engine draws with; null where the server can't tell: the move is not in
 * the installed Kaizo dex (`moveId` throws), or no dex is installed.
 */
function engineMove(battle: Battle, move: KaizoMove): ReturnType<Battle['dex']['moves']['get']> | null {
  let id: string;
  try {
    id = moveId(move);
  } catch {
    return null;
  }
  const sim = battle.dex.moves.get(id);
  return sim.exists ? sim : null;
}

/**
 * Whether the engine's `getDamage` (src/engine/mod/scripts.ts) returns before it draws a crit for its move `sim` (from
 * `engineMove`): a one-hit KO, a set damage, or a damage callback (Counter, Mirror Coat, Metal Burst, Seismic Toss and the
 * rest). Null where there is no engine move.
 */
function skipsCrit(sim: ReturnType<typeof engineMove>): boolean | null {
  if (sim === null) return null;
  return !!sim.ohko || !!sim.damage || typeof sim.damageCallback === 'function';
}

/** The calc's exact KO chances for 1 to 4 hits, in order of `hits`; null where it has none. */
function koExactOf(result: DamageResult): LineRationalJson[] | null {
  return result.koExact === null ? null : [...result.koExact].sort((a, b) => a.hits - b.hits).map(exact);
}

/** The damage of one move of `by` against `target`, on the field `by` hitting `target` has in `battle`; `items` the ROM's. */
function cell(battle: Battle, items: Items, by: Active, target: Active, move: KaizoMove | undefined, id: string, slot?: number): LineMoveDamageJson {
  const base = { name: move?.name ?? id, ...(slot === undefined ? {} : { slot }), priority: priorityOf(move), multiHit: multiHitOf(move), ...factsOf(move) };
  const none = (note: string | null, status = false, critChance: LineRationalJson | null = null): LineMoveDamageJson =>
    ({ ...base, hitChance: 1, status, ...NO_NUMBERS, note, critChance });
  if (move === undefined) return none(`${CANT}: no data for ${id}`);
  if (move.category === 'status' || move.power === 0) return none(null, true);
  const attacker: CalcSide = by.calc;
  const defender: CalcSide = target.calc;
  // The engine's crit blockers: the calc's (`critLands`), Lucky Chant on the defender's side, and the moves whose damage
  // the engine sets before its crit (`skipsCrit`). Where none lands there are no crit figures either. The crit stage is
  // read from the same engine move (`critChanceOf`).
  const sim = engineMove(battle, move);
  const skips = skipsCrit(sim);
  const lands = skips === false && critLands(attacker, defender, move) && battle[target.side].sideConditions['luckychant'] === undefined;
  const critChance = skips === null ? null : critChanceOf(items, attacker, by.pokemon, move, lands, sim);
  const field = fieldOf(battle, by, target);
  if (field === null) return none(`${CANT}: a weather the calculator does not know`, false, critChance);
  try {
    const plain: DamageResult | null = damage(attacker, defender, move, field);
    if (plain === null) return none(null, true);
    const chance = hitChance(attacker, defender, move, field);
    // The engine's one-hit KO returns before its crit is drawn.
    if (plain.ohko) return { ...none(`${CANT}: a one-hit KO move`, false, NO_CRIT), hitChance: chance };
    if (!plain.bounded) return { ...none(`${CANT}: ${plain.unmodelled ?? 'nothing bounds its damage'}`, false, critChance), hitChance: chance };
    // No crit figures where no crit can land, and none borrowed from the plain hit when the calc gives no crit result.
    const crit = lands ? damage(attacker, defender, move, field, { crit: true }) : null;
    const critOne = crit?.koExact?.find((entry) => entry.hits === 1);
    return {
      ...base, hitChance: chance, status: false, percent: [plain.percent[0], plain.percent[1]],
      critPercent: crit === null ? null : [crit.percent[0], crit.percent[1]],
      ko: plain.koChance?.[0]?.chance ?? null, koCrit: crit?.koChance?.[0]?.chance ?? null,
      koExact: koExactOf(plain), koCritExact: critOne === undefined ? null : exact(critOne),
      hp: [plain.min, plain.max], critHp: crit === null ? null : [crit.min, crit.max],
      note: plain.unmodelled === null ? null : `Not modelled: ${plain.unmodelled}`,
      survives: hitsOnce(move) ? survivorOf(items, defender) : null, critChance,
    };
  } catch (error) {
    return none(`${CANT}: ${error instanceof Error ? error.message : String(error)}`, false, critChance);
  }
}

/** The numbers and turn order for a node's state; null when a side has no Pokémon out. */
export function createLineDamage(ctx: BattleContext): (state: EngineState) => LineDamageJson | null {
  let lookups: Lookups | null = null;
  return (state) => {
    const look = (lookups ??= buildLookups(ctx.moves));
    const { battle, trainer } = battleOf(state, ctx);
    const mineOut = battle.p1.active[0];
    const theirsOut = battle.p2.active[0];
    if (mineOut === undefined || mineOut === null || theirsOut === undefined || theirsOut === null) return null;
    const mine = activeOf(battle, trainer, 'p1', ctx, look);
    const theirs = activeOf(battle, trainer, 'p2', ctx, look);
    const named = (id: string) => look.byId.get(id);
    const { items } = ctx.data.rom;
    // The note names the side that could not be read, on both lists: "your", "their", or "the" when neither could.
    const whose = mine === null && theirs === null ? 'the' : mine === null ? 'your' : 'their';
    const unread = (side: 'yours' | 'theirs', mon: Pokemon): LineMoveDamageJson[] => mon.moveSlots.map((slot, i) => {
      const move = named(slot.id);
      const status = move !== undefined && (move.category === 'status' || move.power === 0);
      return {
        name: move?.name ?? slot.move, ...(side === 'yours' ? { slot: i } : {}), priority: priorityOf(move), multiHit: multiHitOf(move), hitChance: 1,
        status, ...NO_NUMBERS, note: status ? null : `${CANT}: ${whose} Pokémon's state is not one the calculator reads`,
        ...factsOf(move), critChance: null,
      };
    });
    const yours = mine === null || theirs === null ? unread('yours', mineOut)
      : mineOut.moveSlots.map((slot, i) => cell(battle, items, mine, theirs, named(requestMoveId(battle, 'p1', i) ?? slot.id), slot.id, i));
    const theirMoves = mine === null || theirs === null ? unread('theirs', theirsOut)
      : theirsOut.moveSlots.map((slot) => cell(battle, items, theirs, mine, named(slot.id), slot.id));
    const order = mine === null || theirs === null ? null : orderOf(battle, mine, theirs);
    return { yours, theirs: theirMoves, against: mine?.pokemon.name ?? mineOut.name, order };
  };
}
