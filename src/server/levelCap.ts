// The level cap from the badge count.

/**
 * The cap for each badge count, 0 to 8. Where a badge count cannot tell whether the rival fight after it is done, the
 * rival's lower cap is the safe one: 3 badges give Barry's 42, not Maylene's 47, and 5 give Barry's 63, not Byron's 65.
 * `levelCapOverride` covers the second fight.
 */
export const LEVEL_CAPS_BY_BADGES: readonly number[] = [16, 28, 38, 42, 54, 63, 74, 84, 100];

/** `override` when set, else the cap for `badges` (counts past 8 give the last cap). */
export function levelCapFor(badges: number, override: number | null): number {
  if (override !== null) return override;
  const index = Math.min(Math.max(Math.floor(badges), 0), LEVEL_CAPS_BY_BADGES.length - 1);
  return LEVEL_CAPS_BY_BADGES[index]!;
}
