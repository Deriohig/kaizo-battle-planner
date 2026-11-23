// Real-data check (F3, spot check 15): what the memory's Imprison mark (src/ai/memory.ts imprisonedMark) relies on, in
// the hack and in vanilla. The memory marks the user's foe at every `|move|` line of MOVE_IMPRISON (286), and clears a
// battler's mark only when a new BattleMon takes its slot, so:
// - BtlCmd_TryImprison, which sets MOVE_EFFECT_IMPRISONED on the foe (battle_script.c:6686–6690), runs only from
//   Imprison's effect script. In the decompilation it is effect_script_0192.s's first command and in no other script.
//   The hack's scripts are vanilla's but for the members test/real/aiBattleScripts.test.ts pins (HACK_CHANGED_EFFECTS,
//   HACK_CHANGED_SUBSCRIPTS; every move's entry script is the same), and none of those holds the command's word at all;
// - move 286 is the only move with that effect, in either ROM, so no other move reaches it (each move's entry script
//   is GoToEffectScript, battle_script.c:2084);
// - neither side lets Snatch or Magic Coat take Imprison: the ROM's record has neither flag (vanilla's
//   res/moves/imprison/data.json has none), and Showdown's Gen 4 data, whose flags the engine's hack moves copy
//   (src/engine/dex.ts showdownMoveData), has neither `snatch` nor `reflectable` (data/mods/gen4/moves.ts);
// - nothing else sets or clears the bit. In C only TryImprison sets it, and only a new BattleMon clears it
//   (battle_lib.c:2071, 2076, 2166; no other assignment to moveEffectsMask in src/battle). The decompilation's script
//   writes to BATTLEMON_MOVE_EFFECTS_MASK set or clear other named bits (UpdateMonData with MOVE_EFFECT_AIRBORNE,
//   _SEMI_INVULNERABLE, _HEAL_BLOCK…; a BITWISE_XOR of MOVE_EFFECT_POWER_TRICK, subscript_user_swap_atk_and_def.s:5) or
//   OR in a battler index (subscript_leech_seed_start.s's UpdateMonDataFromVar of BTLVAR_ATTACKER). The hack's changed
//   members are scanned here for any write that could touch the bit.

import { readFileSync } from 'node:fs';
import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it } from 'vitest';
import { HACK_CHANGED_EFFECTS, HACK_CHANGED_SUBSCRIPTS } from '../../src/ai/battleScripts.js';
import { MOVE_IMPRISON } from '../../src/ai/constants.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { decodeMove } from '../../src/rom/moves.js';
import type { MoveRecord } from '../../src/rom/types.js';
import { needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';


// Command IDs: their order in include/data/scripts/btlcmd.h (line − 8: the first command is at line 8).
const BTLCMD_UPDATEMONDATA = 52;
const BTLCMD_UPDATEMONDATAFROMVAR = 58;
const BTLCMD_TRYIMPRISON = 137;
/** generated/battle_mon_params.txt, line − 1. */
const BATTLEMON_MOVE_EFFECTS_MASK = 59;
// generated/battle_script_opcodes.txt, line − 1 (21 opcodes); generated/battle_script_battlers.txt has 23 codes.
const OPCODE_FLAG_ON = 10;
const OPCODE_FLAG_OFF = 11;
const OPCODE_GET = 17;
const OPCODE_BITWISE_XOR = 19;
const OPCODE_BITWISE_AND = 20;
const OPCODE_COUNT = 21;
const BTLSCR_COUNT = 23;
/** BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE: line − 1 of generated/move_battle_effects.txt. */
const BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE = 192;
/** Fly's effect, whose script clears MOVE_EFFECT_SEMI_INVULNERABLE (effect_script_0155.s:24). */
const BATTLE_EFFECT_FLY = 155;
/** generated/move_flags.txt: MOVE_FLAG_CAN_MAGIC_COAT is bit 2, MOVE_FLAG_CAN_SNATCH bit 3. */
const MOVE_FLAG_CAN_MAGIC_COAT = 1 << 2;
const MOVE_FLAG_CAN_SNATCH = 1 << 3;
/** MOVE_EFFECT_IMPRISONED, include/constants/battle/moves.h:38. */
const MOVE_EFFECT_IMPRISONED = 1 << 30;

type Words = number[];

function words(member: Uint8Array): Words {
  const out: number[] = [];
  const view = new DataView(member.buffer, member.byteOffset, member.byteLength);
  for (let at = 0; at + 4 <= member.byteLength; at += 4) out.push(view.getUint32(at, true));
  return out;
}

/**
 * Every place a command could write BattleMon.moveEffectsMask (`UpdateMonData op, battler, param, value` and
 * `UpdateMonDataFromVar op, battler, param, var`, asm/macros/btlcmd.inc:354–360, 395–401), read at every word with an
 * opcode and a battler code in range, as every real one is: `all` holds them, to show the scan isn't blind, and
 * `touching` the ones that could set or clear MOVE_EFFECT_IMPRISONED (BtlCmd_UpdateMonData and
 * BtlCmd_UpdateMonDataFromVar, battle_script.c:2994–3080, 3321–3410). A value without the bit leaves it under FLAG_ON,
 * FLAG_OFF and BITWISE_XOR, a value with it under BITWISE_AND, and GET writes nothing; any other op, or a var's value,
 * which the scan can't see, may change it.
 */
function maskWrites(script: Words): { all: number[]; touching: number[] } {
  const all: number[] = [];
  const touching: number[] = [];
  for (let i = 0; i + 4 < script.length; i++) {
    const [command, op, battler, param, value] = script.slice(i, i + 5) as [number, number, number, number, number];
    if ((command !== BTLCMD_UPDATEMONDATA && command !== BTLCMD_UPDATEMONDATAFROMVAR) || param !== BATTLEMON_MOVE_EFFECTS_MASK
      || op >= OPCODE_COUNT || battler >= BTLSCR_COUNT) continue;
    all.push(i);
    const bit = ((value >>> 0) & MOVE_EFFECT_IMPRISONED) !== 0;
    const keeps = op === OPCODE_GET || (command === BTLCMD_UPDATEMONDATA
      && ((!bit && (op === OPCODE_FLAG_ON || op === OPCODE_FLAG_OFF || op === OPCODE_BITWISE_XOR)) || (bit && op === OPCODE_BITWISE_AND)));
    if (!keeps) touching.push(i);
  }
  return { all, touching };
}

interface RomData { effects: Words[]; subscripts: Words[]; moves: MoveRecord[] }

function readRom(path: string): RomData {
  const files = readNdsFiles(readFileSync(path));
  const members = (name: string): Uint8Array[] => {
    const narc = files.get(name);
    if (narc === undefined) throw new Error(`${path} has no ${name}`);
    return readNarc(narc);
  };
  return {
    effects: members('battle/skill/be_seq.narc').map(words),
    subscripts: members('battle/skill/sub_seq.narc').map(words),
    moves: members('poketool/waza/pl_waza_tbl.narc').map((record, id) => decodeMove(id, record)),
  };
}

const suite = needFiles("Imprison's mark: the hack's and vanilla's scripts and move records", { PK_ROM, PK_VANILLA_ROM });

describe.skipIf(suite.skip)(suite.title, () => {
  let hack: RomData;
  let vanilla: RomData;

  beforeAll(() => {
    hack = readRom(PK_ROM);
    vanilla = readRom(PK_VANILLA_ROM);
  });

  /** The hack's members that differ from vanilla's, which aiBattleScripts.test.ts pins. */
  const changedMembers = (): [string, Words][] => [
    ...HACK_CHANGED_EFFECTS.map((effect): [string, Words] => [`effect ${effect}`, hack.effects[effect]!]),
    ...HACK_CHANGED_SUBSCRIPTS.map((subscript): [string, Words] => [`subscript ${subscript}`, hack.subscripts[subscript]!]),
  ];

  it("TryImprison: Imprison's effect script is vanilla's in the hack, and no changed script holds the command", () => {
    expect(HACK_CHANGED_EFFECTS).not.toContain(BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE);
    expect(hack.effects[BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE]).toEqual(vanilla.effects[BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE]);
    expect(vanilla.effects[BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE]![0]).toBe(BTLCMD_TRYIMPRISON); // effect_script_0192.s:5
    expect(changedMembers().filter(([, script]) => script.includes(BTLCMD_TRYIMPRISON)).map(([name]) => name)).toEqual([]);
  });

  it('no changed script of the hack could set or clear MOVE_EFFECT_IMPRISONED', () => {
    expect(changedMembers().flatMap(([name, script]) => maskWrites(script).touching.map((at) => `${name} at ${at}`))).toEqual([]);
    // Not blind: Fly's effect clears MOVE_EFFECT_SEMI_INVULNERABLE (effect_script_0155.s:24), and Power Trick's
    // subscript toggles MOVE_EFFECT_POWER_TRICK with BITWISE_XOR (subscript_user_swap_atk_and_def.s:5), both kept.
    expect(maskWrites(vanilla.effects[BATTLE_EFFECT_FLY]!)).toMatchObject({ touching: [] });
    expect(maskWrites(vanilla.effects[BATTLE_EFFECT_FLY]!).all.length).toBeGreaterThan(0);
    expect(vanilla.subscripts.some((script) => maskWrites(script).all.some((at) => script[at + 1] === OPCODE_BITWISE_XOR))).toBe(true);
  });

  for (const [name, rom] of [['the hack', () => hack], ['vanilla', () => vanilla]] as const) {
    it(`${name}: move ${MOVE_IMPRISON} is the one move with Imprison's effect, and Snatch and Magic Coat can't take it`, () => {
      const moves = rom().moves;
      const imprisons = moves.filter((move) => move.effect === BATTLE_EFFECT_MAKE_SHARED_MOVES_UNUSEABLE).map((move) => move.id);
      expect(imprisons).toEqual([MOVE_IMPRISON]);
      expect(moves[MOVE_IMPRISON]!.flags & (MOVE_FLAG_CAN_SNATCH | MOVE_FLAG_CAN_MAGIC_COAT)).toBe(0);
    });
  }

  it("Showdown's Gen 4 Imprison targets its user and has no snatch or reflectable flag", () => {
    const imprison = PS.Dex.mod('gen4').moves.get('imprison');
    expect(imprison.num).toBe(MOVE_IMPRISON);
    expect(imprison.flags.snatch).toBeUndefined();
    expect(imprison.flags.reflectable).toBeUndefined();
    expect(imprison.target).toBe('self');
  });
});
