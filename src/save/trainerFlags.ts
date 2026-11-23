// The trainers a save has beaten, from the trainer-defeated flags in the general block. The game keeps one event flag per
// trainer, TRAINER_DEFEATED_FLAGS_START plus the trainer's ID (pokeplatinum src/script_manager.c:485-498, which
// ScrCmd_SetTrainerFlag and ScrCmd_CheckTrainerFlag call, src/scrcmd.c:1127-1150). A trainer's ID is its index in
// trdata.narc, `RomTrainer.index`: the ID a trainer's script gives (Script_GetTrainerID, src/script_manager.c:466-473)
// is the one its battle loads (Encounter_NewVsTrainer takes TRAINER_YOUNGSTER_TRISTAN, trainer 1, src/scrcmd_trainer.c:295).
//
// Where the flags sit. The general block is the save table's SAVE_BLOCK_ID_NORMAL entries back to back, each taking its
// size rounded up past a multiple of 4, plus 4 (SaveTableEntry_BodySize and SavePageInfo_Init, src/savedata.c:813-850).
// VarsFlags is the fifth entry, after System, Player, Party and Bag (gSaveTable, src/savedata/save_table.c:48-53):
// - Party starts at 0x98: its `currentCount` (include/party.h:11-15, after `capacity`) is the count `readSave` reads at
//   0x9C. sizeof(Party) is 8 + 6 Pokémon of 0xEC bytes = 0x590, so it takes 0x598 and Bag starts at 0x630.
// - sizeof(Bag) is 476 four-byte BagItems (the eight pockets, 165 + 50 + 100 + 12 + 40 + 64 + 15 + 30) and a u32
//   registered item = 0x774 (include/bag.h:9-16, 30-45), so it takes 0x77C and VarsFlags starts at 0xDAC.
// - VarsFlags is u16 vars[NUM_VARS], then u8 flags[NUM_FLAGS / 8] (include/vars_flags.h:8-15). NUM_VARS is VARS_END
//   minus VARS_START (include/constants/savedata/vars_flags.h:6), 0x4120 - 0x4000 = 288 (generated/vars_flags.txt:4107
//   and 4399), so the flags start at 0xDAC + 288 * 2 = 0xFEC (PKHeX's SAV4Pt reads its event flags there too).
// - Flag n is bit n % 8 of flags[n / 8] (src/vars_flags.c:10, 52-58).
// TRAINER_DEFEATED_FLAGS_START is flag 0x550, the entry after FLAG_UNUSED_0x054F, and TRAINER_DEFEATED_FLAGS_END is flag
// 0x8EF (generated/vars_flags.txt:1365, 2294): trainers 0 to 927, as many as the build allows (trainerproc.c:110-113)
// and as many as the Kaizo ROM holds (`npm run test:real` checks it).

/** The general block's event flags, `VarsFlags.flags`. */
const FLAGS = 0xfec;
/** TRAINER_DEFEATED_FLAGS_START: the flag of trainer 0. */
const TRAINER_FLAGS_START = 0x550;
/** The trainers with a defeated flag, IDs 0 to 927 (TRAINER_DEFEATED_FLAGS_END - TRAINER_DEFEATED_FLAGS_START + 1). */
export const TRAINER_FLAG_COUNT = 928;

/**
 * The ROM trainer indexes (`RomTrainer.index`) whose trainer-defeated flag is set in `general`, a save's general block.
 * The game sets a trainer's flag when the player beats a trainer who spots them, and wherever an event script says to
 * (ScrCmd_SetTrainerFlag); a scripted battle whose script does not, such as a Gym Leader's or the rival's, leaves it unset.
 */
export function readTrainerFlags(general: Uint8Array): Set<number> {
  const defeated = new Set<number>();
  for (let trainer = 0; trainer < TRAINER_FLAG_COUNT; trainer++) {
    const flag = TRAINER_FLAGS_START + trainer;
    if (((general[FLAGS + (flag >> 3)] ?? 0) >> (flag & 7)) & 1) defeated.add(trainer);
  }
  return defeated;
}
