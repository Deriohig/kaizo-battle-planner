// Decodes the party status word (party extra data, offset 0): bits 0–2 sleep turns left, bit 3 poison, bit 4 burn,
// bit 5 freeze, bit 6 paralysis, bit 7 badly poisoned.

/** A Pokémon's status at the start of a battle. `turns` is the sleep counter as stored. */
export type StartStatus =
  | { kind: 'none' }
  | { kind: 'sleep'; turns: number }
  | { kind: 'poison' }
  | { kind: 'toxic' }
  | { kind: 'burn' }
  | { kind: 'freeze' }
  | { kind: 'paralysis' };

const SLEEP_MASK = 0x07;
const POISON = 0x08;
const BURN = 0x10;
const FREEZE = 0x20;
const PARALYSIS = 0x40;
const TOXIC = 0x80;

/** Decodes a status word. Toxic wins over poison; sleep counts only when no other status bit is set. */
export function decodeStatus(word: number): StartStatus {
  if (word & TOXIC) return { kind: 'toxic' };
  if (word & POISON) return { kind: 'poison' };
  if (word & BURN) return { kind: 'burn' };
  if (word & FREEZE) return { kind: 'freeze' };
  if (word & PARALYSIS) return { kind: 'paralysis' };
  const turns = word & SLEEP_MASK;
  return turns > 0 ? { kind: 'sleep', turns } : { kind: 'none' };
}
