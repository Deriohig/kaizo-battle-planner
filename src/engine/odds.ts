// The cartridge's odds. Every battle chance is one 16-bit draw: `BattleSystem_RandNext` returns a u16
// (pokeplatinum src/battle/battle_system.c:1308-1312), which a chance site reduces modulo its size, as the secondary
// effect check does (`BattleSystem_RandNext(battleSys) % 100 < effectChance`, src/battle/battle_lib.c:1560). So an
// outcome's weight is the number of the 65,536 draws that give it, not 1/n: a 10% chance is 6560/65536.

/** The number of 16-bit draws. */
export const U16 = 65536n;

/** The size of a modulo chance site: a whole number from 1 to 65,536. */
function checkSize(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 65536) throw new RangeError(`A chance site's size is a whole number from 1 to 65536, not ${n}`);
}

/** For each remainder i in 0..n−1, the number of draws r in 0..65535 with r % n == i. */
export function residueWeights(n: number): bigint[] {
  checkSize(n);
  const size = BigInt(n);
  const [base, extra] = [U16 / size, U16 % size];
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
}

/** The number of draws r in 0..65535 with r % n < k: the weight of a "draw % n < k" check passing. */
export function belowWeight(n: number, k: number): bigint {
  checkSize(n);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`A threshold under ${n} is a whole number from 0 to ${n}, not ${k}`);
  const size = BigInt(n);
  const [base, extra] = [U16 / size, U16 % size];
  const below = BigInt(k);
  return base * below + (below < extra ? below : extra);
}
