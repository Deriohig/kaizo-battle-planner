// Where the run is (`RunJson`, `BoxJson.run`): the split the save's badge count puts it in, in the docs' tab order, and
// that split's fights with the ones the save has beaten.

import { trainerId } from '../battle/resolveTrainer.js';
import type { RunJson } from '../contracts/api.js';
import type { LocalData } from '../data/load.js';
import type { DocTrainer } from '../docs/teams.js';
import { matchTrainers } from '../names/matchTrainers.js';
import type { RomTrainer } from '../rom/trainers.js';

/** The split a run with 8 badges or more is in: the ninth split, the Galactic split in the docs. */
const LAST_BADGE_SPLIT = 8;

/** The battle-type bit for a double battle, as the catalog reads it (src/battle/resolveTrainer.ts `BATTLE_TYPE_DOUBLES`). */
const BATTLE_TYPE_DOUBLES = 2;

/** Where the run is by its badges alone: `RunJson` without the split's fights (`runFights`). */
export type RunPlace = Omit<RunJson, 'fights' | 'next'>;

/** Every split the docs' trainers name, each once, in first-seen order (the docs list trainers in tab order). */
export function splitsOf(docs: { trainers: readonly { split: string }[] }): string[] {
  return [...new Set(docs.trainers.map((trainer) => trainer.split))];
}

/**
 * The run at `badges` badges over `splits` (game order): N badges are split N, up to split 8 (the Galactic split) and
 * never past the last split; with no splits, split '' at index 0. From 8 badges on, every split after the ninth (the
 * Elite Four) is also possible, as nothing in the save tells the two apart.
 */
export function runOf(badges: number, splits: readonly string[]): RunPlace {
  const splitIndex = Math.max(0, Math.min(Math.max(Math.floor(badges), 0), LAST_BADGE_SPLIT, splits.length - 1));
  return {
    split: splits[splitIndex] ?? '',
    splitIndex,
    splits: [...splits],
    alsoPossible: badges >= LAST_BADGE_SPLIT ? splits.slice(LAST_BADGE_SPLIT + 1) : [],
  };
}

/**
 * The fights of `split` and the next one, as `RunJson` describes them, for the ROM trainer indexes whose
 * trainer-defeated flag the save has set (`defeated`, `SaveData.defeatedTrainers`). The fights are the split's docs
 * trainers in docs order, player partners left out, each with its catalog ID (`trainerId`); a docs trainer's ROM
 * trainers are the ones `matchTrainers` pairs it with, as the catalog takes them.
 *
 * The rule for a docs trainer with several ROM trainers (`matchTrainers`' shared copies, such as the rival's for the
 * other player gender, which the catalog keeps as variants): it is defeated when any of them is, since the game sets the
 * flag of the copy the player fought. Rematches are ROM-only (`matchTrainers` never pairs them), so their flags never
 * count. A docs trainer with no ROM trainer is never defeated and never `next`: it has no flag, and the catalog, so the
 * page, leaves it out. A single battle is one whose ROM trainers have no double-battle bit, as the catalog decides
 * `battleType`.
 *
 * `next` is the first single battle with a ROM trainer after the last fight whose flag is set (from the start when none
 * is), unbeaten since it comes after it; null when there is none. Not simply the first unbeaten one: a battle a script
 * starts (a Gym Leader's, the rival's, some story fights') never sets its flag, and the docs list fights the player may
 * pass by, so an unbeaten fight before a beaten one was most likely won or skipped.
 */
export function runFights(split: string, data: Pick<LocalData, 'rom' | 'docs' | 'names'>, defeated: ReadonlySet<number>): Pick<RunJson, 'fights' | 'next'> {
  const all = data.docs.trainers;
  const byIndex = new Map(data.rom.trainers.map((trainer) => [trainer.index, trainer]));
  const romOf = new Map<DocTrainer, RomTrainer[]>();
  for (const match of matchTrainers(data.rom.trainers, all, data.names).matched) {
    const trainer = byIndex.get(match.romIndex);
    if (trainer !== undefined) romOf.set(match.doc, [...(romOf.get(match.doc) ?? []), trainer]);
  }
  const fights: RunJson['fights'] = [];
  const singles: boolean[] = [];
  for (const doc of all) {
    if (doc.split !== split || doc.tags.playerPartner === true) continue;
    const rom = romOf.get(doc) ?? [];
    fights.push({ id: trainerId(doc, all), defeated: rom.some((trainer) => defeated.has(trainer.index)) });
    singles.push(rom.length > 0 && rom.every((trainer) => (trainer.battleType & BATTLE_TYPE_DOUBLES) === 0));
  }
  const lastBeaten = fights.findLastIndex((fight) => fight.defeated);
  const next = fights.find((fight, k) => k > lastBeaten && singles[k] === true && !fight.defeated);
  return { fights, next: next?.id ?? null };
}
