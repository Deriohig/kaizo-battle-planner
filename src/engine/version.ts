// What the engine's id names: the Showdown it runs and its own revision.

/**
 * The engine's revision. Every change to how battles run bumps it, so a proof names the engine it ran on.
 * 34: each of the player's Pokémon's EXP state (`m.exp` and `m.expRate`) and the EXP participation mask
 * (`formatData.kaizoExpMask`).
 * 35: the payout of EXP at the cartridge's points with the level-ups it brings (mod/exp.ts; `formatData.kaizoExpPending`
 * at a U-turn knock-out's mid-turn state, the `-kaizoexp`, `-kaizolevel`, `-kaizolearn` and `-kaizooffer` lines). All of
 * it is in every battle's JSON and key. The carry is in 35 too: `carryOut` gives `exp` and `moves`, and `createBattle`
 * starts a Pokémon at the level its carried EXP gives, with the carried moves.
 * 36: Micle Berry checked where the cartridge checks it, its boost kept until used (mod/items.ts, mod/conditions.ts), no
 * `MICLE_EXP_NOTE`; and the other pinch berries (Liechi, Salac, Petaya, Lansat, Starf) checked at the same points with
 * their own conditions, Starf Berry's stat an `itemProc` chance (mod/items.ts).
 */
export const ENGINE_REVISION = '36';

/** The pokemon-showdown version the engine runs: package.json pins it exactly. */
export const SHOWDOWN_VERSION = '0.11.11';
