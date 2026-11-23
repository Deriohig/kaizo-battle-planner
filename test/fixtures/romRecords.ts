// Builds single ROM records for tests, using the layouts in the plan's verified facts.

const PERSONAL_SIZE = 44;
const MOVE_SIZE = 16;

/** Bytes from space-separated hex pairs, such as `'a5 03 ff ff'`. */
export function hex(text: string): Uint8Array {
  return Uint8Array.from(text.trim().split(/\s+/), (pair) => parseInt(pair, 16));
}

export interface PersonalFields {
  /** Base stats in ROM order: HP, Atk, Def, Spe, SpA, SpD. */
  stats?: [number, number, number, number, number, number];
  types?: [number, number];
  /** Base EXP yield, byte 0x09. */
  baseExp?: number;
  /** EV yield, the u16 at byte 0x0A (2 bits per stat). */
  evYield?: number;
  genderRatio?: number;
  growth?: number;
  /** Base friendship, byte 0x12. */
  friendship?: number;
  abilities?: [number, number];
}

/** A 44-byte personal (species) record. Fields left out are 0. */
export function personalBytes(fields: PersonalFields): Uint8Array {
  const rec = new Uint8Array(PERSONAL_SIZE);
  rec.set(fields.stats ?? [0, 0, 0, 0, 0, 0], 0);
  rec.set(fields.types ?? [0, 0], 6);
  rec[9] = fields.baseExp ?? 0;
  new DataView(rec.buffer).setUint16(10, fields.evYield ?? 0, true);
  rec[16] = fields.genderRatio ?? 0;
  rec[18] = fields.friendship ?? 0;
  rec[19] = fields.growth ?? 0;
  rec.set(fields.abilities ?? [0, 0], 22);
  return rec;
}

export interface MoveFields {
  effect?: number;
  /** 0 physical, 1 special, 2 status. */
  cat?: number;
  power?: number;
  type?: number;
  acc?: number;
  pp?: number;
  chance?: number;
  target?: number;
  prio?: number;
  flags?: number;
}

/** A 16-byte move record. Fields left out are 0. */
export function moveBytes(fields: MoveFields): Uint8Array {
  const rec = new Uint8Array(MOVE_SIZE);
  const view = new DataView(rec.buffer);
  view.setUint16(0, fields.effect ?? 0, true);
  view.setUint8(2, fields.cat ?? 0);
  view.setUint8(3, fields.power ?? 0);
  view.setUint8(4, fields.type ?? 0);
  view.setUint8(5, fields.acc ?? 0);
  view.setUint8(6, fields.pp ?? 0);
  view.setUint8(7, fields.chance ?? 0);
  view.setUint16(8, fields.target ?? 0, true);
  view.setInt8(10, fields.prio ?? 0);
  view.setUint8(11, fields.flags ?? 0);
  return rec;
}
