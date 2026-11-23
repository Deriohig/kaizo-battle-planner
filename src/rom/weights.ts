// The Pokédex weights the battle gives each BattleMon. BattleSystem_InitBattleMon (battle_lib.c:145–153) loads the
// Pokédex height and weight data (Pokedex_HeightWeightData_Load, pokedex_heightweight.c:34–55), whose weights are
// member 1 of the Pokédex data NARC read as an `int` array (Pokedex_Weight_Array, :126–130), and takes the entry at the
// battler's species ID (Pokedex_HeightWeightData_Weight, :85–90) into the s32 BattleMon.weight (battle_mon.h:77), in
// hectograms. Which NARC: just before, Pokedex_SetupGiratina is called with the battler's form (battle_lib.c:145) and
// picks zukan_data_gira.narc for form 0 and zukan_data.narc for any other form (pokedex_data_index.c:14–25). In both the
// hack and vanilla the two differ only at Giratina: Altered's 750.0 kg in the form-0 NARC, Origin's 650.0 kg in the other.
//
// A standalone reader: RomData doesn't hold the weights yet (no schema change). The trainer AI's extract caches both
// tables in trainer-ai.json (src/ai/rom/aiData.ts).

import { RomError } from '../errors.js';
import { readNarc } from '../nds/narc.js';

/** NARC_INDEX_APPLICATION__ZUKANLIST__ZKN_DATA__ZUKAN_DATA_GIRA (form 0) and …__ZUKAN_DATA (any other form). */
export const WEIGHT_NARCS = {
  form0: 'application/zukanlist/zkn_data/zukan_data_gira.narc',
  otherForms: 'application/zukanlist/zkn_data/zukan_data.narc',
} as const;

/** The weights' member (Pokedex_Weight_Array, pokedex_heightweight.c:128). */
const WEIGHT_MEMBER = 1;
/** sizeof(int). */
const INT_SIZE = 4;

/**
 * The Pokédex weight of each species ID, in hectograms, as BattleSystem_InitBattleMon loads it for a battler of form
 * `form`: from zukan_data_gira.narc for form 0, else zukan_data.narc. RomError('MISSING_FILE') without that NARC,
 * RomError('BAD_FORMAT') without a weights member of whole `int`s.
 */
export function decodeWeights(files: Map<string, Uint8Array>, form = 0): number[] {
  const path = form === 0 ? WEIGHT_NARCS.form0 : WEIGHT_NARCS.otherForms;
  const narc = files.get(path);
  if (narc === undefined) throw new RomError('MISSING_FILE', `The ROM has no ${path}`);
  const member = readNarc(narc)[WEIGHT_MEMBER];
  if (member === undefined) throw new RomError('BAD_FORMAT', `${path} has no member ${WEIGHT_MEMBER}, the Pokédex weights`);
  if (member.length === 0 || member.length % INT_SIZE !== 0) {
    throw new RomError('BAD_FORMAT', `${path}'s weights are ${member.length} bytes, not a whole number of ${INT_SIZE}-byte ints`);
  }
  const view = new DataView(member.buffer, member.byteOffset, member.byteLength);
  return Array.from({ length: member.length / INT_SIZE }, (_, species) => view.getInt32(species * INT_SIZE, true));
}
