// Shared setup for the decision, switch, item, damage and speed tests: frozen views, error matchers and the switch views.

import { expect } from 'vitest';
import { shouldSwitch, type SwitchOutcome } from '../../../src/ai/choose/switch.js';
import { ABILITY_NATURAL_CURE, BATTLER_NONE, MON_CONDITION_SLEEP_1 } from '../../../src/ai/constants.js';
import { enumerate, type Pick } from '../../../src/ai/enumerate.js';
import type { Latents } from '../../../src/ai/lib/speed.js';
import type { Rational } from '../../../src/contracts/engine.js';
import { AI_BATTLER, type AiDeps, type AiView, PLAYER_BATTLER } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';

const M = FX.move;
const NONE = BATTLER_NONE;

/** `value`, frozen all the way down: a helper that writes to it throws. */
export function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Matches an AiError with this `code`. */
export const code = (c: string) => expect.objectContaining({ code: c });

/** For paths with no random draw: any pick fails the test. */
export const noPick: Pick = () => {
  throw new Error('unexpected pick');
};

/** A run with nothing fixed yet. */
export const latents = (): Latents => ({ rolls: [null, null, null, null], quickClaw: [null, null, null, null] });

/** The fixture's turn-1 view after Luxray (battler 0) hit Garchomp (battler 1) with `move`. */
export const hitBy = (move: number): AiView =>
  fixtureView({ moveHit: [0, move, 0, 0], moveHitBattler: [NONE, PLAYER_BATTLER, NONE, NONE] });

/** Garchomp's moves without Earthquake, its one move super-effective on Luxray: Tackle takes its slot. */
export const NO_SUPER_EFFECTIVE = [M.DRAGON_CLAW, M.TACKLE, M.CRUNCH, M.FIRE_FANG];

/**
 * Earthquake hit Garchomp, which has no super-effective move. Gyarados (party 1, Flying) is immune and has Earthquake
 * and Magnitude, each switching on `RandNext() % 2 == 0` (trainer_ai.c:3975, 3796): switch to 1 at 3/4, else stay.
 */
export function immuneSwitchView(): AiView {
  const v = hitBy(M.EARTHQUAKE);
  v.mons[AI_BATTLER].moves = [...NO_SUPER_EFFECTIVE];
  v.parties[1][1]!.moves = [M.WATERFALL, M.EARTHQUAKE, M.ICE_FANG, M.MAGNITUDE];
  return v;
}

/** Garchomp asleep with Natural Cure: three coins send it to the post-KO logic (7/8), else it stays. */
export function naturalCureView(): AiView {
  const v = fixtureView();
  v.mons[AI_BATTLER].ability = ABILITY_NATURAL_CURE;
  v.mons[AI_BATTLER].status = MON_CONDITION_SLEEP_1;
  return v;
}

/** Every outcome of shouldSwitch on `v` (frozen), as `key → probability` in first-seen order. */
export function switchOdds(v: AiView, d: AiDeps = fixtureDeps()): Record<string, Rational> {
  const key = (o: SwitchOutcome) => (o.kind === 'switch' ? `switch ${o.partyIndex}` : o.kind);
  const view = frozen(v);
  return Object.fromEntries(enumerate((pick) => shouldSwitch(view, d, pick), key).map((leaf) => [key(leaf.value), leaf.probability]));
}
