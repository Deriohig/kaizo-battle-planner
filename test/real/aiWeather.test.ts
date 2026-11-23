// Real-data check: what the memory's _PERM weather (src/ai/memory.ts permWeather) relies on, in the hack and
// in vanilla. The memory keeps a _PERM weather through a weather move into its own weather, clears it at another
// weather move's line, and clears it at every `|move|` line of MOVE_HAIL (258), so:
// - Rain Dance's, Sunny Day's and Sandstorm's effect scripts fail while either bit of their weather is set, and Hail's
//   only while HAILING_TEMP is: each starts with `CompareVarToValue OPCODE_FLAG_SET, BTLVAR_FIELD_CONDITIONS, …`
//   (effect_script_0136.s:5, effect_script_0137.s:5, effect_script_0115.s:5, effect_script_0164.s:5). The hack's are
//   vanilla's, and none is among the members aiBattleScripts.test.ts pins (HACK_CHANGED_EFFECTS);
// - move 258 is the only move with Hail's effect, in either ROM, so no other move reaches its script (each move's entry
//   script is GoToEffectScript, battle_script.c:2084).

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { HACK_CHANGED_EFFECTS } from '../../src/ai/battleScripts.js';
import { MOVE_HAIL } from '../../src/ai/constants.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { decodeMove } from '../../src/rom/moves.js';
import type { MoveRecord } from '../../src/rom/types.js';
import { needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';


/** include/data/scripts/btlcmd.h, line − 8 (the first command is at line 8). */
const BTLCMD_COMPAREVARTOVALUE = 32;
/** generated/battle_script_opcodes.txt, line − 1. */
const OPCODE_FLAG_SET = 4;
/** generated/battle_script_vars.txt, line − 1. */
const BTLVAR_FIELD_CONDITIONS = 7;
/** The weather moves' effects (generated/move_battle_effects.txt, line − 1), and the bits each one's script tests first
 * (include/constants/battle/condition.h:110–117, 127–130). */
const WEATHER_EFFECTS: readonly { name: string; effect: number; bits: number }[] = [
  { name: 'Sandstorm', effect: 115, bits: 0b1100 }, // FIELD_CONDITION_SANDSTORM: _TEMP | _PERM
  { name: 'Rain Dance', effect: 136, bits: 0b11 }, // FIELD_CONDITION_RAINING
  { name: 'Sunny Day', effect: 137, bits: 0b110000 }, // FIELD_CONDITION_SUNNY
  { name: 'Hail', effect: 164, bits: 1 << 6 }, // FIELD_CONDITION_HAILING_TEMP alone
];
const BATTLE_EFFECT_WEATHER_HAIL = 164;

type Words = number[];

function words(member: Uint8Array): Words {
  const out: number[] = [];
  const view = new DataView(member.buffer, member.byteOffset, member.byteLength);
  for (let at = 0; at + 4 <= member.byteLength; at += 4) out.push(view.getUint32(at, true));
  return out;
}

interface RomData { effects: Words[]; moves: MoveRecord[] }

function readRom(path: string): RomData {
  const files = readNdsFiles(readFileSync(path));
  const members = (name: string): Uint8Array[] => {
    const narc = files.get(name);
    if (narc === undefined) throw new Error(`${path} has no ${name}`);
    return readNarc(narc);
  };
  return {
    effects: members('battle/skill/be_seq.narc').map(words),
    moves: members('poketool/waza/pl_waza_tbl.narc').map((record, id) => decodeMove(id, record)),
  };
}

const suite = needFiles("the _PERM weather: the weather moves' scripts and move records, the hack's and vanilla's", { PK_ROM, PK_VANILLA_ROM });

describe.skipIf(suite.skip)(suite.title, () => {
  let hack: RomData;
  let vanilla: RomData;

  beforeAll(() => {
    hack = readRom(PK_ROM);
    vanilla = readRom(PK_VANILLA_ROM);
  });

  it("each weather move's script first tests its weather's bits, Hail's only HAILING_TEMP, and the hack's is vanilla's", () => {
    for (const { name, effect, bits } of WEATHER_EFFECTS) {
      expect(HACK_CHANGED_EFFECTS, name).not.toContain(effect);
      expect(hack.effects[effect], name).toEqual(vanilla.effects[effect]);
      expect(vanilla.effects[effect]!.slice(0, 4), name).toEqual([BTLCMD_COMPAREVARTOVALUE, OPCODE_FLAG_SET, BTLVAR_FIELD_CONDITIONS, bits]);
    }
  });

  for (const [name, rom] of [['the hack', () => hack], ['vanilla', () => vanilla]] as const) {
    it(`${name}: move ${MOVE_HAIL} is the one move with Hail's effect`, () => {
      expect(rom().moves.filter((move) => move.effect === BATTLE_EFFECT_WEATHER_HAIL).map((move) => move.id)).toEqual([MOVE_HAIL]);
    });
  }
});
