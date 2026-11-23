// The AI script commands that read abilities, held items and what the AI knows of the player's battler: the moves it
// has seen (AIContext.battlerMoves), its ability (battlerAbilities) and its item (battlerHeldItems). Literal ports of the
// AICmd_* handlers in trainer_ai.c; each cites its lines. Every handler starts as the C does, with AIScript_Iter(1) past
// its opcode, and reads its arguments in the C's order. The battler-code tests compare the script word itself, as the C
// does with its int `inBattler`.

import {
  ABILITY_ARENA_TRAP, ABILITY_MAGNET_PULL, ABILITY_NONE, ABILITY_SHADOW_TAG, AI_BATTLER_ATTACKER,
  AI_BATTLER_ATTACKER_PARTNER, AI_BATTLER_DEFENDER, AI_BATTLER_DEFENDER_PARTNER, AI_HAVE, AI_NOT_HAVE, AI_UNKNOWN,
  LEARNED_MOVES_MAX, MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_NONE,
} from '../../constants.js';
import { AiError } from '../../errors.js';
import { u16, u8 } from '../../int.js';
import { battleMon, battlerAbility, itemData, itemFlingPower, moveData } from '../../lib/battler.js';
import { PATHS, requireKnown } from '../../lib/known.js';
import type { AiDeps, AiKnowledge } from '../../view.js';
import type { OpHandler, OpTable, RunCtx } from '../run.js';
import { entry } from './state.js';

/** `RandNext() & 1`: 32768 of the 65536 values each way. Index 1 is a set low bit. */
const COIN: readonly bigint[] = Object.freeze([32768n, 32768n]);

/** AI_CONTEXT.battlerAbilities[battler] (u8). */
function knownAbility(k: AiKnowledge, battler: number): number {
  return u8(entry(k.battlerAbilities, battler, 'battlerAbilities'));
}

/** AI_CONTEXT.battlerHeldItems[battler] (u16). */
function knownItem(k: AiKnowledge, battler: number): number {
  return u16(entry(k.battlerHeldItems, battler, 'battlerHeldItems'));
}

/**
 * AI_CONTEXT.battlerMoves[battler] (u16 each). AiError('UNDEFINED') when the view lists them as unknown
 * (PATHS.knownMoves: the memory couldn't settle whether a turn's TrainerAI_Main recorded a move).
 */
function knownMoves(ctx: RunCtx, battler: number): readonly number[] {
  requireKnown(ctx.v, PATHS.knownMoves(battler));
  return entry(ctx.k.battlerMoves, battler, 'battlerMoves');
}

/** SpeciesData_GetSpeciesValue(species, SPECIES_DATA_ABILITY_1 and _2): the species' two abilities. */
function speciesAbilities(d: AiDeps, species: number): [number, number] {
  const record = d.species[u16(species)];
  if (record === undefined) throw new AiError('BAD_VIEW', `species ${species} has no record`);
  return [u8(record.abilities[0]), u8(record.abilities[1])];
}

/** The abilities that trap the AI, which the C takes as announced (trainer_ai.c:1185–1187, 1230–1232). */
function trapsUs(ability: number): boolean {
  return ability === ABILITY_SHADOW_TAG || ability === ABILITY_MAGNET_PULL || ability === ABILITY_ARENA_TRAP;
}

/** Whether `moves` holds `move` (trainer_ai.c:1639–1643 and its copies). */
function holdsMove(moves: readonly number[], move: number): boolean {
  let i: number;
  for (i = 0; i < LEARNED_MOVES_MAX; i++) if (u16(entry(moves, i, 'moves')) === move) break;
  return i < LEARNED_MOVES_MAX;
}

/** Whether `moves` holds a move with `effect`; an empty slot never matches (trainer_ai.c:1751–1756 and its copies). */
function holdsEffect(d: AiDeps, moves: readonly number[], effect: number): boolean {
  let i: number;
  for (i = 0; i < LEARNED_MOVES_MAX; i++) {
    const move = u16(entry(moves, i, 'moves'));
    if (move !== MOVE_NONE && moveData(d, move).effect === effect) break;
  }
  return i < LEARNED_MOVES_MAX;
}

/**
 * The moves IfMoveKnown and IfMoveNotKnown search, by the script's battler code (trainer_ai.c:1637–1680, 1693–1736):
 * the attacker's real moves; the attacker's partner's real moves, or null (no jump either way) at 0 HP; the defender's
 * known moves; null for any other code, the defender's partner included.
 */
function movesKnownFor(ctx: RunCtx, inBattler: number, battler: number): readonly number[] | null {
  switch (inBattler) {
    case AI_BATTLER_ATTACKER: // :1638, :1694
      return battleMon(ctx.v, battler).moves;
    case AI_BATTLER_ATTACKER_PARTNER: { // :1650–1653, :1706–1709
      const mon = battleMon(ctx.v, battler);
      return mon.curHP === 0 ? null : mon.moves;
    }
    case AI_BATTLER_DEFENDER: // :1666–1668, :1722–1724
      return knownMoves(ctx, battler);
    default: // :1678–1679, :1734–1735
      return null;
  }
}

/**
 * The moves IfMoveEffectKnown and IfMoveEffectNotKnown search (trainer_ai.c:1749–1778, 1791–1820): the attacker's real
 * moves, the defender's known moves, and null (no jump either way) for any other code. Neither has a partner case.
 */
function effectsKnownFor(ctx: RunCtx, inBattler: number, battler: number): readonly number[] | null {
  switch (inBattler) {
    case AI_BATTLER_ATTACKER: // :1750–1753, :1792–1795
      return battleMon(ctx.v, battler).moves;
    case AI_BATTLER_DEFENDER: // :1763–1766, :1805–1808
      return knownMoves(ctx, battler);
    default: // :1776–1777, :1818–1819
      return null;
  }
}

/** AICmd_IfMoveKnown (`known`) and IfMoveNotKnown: `int inBattler`, `int move`, `int jump`. */
function ifMoveKnown(known: boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const move = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const moves = movesKnownFor(ctx, inBattler, battler);
    if (moves !== null && holdsMove(moves, move) === known) ctx.iter(jump); // :1645–1647, :1701–1703 and the like
  };
}

/** AICmd_IfMoveEffectKnown (`known`) and IfMoveEffectNotKnown: `int inBattler`, `int effect`, `int jump`. */
function ifMoveEffectKnown(known: boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const effect = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const moves = effectsKnownFor(ctx, inBattler, battler);
    if (moves !== null && holdsEffect(ctx.d, moves, effect) === known) ctx.iter(jump); // :1758–1760, :1800–1802 and the like
  };
}

export const KNOWLEDGE_OPS: OpTable = {
  LoadBattlerAbility: (ctx) => { // trainer_ai.c:1170–1210
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    const mon = battleMon(ctx.v, battler);
    if ((mon.moveEffectsMask & MOVE_EFFECT_ABILITY_SUPPRESSED) !== 0) {
      ctx.calcTemp = ABILITY_NONE; // :1177–1178: Gastro Acid, with no Multitype exception here
    } else if (ctx.attacker !== battler && inBattler !== AI_BATTLER_ATTACKER_PARTNER) { // :1179
      const known = knownAbility(ctx.k, battler);
      if (known !== ABILITY_NONE) {
        ctx.calcTemp = known; // :1181–1182
      } else if (trapsUs(u8(mon.ability))) {
        ctx.calcTemp = u8(mon.ability); // :1185–1188
      } else {
        const [ability1, ability2] = speciesAbilities(ctx.d, mon.species); // :1191–1192
        if (ability1 !== ABILITY_NONE && ability2 !== ABILITY_NONE) {
          ctx.calcTemp = ctx.pick(COIN) === 1 ? ability1 : ability2; // :1194–1199: a fresh RandNext() & 1 per call
        } else if (ability1 !== ABILITY_NONE) {
          ctx.calcTemp = ability1; // :1200–1201
        } else {
          ctx.calcTemp = ability2; // :1202–1203
        }
      }
    } else {
      ctx.calcTemp = u8(mon.ability); // :1207–1208: the attacker and its partner, the raw field
    }
  },

  CheckBattlerAbility: (ctx) => { // trainer_ai.c:1212–1266
    ctx.iter(1);
    const inBattler = ctx.read();
    const expected = ctx.read();
    const battler = ctx.battler(inBattler);
    const mon = battleMon(ctx.v, battler);
    let tmpAbility: number;
    if ((mon.moveEffectsMask & MOVE_EFFECT_ABILITY_SUPPRESSED) !== 0) {
      tmpAbility = ABILITY_NONE; // :1221–1222
    } else if (inBattler === AI_BATTLER_DEFENDER || inBattler === AI_BATTLER_DEFENDER_PARTNER) { // :1223
      const known = knownAbility(ctx.k, battler);
      if (known !== ABILITY_NONE) {
        tmpAbility = known; // :1225–1226
        ctx.calcTemp = known; // :1227, overwritten at :1259–1265
      } else if (trapsUs(u8(mon.ability))) {
        tmpAbility = u8(mon.ability); // :1230–1233
      } else {
        const [ability1, ability2] = speciesAbilities(ctx.d, mon.species); // :1236–1237
        if (ability1 !== ABILITY_NONE && ability2 !== ABILITY_NONE) {
          // :1239–1247: neither the one asked about, so ability 1; else none, as if unknown. No draw.
          tmpAbility = ability1 !== expected && ability2 !== expected ? ability1 : ABILITY_NONE;
        } else if (ability1 !== ABILITY_NONE) {
          tmpAbility = ability1; // :1248–1249
        } else {
          tmpAbility = ability2; // :1250–1251
        }
      }
    } else {
      tmpAbility = u8(mon.ability); // :1255–1256
    }
    if (tmpAbility === ABILITY_NONE) ctx.calcTemp = AI_UNKNOWN; // :1259–1260
    else if (tmpAbility === expected) ctx.calcTemp = AI_HAVE; // :1261–1262
    else ctx.calcTemp = AI_NOT_HAVE; // :1263–1264
  },

  LoadAbility: (ctx) => { // trainer_ai.c:2654–2662
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = battlerAbility(ctx.v, battler); // :2661: Battler_Ability, the real ability
  },

  LoadHeldItem: (ctx) => { // trainer_ai.c:1891–1899
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = u16(battleMon(ctx.v, battler).heldItem); // :1898: the real item, any battler
  },

  LoadHeldItemEffect: (ctx) => { // trainer_ai.c:1901–1913
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    if (ctx.attacker !== battler) {
      ctx.calcTemp = itemData(ctx.d, knownItem(ctx.k, battler), 'holdEffect'); // :1908–1909
    } else {
      ctx.calcTemp = itemData(ctx.d, battleMon(ctx.v, battler).heldItem, 'holdEffect'); // :1910–1911
    }
  },

  IfHeldItemEqualTo: (ctx) => { // trainer_ai.c:1915–1934
    ctx.iter(1);
    const inBattler = ctx.read();
    const expected = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    let heldItem: number; // u16
    if ((battler & 1) === (ctx.attacker & 1)) heldItem = u16(battleMon(ctx.v, battler).heldItem); // :1925–1926
    else heldItem = knownItem(ctx.k, battler); // :1927–1928
    if (heldItem === expected) ctx.iter(jump); // :1931–1933
  },

  LoadFlingPower: (ctx) => { // trainer_ai.c:2014–2022
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = itemFlingPower(ctx.v, ctx.d, battler); // :2021
  },

  IfMoveKnown: ifMoveKnown(true), // trainer_ai.c:1627–1681
  IfMoveNotKnown: ifMoveKnown(false), // trainer_ai.c:1683–1737
  IfMoveEffectKnown: ifMoveEffectKnown(true), // trainer_ai.c:1739–1779
  IfMoveEffectNotKnown: ifMoveEffectKnown(false), // trainer_ai.c:1781–1821
};
