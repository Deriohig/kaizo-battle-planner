// Name normalisation, so the docs tabs' different spellings of a name compare equal ("Mud Slap" and "Mud-Slap").

/**
 * A name reduced to lower-case a–z and 0–9: accents are stripped and every other character dropped, except that ♂ and
 * ♀ become "m" and "f". So "Nidoran♀" and the team tabs' "NidoranF" are equal, and both differ from "Nidoran♂".
 */
export function normaliseName(s: string): string {
  // NFD splits "é" into "e" and a combining accent, which the last step drops with the punctuation.
  return s.replaceAll('♂', 'm').replaceAll('♀', 'f').normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '');
}
