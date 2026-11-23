// An outcome's EXP and damage rolls for the line builder (`LineOutcomeJson.exp` and `.rolls`, src/contracts/api.ts).
//
// EXP. The engine pays a knock-out's EXP inside the step and says so only in the outcome's log (src/engine/mod/exp.ts),
// for each paid Pokémon of the player's, in party order:
//   |-kaizoexp|IDENT|N              the EXP it got; `|[boosted]` after N for a traded Pokémon
//   |-kaizolevel|IDENT|LEVEL        each level it reached, in order
//   |-kaizolearn|IDENT|MOVE NAME    a move learned into a free slot
//   |-kaizooffer|IDENT|MOVE NAME    a move it could learn with four moves known (declined)
// IDENT is Showdown's (`p1a: NAME` active, `p1: NAME` on the bench), NAME the battle's name for the Pokémon, which the
// view has as `LineMonJson.ident` (unique on a side: engine/sets.ts `uniqueNames`). A step can pay one Pokémon twice (a
// second faint in the same step): the EXP adds up and its last level counts.
//
// Rolls. The outcome's chance labels of kind 'roll' (`ChanceLabel`), in order, each a damage roll the outcome fixed.
//
// EXP to the next level. `expToNext` reads the ROM's growth tables for a node's party (`LineMonJson.expToNext`); the
// real deps call it (lineDeps.ts).
//
// Neither goes into an outcome's `summary` or `signature`: a signature must be the same over another team.

import type { LineExpGainJson, LineRollJson } from '../contracts/api.js';
import type { ChanceLabel } from '../contracts/engine.js';

/** The player's party before the step, in team order (a `LineMonJson[]` fits): each one's battle name, page name and level. */
export interface ExpSeed { party: readonly { ident: string; name: string; level: number }[] }

const IDENT = /^(p[12])[a-z]?: (.+)$/;
const EXP_LINES: ReadonlySet<string> = new Set(['-kaizoexp', '-kaizolevel', '-kaizolearn', '-kaizooffer']);

/**
 * Each of the player's Pokémon the log's EXP lines pay, in party order (see the top of the file). Lines for the trainer's side
 * or for a name the party lacks are skipped; a level or move line before any EXP line of its Pokémon is skipped too
 * (the engine always pays first).
 */
export function expGains(log: readonly string[], seed: ExpSeed): LineExpGainJson[] {
  const gains = new Map<number, LineExpGainJson>();
  for (const line of log) {
    const [, kind, ident, value, ...rest] = line.split('|');
    if (kind === undefined || !EXP_LINES.has(kind) || value === undefined) continue;
    const who = IDENT.exec(ident ?? '');
    if (who === null || who[1] !== 'p1') continue;
    const index = seed.party.findIndex((m) => m.ident === who[2]);
    const mon = seed.party[index];
    if (mon === undefined) continue;
    let gain = gains.get(index);
    if (kind === '-kaizoexp') {
      const gained = Number(value);
      if (!Number.isFinite(gained)) continue;
      gain ??= { index, name: mon.name, gained: 0, boosted: false, fromLevel: mon.level, toLevel: mon.level, learned: [], offered: [] };
      gain.gained += gained;
      gain.boosted ||= rest.includes('[boosted]');
      gains.set(index, gain);
      continue;
    }
    if (gain === undefined) continue;
    if (kind === '-kaizolevel') {
      const level = Number(value);
      if (Number.isInteger(level)) gain.toLevel = level;
    } else if (kind === '-kaizolearn') {
      gain.learned.push(value);
    } else {
      gain.offered.push(value);
    }
  }
  return [...gains.values()].sort((a, b) => a.index - b.index);
}

/**
 * The EXP still to go from `level` to the next with `exp` in all, on the species' own growth table; null at level 100,
 * for a species or a table the ROM lacks. Never negative. The species' own row, never a form's, as the engine reads it
 * (src/engine/dex.ts `growthTableOf`).
 */
export function expToNext(
  rom: { species: { readonly [id: number]: { growthRate: number } | undefined }; growth: readonly (readonly number[])[] },
  species: number, level: number, exp: number,
): number | null {
  if (level >= 100) return null;
  const rate = rom.species[species]?.growthRate;
  const need = rate === undefined ? undefined : rom.growth[rate]?.[level + 1];
  return need === undefined ? null : Math.max(0, need - exp);
}

/**
 * The damage rolls of an outcome's labels, in order: each roll label with a side; `damage` is its number, null for the
 * '≥hp' option (at least the target's HP left); `move` the move's name by `moveName` of the label's Showdown ID.
 */
export function rollsOf(labels: readonly ChanceLabel[], moveName: (showdownId: string) => string): LineRollJson[] {
  return labels.flatMap((label) => (label.kind !== 'roll' || label.side === null ? [] : [{
    side: label.side, move: moveName(label.source), damage: label.outcome === '≥hp' ? null : Number(label.outcome), rollValue: label.rollValue ?? null,
  }]));
}
