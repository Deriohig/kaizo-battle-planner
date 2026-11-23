// Decodes trainers from `poketool/trainer/trdata.narc` (20-byte headers) and `trpoke.narc` (parties),
// and derives each Pokémon's PID the way the game does (`TrainerData_BuildParty` in pret/pokeplatinum).

import { RomError } from '../errors.js';
import { lcrngNext } from './lcrng.js';
import { FEMALE_TRAINER_CLASSES } from './trainerClassGender.js';

/** AI flag names by bit, from bit 0 up. */
export const AI_FLAG_NAMES = ['Basic','EvalAttack','Expert','SetupFirstTurn','Risky','PrioritizeExtremes','BatonPass','TagStrategy','CheckHP','Weather','Harassment'] as const;
export type AiFlagName = typeof AI_FLAG_NAMES[number];

/** 0 for none; otherwise 1 or 2, as in HGSS's `genderAbilityOverride` byte. */
export type TrainerOverride = 0 | 1 | 2;

/**
 * One trainer Pokémon. `item` is 0 when it holds none; `moves` leaves out empty slots.
 * - `genderOverride` (1 male, 2 female) and `abilityOverride` (1 first ability, 2 second) come from byte 1 of the entry.
 * - `abilitySlot` (0 first, 1 second) follows the ability override when there is one, otherwise `pid & 1`.
 * - `natureKnown` is false from the first entry with an override onwards: the hack generates those PIDs by a rule
 *   we do not know, so `pid` and `nature` then hold the plain-rule values, which the official docs contradict.
 */
export interface TrainerMon {
  species: number; form: number; level: number; iv: number; pid: number; nature: number; natureKnown: boolean;
  abilitySlot: 0 | 1; genderOverride: TrainerOverride; abilityOverride: TrainerOverride; item: number; moves: number[];
}

/** One trainer. `items` are the bag items, leaving out empty slots. */
export interface RomTrainer { index: number; trainerClass: number; battleType: number; aiMask: number; aiFlags: AiFlagName[]; items: number[]; party: TrainerMon[] }

const FORMAT_MOVES = 1;
const FORMAT_ITEM = 2;
// Every party entry has dv, overrides, level, species and ball seal (8 bytes); an item adds 2 and moves add 8.
const BASE_ENTRY_SIZE = 8;
const ITEM_SIZE = 2;
const MOVES_SIZE = 8;
// NARC files are padded to 4-byte alignment, so a party record can end in up to 3 spare bytes.
const MAX_PADDING = 3;
const SPECIES_MASK = 0x3ff;
const FORM_SHIFT = 10;
const MAX_IV = 31;
const MAX_DV = 255;
const NATURE_COUNT = 25;
const MALE_GENDER_MOD = 136;
const FEMALE_GENDER_MOD = 120;

/**
 * The PID the game gives a trainer Pokémon: seed the LCRNG with `dv + level + species + trainerIndex`,
 * step it `trainerClass` times, then `pid = (last output << 8) + 120` for a female class or `+ 136` otherwise.
 */
export function trainerPid(dv: number, level: number, species: number, trainerIndex: number, trainerClass: number, female: boolean): number {
  let seed = dv + level + species + trainerIndex;
  // With no steps (class 0) the game uses the seed itself.
  let rnd = seed;
  for (let step = 0; step < trainerClass; step++) {
    const next = lcrngNext(seed);
    seed = next.seed;
    rnd = next.rand;
  }
  return ((rnd << 8) + (female ? FEMALE_GENDER_MOD : MALE_GENDER_MOD)) >>> 0;
}

/**
 * Decodes trainer `index` from its header and party records. The header's format byte says whether
 * entries carry moves (bit 0) and an item (bit 1), which sets the entry size.
 */
export function decodeTrainer(index: number, header: Uint8Array, party: Uint8Array): RomTrainer {
  const head = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const format = head.getUint8(0);
  const trainerClass = head.getUint8(1);
  const partySize = head.getUint8(3);
  const aiMask = head.getUint32(12, true);
  const hasMoves = (format & FORMAT_MOVES) !== 0;
  const hasItem = (format & FORMAT_ITEM) !== 0;
  const entrySize = BASE_ENTRY_SIZE + (hasItem ? ITEM_SIZE : 0) + (hasMoves ? MOVES_SIZE : 0);

  const padding = party.length - partySize * entrySize;
  if (padding < 0 || padding > MAX_PADDING) {
    throw new RomError('BAD_FORMAT', `Trainer ${index} has ${party.length} party bytes, not ${partySize} entries of ${entrySize} bytes`);
  }

  const female = FEMALE_TRAINER_CLASSES.has(trainerClass);
  const view = new DataView(party.buffer, party.byteOffset, party.byteLength);
  // Byte 1 holds the overrides: gender in the low nibble, ability in the high nibble (HGSS's layout, which the hack
  // honours). The docs show that natures stop following `trainerPid` from the first overridden entry onwards.
  const overridesAt = (slot: number) => view.getUint8(slot * entrySize + 1);
  const firstOverride = Array.from({ length: partySize }, (_, slot) => overridesAt(slot)).findIndex((overrides) => overrides !== 0);

  const decodeMon = (slot: number): TrainerMon => {
    const offset = slot * entrySize;
    const dv = view.getUint8(offset);
    const level = view.getUint16(offset + 2, true);
    const speciesField = view.getUint16(offset + 4, true);
    const species = speciesField & SPECIES_MASK;
    const pid = trainerPid(dv, level, species, index, trainerClass, female);
    const overrides = overridesAt(slot);
    const genderOverride = overrideNibble(overrides & 0xf, index, slot);
    const abilityOverride = overrideNibble(overrides >> 4, index, slot);
    const secondAbility = abilityOverride === 0 ? (pid & 1) === 1 : abilityOverride === 2;
    const movesOffset = offset + 6 + (hasItem ? ITEM_SIZE : 0);
    return {
      species,
      form: speciesField >> FORM_SHIFT,
      level,
      iv: Math.floor((dv * MAX_IV) / MAX_DV),
      pid,
      nature: pid % NATURE_COUNT,
      natureKnown: firstOverride === -1 || slot < firstOverride,
      abilitySlot: secondAbility ? 1 : 0,
      genderOverride,
      abilityOverride,
      item: hasItem ? view.getUint16(offset + 6, true) : 0,
      moves: hasMoves ? readU16s(view, movesOffset, 4).filter((move) => move !== 0) : [],
    };
  };

  return {
    index,
    trainerClass,
    battleType: head.getUint8(16),
    aiMask,
    aiFlags: AI_FLAG_NAMES.filter((_, bit) => (aiMask >>> bit) & 1),
    items: readU16s(head, 4, 4).filter((item) => item !== 0),
    party: Array.from({ length: partySize }, (_, slot) => decodeMon(slot)),
  };
}

/** Checks one override nibble: 0 (none), 1 or 2. */
function overrideNibble(value: number, trainer: number, slot: number): TrainerOverride {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new RomError('BAD_FORMAT', `Trainer ${trainer} entry ${slot} has override value ${value}, not 0, 1 or 2`);
}

/** `count` little-endian u16 values starting at `offset`. */
function readU16s(view: DataView, offset: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => view.getUint16(offset + i * 2, true));
}
