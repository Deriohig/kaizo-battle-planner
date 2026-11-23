// The Gen 4 linear congruential RNG (LCRNG): trainer Pokémon PIDs and the PK4 encryption both use it.

const MULTIPLIER = 0x41c64e6d;
const INCREMENT = 0x6073;

/** One LCRNG step: the new 32-bit seed and its 16-bit output, `seed >>> 16`. */
export interface LcrngStep { seed: number; rand: number }

/** Advances the LCRNG one step. `Math.imul` keeps the 32-bit product exact, which a plain `*` would not. */
export function lcrngNext(seed: number): LcrngStep {
  const next = (Math.imul(seed, MULTIPLIER) + INCREMENT) >>> 0;
  return { seed: next, rand: next >>> 16 };
}
