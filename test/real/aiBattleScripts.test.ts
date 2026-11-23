// Real-data check: the hack's battle-script NARCs against vanilla's, member by member. The
// sets in src/ai/battleScripts.ts are built from the decompilation's scripts; an effect whose script the hack changed
// joins both of them, and so would any effect that can reach a changed subscript. This finds the changed members and
// checks, by a raw scan that over-approximates, that no unchanged effect reaches a changed subscript and that no changed
// subscript (nor anything it reaches) writes battleStatusMask's AI-read bits or powerMul.
//
// The scripts are u32 words: a command's ID, then its arguments (asm/macros/btlcmd.inc). The raw scan reads every word
// as if a command could start there, so it finds every real call and write and maybe some that aren't.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { HACK_CHANGED_EFFECTS, HACK_CHANGED_SUBSCRIPTS } from '../../src/ai/battleScripts.js';
import { SYSCTL_IGNORE_IMMUNITIES, SYSCTL_IGNORE_TYPE_CHECKS, SYSCTL_LAST_OF_MULTI_TURN } from '../../src/ai/constants.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';


// Command IDs: their order in include/data/scripts/btlcmd.h (from 0).
const BTLCMD_GOTOSUBSCRIPT = 35;
const BTLCMD_UPDATEVAR = 50;
const BTLCMD_UPDATEVARFROMVAR = 57;
const BTLCMD_UPDATEMONDATAFROMVAR = 58;
const BTLCMD_CALL = 60;
const BTLCMD_DIVIDEVARBYVALUE = 85;
const BTLCMD_DIVIDEVARBYVAR = 86;
const BTLCMD_GETMONBYSPEEDORDER = 107;
const BTLCMD_CALCREVENGEPOWERMUL = 132;
const BTLCMD_TRYPURSUIT = 142;
const BTLCMD_GETITEMHOLDEFFECT = 167;
const BTLCMD_GETITEMEFFECTPARAM = 168;
// generated/battle_script_vars.txt and battle_script_opcodes.txt (line − 1).
const BTLVAR_BATTLE_CTX_STATUS = 6;
const BTLVAR_POWER_MULTI = 8;
const OPCODE_SET = 7;
const OPCODE_FLAG_ON = 10;
const OPCODE_FLAG_OFF = 11;

const READ_BITS = SYSCTL_LAST_OF_MULTI_TURN | SYSCTL_IGNORE_TYPE_CHECKS | SYSCTL_IGNORE_IMMUNITIES;

type Words = number[];

function words(member: Uint8Array): Words {
  const out: number[] = [];
  const view = new DataView(member.buffer, member.byteOffset, member.byteLength);
  for (let at = 0; at + 4 <= member.byteLength; at += 4) out.push(view.getUint32(at, true));
  return out;
}

/** Every subscript a Call or GoToSubscript could name, read at every word. */
function rawCalls(script: Words, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < script.length; i++) {
    if ((script[i] === BTLCMD_CALL || script[i] === BTLCMD_GOTOSUBSCRIPT) && script[i + 1]! < count) out.push(script[i + 1]!);
  }
  return out;
}

/**
 * Every place a command could write variable `variable` (BattleScript_VarAddress's writers: UpdateVar, UpdateVarFromVar,
 * UpdateMonDataFromVar, DivideVarByValue, DivideVarByVar, GetMonBySpeedOrder, GetItemHoldEffect, GetItemEffectParam),
 * read at every word, and for powerMul the C writers CalcRevengePowerMul and TryPursuit. An UpdateVar that only clears
 * bits, or sets the mask to a value without the read bits, writes none of them.
 */
function rawWrites(script: Words, variable: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < script.length; i++) {
    const at = (k: number): number | undefined => script[i + k];
    const command = script[i];
    if (command === BTLCMD_UPDATEVAR && at(2) === variable) {
      const op = at(1);
      const clearsOnly = op === OPCODE_FLAG_OFF
        || (variable === BTLVAR_BATTLE_CTX_STATUS && (op === OPCODE_SET || op === OPCODE_FLAG_ON) && ((at(3) ?? 0) & READ_BITS) === 0);
      if (!clearsOnly) out.push(i);
    }
    if (command === BTLCMD_UPDATEVARFROMVAR && at(2) === variable && at(1) !== OPCODE_FLAG_OFF) out.push(i);
    if (command === BTLCMD_UPDATEMONDATAFROMVAR && at(4) === variable) out.push(i);
    if ((command === BTLCMD_DIVIDEVARBYVALUE || command === BTLCMD_DIVIDEVARBYVAR || command === BTLCMD_GETMONBYSPEEDORDER)
      && at(1) === variable) out.push(i);
    if ((command === BTLCMD_GETITEMHOLDEFFECT || command === BTLCMD_GETITEMEFFECTPARAM) && at(2) === variable) out.push(i);
    if (variable === BTLVAR_POWER_MULTI && (command === BTLCMD_CALCREVENGEPOWERMUL || command === BTLCMD_TRYPURSUIT)) out.push(i);
  }
  return out;
}

/** The subscripts `start` reaches by raw calls, `start` included. */
function closure(start: readonly number[], subscripts: readonly Words[]): Set<number> {
  const seen = new Set<number>();
  const todo = [...start];
  while (todo.length > 0) {
    const next = todo.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    todo.push(...rawCalls(subscripts[next] ?? [], subscripts.length));
  }
  return seen;
}

function changed(hack: readonly Words[], vanilla: readonly Words[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(hack.length, vanilla.length); i++) {
    const a = hack[i];
    const b = vanilla[i];
    if (a === undefined || b === undefined || a.length !== b.length || a.some((word, j) => word !== b[j])) out.push(i);
  }
  return out;
}

const suite = needFiles("the hack's battle scripts against vanilla's", { PK_ROM, PK_VANILLA_ROM });

describe.skipIf(suite.skip)(suite.title, () => {
  const narcs = { effects: 'battle/skill/be_seq.narc', subscripts: 'battle/skill/sub_seq.narc', moves: 'battle/skill/waza_seq.narc' };
  let hack: Record<keyof typeof narcs, Words[]>;
  let vanilla: Record<keyof typeof narcs, Words[]>;

  beforeAll(() => {
    const read = (path: string): Record<keyof typeof narcs, Words[]> => {
      const files = readNdsFiles(readFileSync(path));
      const members = (name: string): Words[] => {
        const narc = files.get(name);
        if (narc === undefined) throw new Error(`${path} has no ${name}`);
        return readNarc(narc).map(words);
      };
      return { effects: members(narcs.effects), subscripts: members(narcs.subscripts), moves: members(narcs.moves) };
    };
    hack = read(PK_ROM);
    vanilla = read(PK_VANILLA_ROM);
  });

  it('the changed members are the ones battleScripts.ts lists', () => {
    expect(hack.effects).toHaveLength(vanilla.effects.length);
    expect(changed(hack.effects, vanilla.effects)).toEqual([...HACK_CHANGED_EFFECTS]);
    expect(hack.subscripts).toHaveLength(vanilla.subscripts.length + 1); // 297, the switch-in field effect
    expect(changed(hack.subscripts, vanilla.subscripts)).toEqual([...HACK_CHANGED_SUBSCRIPTS]);
    // Each move's entry script (GoToEffectScript, battle_script.c:2084) is the same.
    expect(changed(hack.moves, vanilla.moves)).toEqual([]);
  });

  it('no effect reaches a changed subscript by a literal call', () => {
    // A side-effect pointer reaches a subscript through sSideEffectSubscripts (include/data/move_side_effect_subscripts.h),
    // C data none of whose entries is 238 or 251 (turn-end subscripts, battle_controller_player.c:1232, 1826) or 297.
    const reaching = hack.effects.flatMap((script, effect) => {
      const reached = closure(rawCalls(script, hack.subscripts.length), hack.subscripts);
      return HACK_CHANGED_SUBSCRIPTS.some((subscript) => reached.has(subscript)) ? [effect] : [];
    });
    expect(reaching).toEqual([]);
  });

  it('no changed subscript, nor any subscript it reaches, writes the AI-read bits or powerMul', () => {
    // So the turn-end checks that run 238 and 251 after the last action's MoveEnd leave both as BattleContext_Init set
    // them (battle_controller_player.c:3998), and the post-KO replacement reads 0 and 10.
    for (const subscript of HACK_CHANGED_SUBSCRIPTS) {
      for (const reached of closure([subscript], hack.subscripts)) {
        expect(rawWrites(hack.subscripts[reached]!, BTLVAR_BATTLE_CTX_STATUS), `subscript ${reached}`).toEqual([]);
        expect(rawWrites(hack.subscripts[reached]!, BTLVAR_POWER_MULTI), `subscript ${reached}`).toEqual([]);
      }
    }
  });

  it("the raw scan finds the writers the decompilation shows, so it isn't blind", () => {
    // Seismic Toss's effect 87 sets IGNORE_TYPE_CHECKS (effect_script_0087.s:5); Revenge's 185 runs CalcRevengePowerMul
    // (effect_script_0185.s:5); subscript_pursuit (153) runs TryPursuit (subscript_pursuit.s:8).
    expect(rawWrites(vanilla.effects[87]!, BTLVAR_BATTLE_CTX_STATUS).length).toBeGreaterThan(0);
    expect(rawWrites(vanilla.effects[185]!, BTLVAR_POWER_MULTI).length).toBeGreaterThan(0);
    expect(rawWrites(vanilla.subscripts[153]!, BTLVAR_POWER_MULTI).length).toBeGreaterThan(0);
  });
});
