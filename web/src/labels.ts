// Words for the page: statuses ("Asleep (2 turns)", "Burned"), box Pokémon ("Blaze (Monferno) Lv 16"), why one cannot
// fight ("In the graveyard"), trainers and their tags ("Galactic Venus ♀"), a list of names ("Blaze and Bench"), and who
// moves first ("Miltank moves first · Speed 65 vs 52").

import type { BoxMonJson } from '../../src/server/apiTypes.js';   // `.js`: draft.ts imports this file, and the server's type check reads draft.ts

/** "A", "A and B", "A, B and C"; none is ''. */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

const NAMED_STATUSES: Record<string, string> = {
  healthy: 'Healthy', burn: 'Burned', poison: 'Poisoned', toxic: 'Badly poisoned', freeze: 'Frozen', paralysis: 'Paralysed',
};

/** A status string (`sleep:<n>`, `sleepUndrawn:<attempts>`, `burn`, `poison`, `toxic`, `freeze`, `paralysis`, `healthy`) in words; null is "Healthy". */
export function statusLabel(s: string | null): string {
  if (s === null) return 'Healthy';
  const undrawn = /^sleepUndrawn:(\d+)$/.exec(s);
  if (undrawn) {
    const turns = Number(undrawn[1]);
    return `Asleep (${turns} ${turns === 1 ? 'turn' : 'turns'} so far)`;
  }
  const sleep = /^sleep:(\d+)$/.exec(s);
  if (sleep) {
    const turns = Number(sleep[1]);
    return `Asleep (${turns} ${turns === 1 ? 'turn' : 'turns'})`;
  }
  return NAMED_STATUSES[s] ?? s;
}

/**
 * "<nickname> (<species>)", or the species alone when there is no nickname or it is the species name in any case (the
 * game's default nickname is in capitals).
 */
export function monName(m: Pick<BoxMonJson, 'nickname' | 'species'>): string {
  const plain = m.nickname === '' || m.nickname.toLowerCase() === m.species.toLowerCase();
  return plain ? m.species : `${m.nickname} (${m.species})`;
}

/** `monName` with the level: "Blaze (Monferno) Lv 16", "Monferno Lv 15". */
export function monLabel(m: BoxMonJson): string {
  return `${monName(m)} Lv ${m.level}`;
}

/** Who moves first, as the server says it for a turn (`player`, `enemy`, `tie`) or a Matchups pair (also `depends`). */
export type SpeedOrder = 'player' | 'enemy' | 'tie' | 'depends';

/** A Speed in a speed-order line, with whose it is. */
export interface SideSpeed { side: 'player' | 'enemy'; speed: number }

/**
 * Who moves first, by name, and the two Speeds in the order said: one wording for the plan, the start rows and Matchups.
 * `player`/`enemy`: "<Name> moves first", the first mover's Speed first. `tie` at one
 * Speed: "Speed tie at 21: either moves first", no Speeds after it; a tie over two Speeds (a pair's worst cases) is
 * "Speed tie", his first. `depends`: "Either may go first", his first.
 */
export function speedOrder(first: SpeedOrder, mine: string, theirs: string, player: number, enemy: number): { words: string; speeds: readonly [SideSpeed, SideSpeed] | null } {
  const his: SideSpeed = { side: 'player', speed: player };
  const its: SideSpeed = { side: 'enemy', speed: enemy };
  if (first === 'player') return { words: `${mine} moves first`, speeds: [his, its] };
  if (first === 'enemy') return { words: `${theirs} moves first`, speeds: [its, his] };
  if (first === 'tie' && player === enemy) return { words: `Speed tie at ${player}: either moves first`, speeds: null };
  return { words: first === 'tie' ? 'Speed tie' : 'Either may go first', speeds: [his, its] };
}

/** `speedOrder` as one line: "Miltank moves first · Speed 65 vs 52". */
export function speedOrderText(first: SpeedOrder, mine: string, theirs: string, player: number, enemy: number): string {
  const { words, speeds } = speedOrder(first, mine, theirs, player, enemy);
  return speeds === null ? words : `${words} · Speed ${speeds[0].speed} vs ${speeds[1].speed}`;
}

const REASON_TEXT: Record<string, string> = {
  dead: 'In the graveyard', fainted: 'Fainted', egg: 'Egg', 'over cap': 'Over the level cap', 'bad checksum': 'Bad checksum',
};

/**
 * Why a box Pokémon cannot fight (`BoxMonJson.ineligibleReasons`), in words: "In the graveyard", "Fainted", "Egg",
 * "Over the level cap", "Bad checksum". The unknown-ID reasons keep the server's text, capitalised ("Unknown move 999").
 */
export function reasonLabel(reason: string): string {
  return REASON_TEXT[reason] ?? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
}

/**
 * The classes the docs mark female, by gluing "f" or "F" to the class before a space or straight before the name
 * ("Galacticf Venus", "GalacticfTerra", "SwimmerF Mary", "CyclistFMegan", "School KidfChristine"). Only these: a name
 * that merely has a word ending in "f" ("Chef Bob") is not marked.
 */
const FEMALE_CLASSES = 'Galactic|Cyclist|Psychic|Tuber|Swimmer|Pkmn Breeder|School Kid';
/** A marked class at the start of a trainer's name. */
const FEMALE_CLASS = new RegExp(`^(${FEMALE_CLASSES})[fF](?=\\s|[A-Z])`);
/** A marked class starting a word inside a tag ("MULTI BATTLE with GalacticfDione"). */
const FEMALE_CLASS_IN_TAG = new RegExp(`\\b(?:${FEMALE_CLASSES})[fF](?=\\s|[A-Z])`);

/**
 * A trainer's name as the page shows it: a class the docs mark female reads plain, with ♀ after the name ("Galacticf
 * Venus" and "GalacticfTerra" are "Galactic Venus ♀" and "Galactic Terra ♀"); any other name is as the data has it.
 */
export function trainerName(name: string): string {
  if (!FEMALE_CLASS.test(name)) return name;
  return `${name.replace(FEMALE_CLASS, '$1 ').replace(/\s+/g, ' ').trim()} ♀`;
}

/** A word in capitals: two or more letters and no lower-case letter ("RAIN", "B2B"; not "A", "Top", "5"). */
const isCapitalsWord = (w: string): boolean => /[A-Za-z].*[A-Za-z]/.test(w) && !/[a-z]/.test(w);

/** A name after "with" as the page shows it: all capitals reads title-cased, then as `trainerName` reads it. */
function tagName(name: string): string {
  const words = name.trim().split(/\s+/);
  const cased = words.every(isCapitalsWord)
    ? words.map((w) => `${w.charAt(0)}${w.slice(1).toLowerCase()}`).join(' ')
    : words.join(' ');
  return trainerName(cased);
}

/** Tags with a fixed reading: [pattern for the whole tag, its words]. */
const FIXED_TAGS: [RegExp, string][] = [
  [/^gauntlet start$/i, 'First of a no-heal run'],
  [/^gauntlet end$/i, 'Last of a no-heal run'],
  [/^gauntlet$/i, 'In a no-heal run'],
];

/** Tags that name a partner after "with": [pattern with the name in group 1, the words before the name]. */
const WITH_TAGS: [RegExp, string][] = [
  [/^optional gauntlet with\s+(.+)$/i, 'Optional no-heal run with'],
  [/^mu(?:lti|tli) battle with\s+(.+)$/i, 'Multi battle with'],
  [/^tag battle with\s+(.+)$/i, 'Tag battle with'],
  [/^b2b with\s+(.+)$/i, 'Back to back with'],
];

/**
 * A trainer's tag as the page shows it, in sentence case. The hack's known forms read in fixed words ("GAUNTLET START" is
 * "First of a no-heal run", "OPTIONAL GAUNTLET with Mira" is "Optional no-heal run with Mira", "MULTI BATTLE with
 * GalacticfDione" is "Multi battle with Galactic Dione ♀", "B2B With ..." is "Back to back with ..."; the typo "MUTLI"
 * reads as multi); a name after "with" in capitals is title-cased and read as `trainerName` reads it. In any other tag
 * each word in capitals is lowered, the rest kept, and the first letter capitalised ("OPTIONAL HAIL" is "Optional hail",
 * "OPTIONAL Top Trainer" is "Optional Top Trainer"); a tag with no lower-case letter at all is lowered whole, single
 * letters too ("GYM TRAINERS ARE A GAUNTLET" is "Gym trainers are a no-heal run"); any word "gauntlet" left reads
 * "no-heal run"; a marked trainer named in it reads as `trainerName` reads it.
 */
export function trainerTag(tag: string): string {
  const t = tag.trim().replace(/\s+/g, ' ');
  for (const [pattern, words] of FIXED_TAGS) if (pattern.test(t)) return words;
  for (const [pattern, words] of WITH_TAGS) {
    const m = pattern.exec(t);
    if (m) return `${words} ${tagName(m[1]!)}`;
  }
  const at = t.search(FEMALE_CLASS_IN_TAG);
  const marked = at < 0 ? t : `${t.slice(0, at)}${trainerName(t.slice(at))}`;
  const lowered = /[a-z]/.test(marked)
    ? marked.split(' ').map((w) => (isCapitalsWord(w) ? w.toLowerCase() : w)).join(' ')
    : marked.toLowerCase();
  const plain = lowered.replace(/\bgauntlets?\b/gi, 'no-heal run');
  return `${plain.charAt(0).toUpperCase()}${plain.slice(1)}`;
}
