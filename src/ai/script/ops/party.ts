// The AI script commands that read a side's party: the alive count, bench statuses, HP and PP. Literal ports of the
// AICmd_* handlers in trainer_ai.c over AiView's parties; each cites its lines. Every handler starts as the C does, with
// AIScript_Iter(1) past its opcode, and reads its arguments in the C's order.
//
// Singles only (runScript refuses doubles): the handlers' BATTLE_TYPE_DOUBLES branches, which also skip the partner's
// active slot, never run, so the C's two slots are both selectedPartySlot[battler] (trainer_ai.c:1141–1142, 1362–1363,
// 1395–1396).

import { LEARNED_MOVES_MAX, SPECIES_EGG, SPECIES_NONE } from '../../constants.js';
import { u32, u8 } from '../../int.js';
import type { AiPartyMon, AiView } from '../../view.js';
import type { OpHandler, OpTable } from '../run.js';
import { entry } from './state.js';

/**
 * BattleSystem_GetParty and BattleSystem_GetPartyCount (battle_system.c:124–146): in singles, battleSys->parties[battler]
 * (:131, :144). The DTO has four parties (field_battle_data_transfer.c:89) and battle start copies all four
 * (battle_main.c:1335–1336), but a single battle fills only the two sides', so a partner slot's party is empty.
 */
export function battlerParty(v: AiView, battler: number): readonly AiPartyMon[] {
  if (battler === 0 || battler === 1) return entry(v.parties, battler, 'parties');
  return [];
}

/** selectedPartySlot[battler] (u8): the battler's active party slot. */
export function activePartySlot(v: AiView, battler: number): number {
  return u8(entry(v.selectedPartySlot, battler, 'selectedPartySlot'));
}

/**
 * The live-member test (trainer_ai.c:1150–1152, 1371–1373, 2145–2147): HP, and MON_DATA_SPECIES_OR_EGG neither
 * SPECIES_NONE nor SPECIES_EGG. The view's species stands for MON_DATA_SPECIES_OR_EGG: an egg carries SPECIES_EGG.
 */
export function isLiveMember(mon: AiPartyMon): boolean {
  return mon.hp !== 0 && mon.species !== SPECIES_NONE && mon.species !== SPECIES_EGG;
}

/** AICmd_IfPartyMemberStatus and IfPartyMemberNotStatus: `set` jumps on a status bit of the mask, else on none. */
function ifPartyMemberStatus(set: boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const statusMask = u32(ctx.read()); // u32 statusMask
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const slot = activePartySlot(ctx.v, battler); // slot1 = slot2 in singles
    const party = battlerParty(ctx.v, battler);
    for (let i = 0; i < party.length; i++) {
      const mon = party[i]!;
      if (i !== slot && isLiveMember(mon) && ((mon.status & statusMask) !== 0) === set) {
        ctx.iter(jump);
        return;
      }
    }
  };
}

export const PARTY_OPS: OpTable = {
  CountAlivePartyBattlers: (ctx) => { // trainer_ai.c:1126–1156
    ctx.iter(1);
    const inBattler = ctx.read();
    ctx.calcTemp = 0; // :1132
    const battler = ctx.battler(inBattler);
    const party = battlerParty(ctx.v, battler);
    const battlerSlot = activePartySlot(ctx.v, battler); // :1141–1142: partnerSlot is the same
    for (let i = 0; i < party.length; i++) { // :1145
      if (i !== battlerSlot && isLiveMember(party[i]!)) ctx.calcTemp++; // :1148–1154
    }
  },

  IfPartyMemberStatus: ifPartyMemberStatus(true), // trainer_ai.c:1348–1379, the test at :1370–1374
  IfPartyMemberNotStatus: ifPartyMemberStatus(false), // trainer_ai.c:1381–1412, the test at :1403–1407

  IfAnyPartyMemberIsWounded: (ctx) => { // trainer_ai.c:1968–1985
    ctx.iter(1);
    const inBattler = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const slot = activePartySlot(ctx.v, battler);
    const party = battlerParty(ctx.v, battler);
    for (let i = 0; i < party.length; i++) { // :1976
      const mon = party[i]!;
      if (i !== slot && mon.hp !== mon.maxHp) { // :1979–1980: no HP or species test, so a fainted member counts
        ctx.iter(jump);
        break;
      }
    }
  },

  IfAnyPartyMemberUsedPP: (ctx) => { // trainer_ai.c:1987–2012
    ctx.iter(1);
    const inBattler = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const slot = activePartySlot(ctx.v, battler);
    const party = battlerParty(ctx.v, battler);
    for (let partySlot = 0; partySlot < party.length; partySlot++) { // :1996
      if (partySlot === slot) continue; // :1999
      const mon = party[partySlot]!;
      let moveSlot: number;
      for (moveSlot = 0; moveSlot < LEARNED_MOVES_MAX; moveSlot++) { // :2000–2005
        if (entry(mon.pp, moveSlot, 'pp') !== entry(mon.ppMax, moveSlot, 'ppMax')) {
          ctx.iter(jump);
          break;
        }
      }
      if (moveSlot !== LEARNED_MOVES_MAX) break; // :2007–2009
    }
  },
};
