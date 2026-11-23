// The `platkaizo` mod's ability changes from the hack. The docs' Ability Changes tab lists which two
// abilities each species has (src/docs/abilityChanges.ts): the ROM's Personal data holds the same, and the engine reads the
// ROM's (dex.ts `personalPatch`), so no ability's behaviour is changed by that tab. The behaviour changes the engine makes
// to Showdown's Gen 4 abilities are the cartridge's own, in mod/procs.ts (the chance abilities, Wonder Guard, Bad Dreams),
// mod/scripts.ts and mod/conditions.ts, and these, which are the docs' text over Showdown's:
//
// - Oblivious (Showdown's Gen 5 `onTryHit`, which Gen 4 inherits, makes its holder immune to Captivate by move ID) no longer
//   blocks it: the hack's Captivate is "Sharply lowers SpAtk (Status)", with no exception, and the docs win.
//   It still blocks infatuation (`onImmunity('attract')` and `onUpdate` stay). Moved here from mod/procs.ts.

/** The mod's `Abilities` entries for the hack's changes, merged over Showdown's Gen 4 ones by ID (dex.ts). */
export const KAIZO_ABILITY_CHANGES: Record<string, Record<string, unknown>> = {
  oblivious: { onTryHit: undefined },
};
