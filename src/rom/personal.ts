// Decodes species records from `poketool/personal/pl_personal.narc` (44 bytes each).

import type { SpeciesRecord } from './types.js';

/** Decodes one species. The ROM stores base stats as HP, Atk, Def, Spe, SpA, SpD. */
export function decodePersonal(id: number, rec: Uint8Array): SpeciesRecord {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const u8 = (offset: number) => view.getUint8(offset);
  return {
    id,
    baseStats: { hp: u8(0), atk: u8(1), def: u8(2), spe: u8(3), spa: u8(4), spd: u8(5) },
    types: [u8(6), u8(7)],
    // SpeciesData: baseStats (6 bytes), types[2], catchRate (8), baseExpReward (9), evYields (u16 of 2-bit fields at 10)
    // - pokeplatinum include/struct_defs/species.h:39-44 (SpeciesEVYields, 25-32).
    baseExp: u8(9),
    evYield: view.getUint16(10, true),
    genderRatio: u8(16),
    baseFriendship: u8(18),
    growthRate: u8(19),
    abilities: [u8(22), u8(23)],
  };
}
