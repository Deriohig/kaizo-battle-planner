// The line page's pure helpers that need no React: the kept-plan types `readSaved` reads from the browser's `localStorage`
// (a start, its paths, the save they were built on), choice names and keys, odds, and the damage, KO and turn-order wording.
// Every read is wrapped: the storage can be missing or refuse (a private window), and the page then works without it.

import type { Choice } from '../../src/contracts/engine';
import type {
  BoxJson, DraftMonJson, LineDamageJson, LineMonJson, LineMoveDamageJson, LineNodeJson, LineOrderJson,
  LineRationalJson, MonRef,
} from '../../src/server/apiTypes';
import { damageRange, formatChance, formatOdds, oneDecimal, percentRange } from './format';

type Phase = LineNodeJson['phase'];

/**
 * What a line starts from: the fight, the world, the team in order (lead first), and the draft: one entry per team member
 * in the team's order, each only the fields that differ from the save (draft.ts), its HP among them: each Pokémon starts
 * on the HP the team shows. Every start sends it as it is, so a running line keeps the edits it started with
 * whatever the team column holds since. `keys` is each team member's Pokémon key (`BoxMonJson.key`, its PID) in the save
 * the line was started on, in the team's order: a ref names a slot of one save only, so a tree kept on another save finds
 * its Pokémon by these. It is never sent; a start without it keeps its refs as they are.
 *
 * `carried` is on a carried tree's start only: the next fight after a win, its team as the fight before left it.
 * Such a start's `draft` is empty and its `team` is the next fight's, lead first; what it starts from is `carried`, the whole
 * recipe (the server carries the team itself: nothing of it is sent but the won line and node).
 */
export interface LineStart { trainerId: string; variant: number; world: number; team: MonRef[]; draft: DraftMonJson[]; keys?: string[]; carried?: CarriedFrom }

/**
 * Where a carried start's team comes from: the fight before, the path in it to the won node, the server line and node it was
 * last seen at, and whether it was healed. `line` is '' once the start was moved onto another save: the line it
 * names was played on the old one, so the fight before is replayed rather than asked of it.
 */
export interface CarriedFrom { start: LineStart; path: PathStep[]; line: string; node: string; heal: boolean }

/**
 * One step of a path as it is kept: the player's choice (null where the AI alone acts), the outcome followed by its id, and whether
 * the page took it by itself.
 */
export interface PathStep { choice: Choice | null; outcome: string; auto: boolean }

/** The save a tree was built on: its file and when it was saved (`BoxJson`'s `savePath` and `savedAt`). */
export interface SaveId { savePath: string; savedAt: string }

/**
 * A tree as it is kept: the save it was built on (null when that is not known), its start, the path the page shows, and the
 * paths to its other leaves, newest first (24 at most, the oldest dropped). A named one is a `SavedLine`.
 */
export interface LineRecord { save: SaveId | null; start: LineStart; path: PathStep[]; others: PathStep[][] }
export interface SavedLine extends LineRecord { name: string }

/** The save `box` is. */
export const saveOf = (box: Pick<BoxJson, 'savePath' | 'savedAt'>): SaveId => ({ savePath: box.savePath, savedAt: box.savedAt });

/** Whether a kept tree's save (`kept`, null when not known) is `save`. */
export const sameSave = (kept: SaveId | null, save: SaveId): boolean => kept !== null && kept.savePath === save.savePath && kept.savedAt === save.savedAt;

const AI_ONLY: readonly Phase[] = ['enemyReplacement', 'enemyMidTurnSwitch'];
export const aiOnly = (phase: Phase) => AI_ONLY.includes(phase);

/** The key a choice has in a map; '' where there is none. */
export function choiceKey(choice: Choice | null): string {
  if (choice === null) return '';
  return choice.kind === 'move' ? `m${choice.slot}` : choice.kind === 'switch' ? `s${choice.index}` : `i${choice.item}`;
}

/**
 * A choice as the step names it, on its button: a move without the labeler's "Use " ("Scratch"),
 * anything else as labelled ("Switch to Bench", and "Use Potion", where "Use" is what tells an item from a move).
 */
export function choiceName(choice: Choice, label: string): string {
  return choice.kind === 'move' ? label.replace(/^Use /, '') : label;
}

export const odds = (r: LineRationalJson) => formatOdds(`${r.num}/${r.den}`);

// ---- What is kept in the browser ----------------------------------------------------------------------------------

const savedKey = (trainerId: string, variant: number) => `pkp.tree.saved.${trainerId}.${variant}`;

function read(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function isChoice(value: unknown): value is Choice {
  return isRecord(value) && ((value.kind === 'move' && whole(value.slot)) || (value.kind === 'switch' && whole(value.index)));
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Each step an object of a choice (null or a move or switch), an outcome id and an auto flag: what a path is. A step with a level-up (the old Line tab's `up`) is not one. */
const isPath = (value: unknown): value is PathStep[] => Array.isArray(value) && value.every((step) => isRecord(step) && typeof step.outcome === 'string'
  && typeof step.auto === 'boolean' && (step.choice === null || isChoice(step.choice)) && !Object.hasOwn(step, 'up'));

/**
 * A kept start, or null when it is not one. It needs a string `trainerId`, whole `variant` and `world`, a `team` of strings and
 * a `draft` of objects, each with a string `ref` in the team; its `keys` are kept when they are strings, one per team member,
 * and any other key of it (an old `hp`) is dropped. A `carried` key makes it a start only when that is a carried-from
 * (`toCarried`); a start without the key reads as it always did.
 */
function toStart(s: unknown): LineStart | null {
  if (!isRecord(s)) return null;
  const team = s.team;
  const startOk = typeof s.trainerId === 'string' && whole(s.variant) && whole(s.world) && strings(team)
    && Array.isArray(s.draft) && s.draft.every((entry) => isRecord(entry) && typeof entry.ref === 'string' && team.includes(entry.ref));
  if (!startOk) return null;
  let carried: { carried?: CarriedFrom } = {};
  if (Object.hasOwn(s, 'carried')) {
    const from = toCarried(s.carried);
    if (from === null) return null;
    carried = { carried: from };
  }
  const refs = team as MonRef[];
  const keys = strings(s.keys) && s.keys.length === refs.length ? { keys: s.keys } : {};
  return { trainerId: s.trainerId as string, variant: s.variant as number, world: s.world as number, team: refs, draft: s.draft as DraftMonJson[], ...keys, ...carried };
}

/**
 * A kept carried-from, or null: an object whose `start` is a start by `toStart`'s rules (itself carried or not, however
 * deep), whose `path` is a path (`isPath`), whose `line` and `node` are strings and whose `heal` is a boolean.
 */
function toCarried(value: unknown): CarriedFrom | null {
  if (!isRecord(value) || !isPath(value.path) || typeof value.line !== 'string' || typeof value.node !== 'string' || typeof value.heal !== 'boolean') return null;
  const start = toStart(value.start);
  return start === null ? null : { start, path: value.path, line: value.line, node: value.node, heal: value.heal };
}

/**
 * A kept tree as the page reads it, or null when it is not a tree: `start` is a start (`toStart`; one with junk under
 * `carried` is none, so the whole tree is none) and `path` is a path (`isPath`). `save` is kept when it is an object of two
 * strings, else null; `others` is those of its entries that are paths, the first 24, and none when it is
 * missing or not an array. A kept draft's entries are checked against the save where the tree is restored, not here.
 */
function toLineRecord(value: unknown): LineRecord | null {
  if (!isRecord(value) || !isPath(value.path)) return null;
  const start = toStart(value.start);
  if (start === null) return null;
  const { save } = value;
  return {
    save: isRecord(save) && typeof save.savePath === 'string' && typeof save.savedAt === 'string' ? { savePath: save.savePath, savedAt: save.savedAt } : null,
    start,
    path: value.path,
    others: Array.isArray(value.others) ? value.others.filter(isPath).slice(0, 24) : [],
  };
}

/** The trees the player named for a trainer copy, oldest first. */
export function readSaved(trainerId: string, variant: number): SavedLine[] {
  const value = read(savedKey(trainerId, variant));
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): SavedLine[] => {
    const record = toLineRecord(v);
    const name = isRecord(v) ? v.name : undefined;
    return record === null || typeof name !== 'string' ? [] : [{ name, ...record }];
  });
}

// ---- Damage numbers -----------------------------------------------------------------------------------------------
// Each KO figure says what it is conditional on: no crit unless it says "on a crit", and "if it hits" where the move can
// miss. They are the calc's exact fractions (`koExact`, `koCritExact`), compared exactly: each is reduced, so 1 is
// `num === den`, 0 is `num === '0'`, and two are equal when their strings are.

const isOne = (k: LineRationalJson) => k.num === k.den;
const isZero = (k: LineRationalJson) => k.num === '0';
const sameOdds = (a: LineRationalJson, b: LineRationalJson) => a.num === b.num && a.den === b.den;

/** The KO fractions `koText` reads: none for a row with the server's note and no range, a status move, or no `koExact`. */
function figures(m: LineMoveDamageJson): LineRationalJson[] | null {
  if ((m.note !== null && m.percent === null) || m.status || m.koExact === null || m.koExact.length === 0) return null;
  return m.koExact;
}

/**
 * " · on a crit up to 32 HP (64%)": the crit's top roll from `critHp[1]` and `critPercent[1]` (to one decimal), even when it
 * equals the plain top: the server sends crit figures only where a crit can land. For a move that hits more than once in a
 * use (`multiHit`; absent reads as false) that top has every hit a crit: " · if every hit crits, up to 64 HP
 * (128%)". '' without either or when the top is 0 HP (a status move, a server note, no crit that can land, the old
 * percent-only data).
 */
export function critMaxText(m: LineMoveDamageJson): string {
  if (m.critHp === null || m.critPercent === null || m.critHp[1] <= 0) return '';
  return ` · ${m.multiHit === true ? 'if every hit crits,' : 'on a crit'} up to ${m.critHp[1]} HP (${oneDecimal(m.critPercent[1])}%)`;
}

/**
 * The moves the calc runs as one plain hit though they hit more than once in a use, by name: Beat Up and Triple Kick (the
 * server matches them by effect text, src/server/lineDamage.ts `UNCOUNTED_MULTI_HIT`). A Focus Sash can stop one where the
 * calc's figure says it KOs, so a sure KO of theirs is never told as sure (`sureKo`).
 */
const UNCOUNTED_MULTI_HIT: readonly string[] = ['Beat Up', 'Triple Kick'];

/** Whether a move's KO words are a sure KO the page can show as such ("OHKO 100%", the ok tone): never Beat Up or Triple Kick. */
export function sureKo(m: LineMoveDamageJson): boolean {
  return koText(m) === 'OHKO 100%' && !UNCOUNTED_MULTI_HIT.includes(m.name);
}

/** "Priority +1", "Priority +2", "Priority -1" (an ASCII hyphen-minus); null for 0. */
export function priorityText(priority: number): string | null {
  return priority === 0 ? null : `Priority ${priority > 0 ? '+' : '-'}${Math.abs(priority)}`;
}

/**
 * One hit's range and its top crit roll: "22–27 HP (44–54%) · on a crit up to 32 HP (64%)", "40 HP (40%)" when no crit HP is
 * there, "0 HP" when the HP is there and the most is 0; the percent alone ("44–54%") when only it is; ''
 * without numbers.
 */
export function rangeText(m: LineMoveDamageJson): string {
  if (m.percent === null) return '';
  return (m.hp === null ? percentRange(m.percent) : damageRange(m.hp, m.percent)) + critMaxText(m);
}

/**
 * The KO words for `k` (1, 2, 3 and 4 hits, no crit) and `c` (one hit that is a crit), before any hit chance. With no `c`
 * there is no "on a crit" figure at all: the one-hit chance alone, or straight to the first KO in more hits.
 */
function koWords(k: LineRationalJson[], c: LineRationalJson | null): string {
  const k1 = k[0]!;
  if (isOne(k1)) return 'OHKO 100%';
  if (!isZero(k1)) return c === null || sameOdds(c, k1) ? `OHKO ${odds(k1).percent}` : `OHKO ${odds(k1).percent} · on a crit ${odds(c).percent}`;
  const n = k.findIndex((kn) => !isZero(kn));                                   // k1 is 0: the lowest such n is 2 or more
  const later = n < 0 ? null : `${n + 1}HKO ${odds(k[n]!).percent}`;
  if (c !== null && !isZero(c)) return `No OHKO without a crit · on a crit ${odds(c).percent}${later === null ? '' : ` · ${later}`}`;
  // Three hits and a crit can still KO, so even "none" names its condition.
  return later ?? `No KO in ${k.length} hits without a crit`;
}

/** Whether KO words claim one hit can KO: "OHKO…", or a KO "on a crit". */
const claimsOneHit = (words: string): boolean => words.startsWith('OHKO') || words.includes('on a crit');

/**
 * The KO words: "OHKO 100%", "OHKO 18.75% · on a crit 100%", "No OHKO without a crit · on a crit 50% · 2HKO 39.84%",
 * "3HKO 100%", "No KO in 4 hits without a crit"; prefixed "Hits 85% · if it hits: " when the move can miss. A null
 * `koCritExact` prints no "on a crit" figure ("OHKO 18.75%", "2HKO 39.84%"). Words that claim one hit can KO ("OHKO…" or
 * "on a crit…") are followed by " · Focus Sash: survives one hit from full HP" when the server names the held item that
 * keeps the defender at 1 HP (`survives`; absent reads as null); words with no such claim get nothing. The server's note
 * where there are no figures; "Status move". A move with a range and no KO figures is '', or "Hits 85%" when it can miss.
 */
export function koText(m: LineMoveDamageJson): string {
  if (m.note !== null && m.percent === null) return m.note;
  if (m.status) return 'Status move';
  const k = figures(m);
  const hits = m.hitChance < 1 ? `Hits ${formatChance(m.hitChance)}` : null;
  if (k === null) return hits !== null && m.percent !== null ? hits : '';
  const words = koWords(k, m.koCritExact);
  const sash = m.survives ?? null;                                                  // absent reads as null
  const said = sash !== null && claimsOneHit(words) ? `${words} · ${sash}: survives one hit from full HP` : words;
  return hits === null ? said : `${hits} · if it hits: ${said}`;
}

/**
 * The KO words as short lines for the compact move tile (`koText` stays the one-line form): "85% to hit" when it can miss;
 * "OHKO 100%", "OHKO 18.75%", "No OHKO · 2HKO 39.84%" or "No KO in 4 hits" with no crit; "Crit: OHKO 50%" where a crit's
 * one-hit chance differs from that ("Crit: no OHKO" for a move that would OHKO without one); and "{item}: survives 1 hit"
 * where a line claims an OHKO and the server names a Sash-like item. Figures assume the move hits (`KO_KEY` says so).
 * ['Status move'] for a status move, [note] for the server's note with no numbers, only the hit line for a range alone.
 */
export function koLines(m: LineMoveDamageJson): string[] {
  if (m.note !== null && m.percent === null) return [m.note];
  if (m.status) return ['Status move'];
  const lines: string[] = [];
  if (m.hitChance < 1) lines.push(`${formatChance(m.hitChance)} to hit`);
  const k = figures(m);
  if (k === null) return lines;
  const k1 = k[0]!;
  const c = m.koCritExact;
  let claimsOhko = false;
  if (!isZero(k1)) {
    lines.push(`OHKO ${odds(k1).percent}`);
    claimsOhko = true;
  } else {
    const n = k.findIndex((kn) => !isZero(kn));
    lines.push(n < 0 ? `No KO in ${k.length} hits` : `No OHKO · ${n + 1}HKO ${odds(k[n]!).percent}`);
  }
  if (c !== null && !sameOdds(c, k1)) {
    if (!isZero(c)) {
      lines.push(`Crit: OHKO ${odds(c).percent}`);
      claimsOhko = true;
    } else if (!isZero(k1)) {
      lines.push('Crit: no OHKO');
    }
  }
  const sash = m.survives ?? null;
  if (sash !== null && claimsOhko) lines.push(`${sash}: survives 1 hit`);
  return lines;
}

/**
 * One row of a crit split: the case's name, its exact chance (null where the page has none to give: a
 * multi-hit move's, or a crit the server could not work out), whether the crit chance it rests on is only the base rate
 * (the server did not send the move's own), the damage as `damageRange` words, and the KO words ('' when there are none).
 * A multi-hit move's rows are "No hit crits" and "Every hit crits", with `title` saying the one-hit chance.
 */
export interface SplitRow {
  label: 'Non-crit' | 'Crit' | 'No hit crits' | 'Every hit crits';
  chance: LineRationalJson | null; base: boolean; damage: string; ko: string; title?: string;
}

/** Whether a split row is a crit case: "Crit", or a multi-hit move's "Every hit crits". */
export const isCritRow = (row: SplitRow): boolean => row.label === 'Crit' || row.label === 'Every hit crits';

const gcdBig = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcdBig(b, a % b));

/** 1 − `c`, exact and reduced. */
function oneMinus(c: LineRationalJson): LineRationalJson {
  const num = BigInt(c.den) - BigInt(c.num);
  const den = BigInt(c.den);
  const g = gcdBig(num < 0n ? -num : num, den);
  return g === 0n || num === 0n ? { num: '0', den: '1' } : { num: String(num / g), den: String(den / g) };
}

/** The KO words of a split row get the hit chance in front, and the held item after a claim of one-hit KO. */
function rowKo(m: LineMoveDamageJson, words: string): string {
  if (words === '') return '';
  const said = m.survives != null && words.startsWith('OHKO') ? `${words} · ${m.survives}: survives one hit from full HP` : words;
  return m.hitChance < 1 ? `Hits ${formatChance(m.hitChance)} · if it hits: ${said}` : said;
}

/**
 * The two rows of a crit split: Non-crit (the plain range, and its lowest KO) and Crit (the crit range, and the chance one
 * crit KOs). The crit's chance is the server's (`critChance`) or, when absent, the base 1/16 marked `base`.
 *
 * Without crit figures (`critHp` null) there is one row, its chance as far as the server tells it: chance 1 where it sends
 * 0/1 (no crit can land: the caller says "No crit possible"), and none where it sends no chance (it could not tell: "Crit
 * not worked out here").
 *
 * A move that hits more than once in a use (`multiHit`; absent reads as false) has the calc's `hp` summing every hit of a
 * use and its crit figures every hit a crit, while `critChance` is one hit's: the rows are "No hit crits" and "Every hit
 * crits", with no chance (the whole move's turns on how many hits land), a `title` with the one-hit chance, and the crit
 * row's KO "if every hit crits". None for a status move or a move without numbers.
 */
export function splitRows(m: LineMoveDamageJson): SplitRow[] {
  if (m.status || m.percent === null) return [];
  const sent = m.critChance ?? null;
  const c: LineRationalJson = sent ?? { num: '1', den: '16' };
  const multi = m.multiHit === true;
  const k = m.koExact;
  let plain = '';
  if (k !== null && k.length > 0) {
    const n = k.findIndex((kn) => !isZero(kn));
    plain = n < 0 ? `No KO in ${k.length} hits` : `${n + 1 === 1 ? 'OHKO' : `${n + 1}HKO`} ${odds(k[n]!).percent}`;
  }
  const damage = m.hp === null ? percentRange(m.percent) : damageRange(m.hp, m.percent);
  const plainLabel = multi ? 'No hit crits' : 'Non-crit';
  const { critHp, critPercent } = m;
  if (critHp === null || critPercent === null) {
    const none = sent !== null && isZero(sent);
    return [{ label: plainLabel, chance: none ? { num: '1', den: '1' } : null, base: false, damage, ko: rowKo(m, plain) }];
  }
  const kc = m.koCritExact;
  const base = sent === null;
  if (multi) {
    const title = `${odds(c).exact} per hit; the chance for the whole move depends on how many hits land`;
    const critWords = kc === null ? '' : isZero(kc) ? 'No OHKO if every hit crits' : `OHKO ${odds(kc).percent} if every hit crits`;
    return [
      { label: 'No hit crits', chance: null, base, damage, ko: rowKo(m, plain), title },
      { label: 'Every hit crits', chance: null, base, damage: damageRange(critHp, critPercent), ko: rowKo(m, critWords), title },
    ];
  }
  const critWords = kc === null ? '' : isZero(kc) ? 'No OHKO on a crit' : `OHKO ${odds(kc).percent} on a crit`;
  return [
    { label: 'Non-crit', chance: oneMinus(c), base, damage, ko: rowKo(m, plain) },
    { label: 'Crit', chance: c, base, damage: damageRange(critHp, critPercent), ko: rowKo(m, critWords) },
  ];
}

/**
 * The tone of a split row's KO words: 'danger' on his side (`hot` 'mine') where they claim an OHKO ("OHKO…",
 * or "Hits 85% · if it hits: OHKO…") and no held item survives it (`survives`; absent reads as null); 'ok' on theirs only
 * for a sure "OHKO 100%…" from a move that always hits, nothing surviving, and never Beat Up or Triple Kick (the calc runs
 * them as one plain hit, so a Focus Sash could stop them, as `sureKo` has it); else none.
 */
export function splitTone(m: LineMoveDamageJson, row: SplitRow, hot: 'mine' | 'theirs'): 'danger' | 'ok' | null {
  if (m.survives != null) return null;
  const words = row.ko.replace(/^Hits [^·]+ · if it hits: /, '');
  if (hot === 'mine') return words.startsWith('OHKO') ? 'danger' : null;
  return m.hitChance === 1 && row.ko.startsWith('OHKO 100%') && !UNCOUNTED_MULTI_HIT.includes(m.name) ? 'ok' : null;
}

/** Every exact fraction behind `koText`, for the `title`: "1 hit 0/1 · 2 hits 51/128 · 3 hits 1/1 · 4 hits 1/1 · on a crit 1/2"; undefined without figures. */
export function koTitle(m: LineMoveDamageJson): string | undefined {
  const k = figures(m);
  if (k === null) return undefined;
  const parts = k.map((kn, i) => `${i + 1} ${i === 0 ? 'hit' : 'hits'} ${kn.num}/${kn.den}`);
  if (m.koCritExact !== null) parts.push(`on a crit ${m.koCritExact.num}/${m.koCritExact.den}`);
  return parts.join(' · ');
}

/** `rangeText` (crit top included) and `koText`, joined by " · ", the empty one left out. */
export function moveText(m: LineMoveDamageJson): string {
  return [rangeText(m), koText(m)].filter((text) => text !== '').join(' · ');
}

/**
 * The turn order in words, from the server's `order` (the effective Speeds, player then enemy, and who moves first at
 * equal priority): "You move first · Speed 26 vs 21", "It moves first · Speed 16 vs 21", "Speed tie at 21: either moves
 * first"; "Speed order not worked out here." for null. The words follow `first` (under Trick Room the slower side). A
 * first-mover form adds " · at equal priority" when any of `priorities` (every move's on both sides) is not 0; every
 * form but null's adds " · Quick Claw can change this" ("Quick Claw or Custap Berry can change this") for `changers`.
 */
export function turnOrderText(order: LineOrderJson | null, priorities: readonly number[]): string {
  if (order === null) return 'Speed order not worked out here.';
  const { first, player, enemy, changers } = order;
  const prioritised = priorities.some((p) => p !== 0);
  const words = first === 'tie'
    ? `Speed tie at ${player}: either moves first`
    : `${first === 'player' ? 'You move' : 'It moves'} first · Speed ${player} vs ${enemy}${prioritised ? ' · at equal priority' : ''}`;
  return changers.length === 0 ? words : `${words} · ${changers.join(' or ')} can change this`;
}

/** `turnOrderText` for a node's numbers, over every move's priority on both sides; null without numbers. */
export function turnOrderOf(damage: LineDamageJson | undefined): string | null {
  if (damage === undefined) return null;
  return turnOrderText(damage.order, [...damage.yours, ...damage.theirs].map((m) => m.priority));
}

/** The key under the moves: what the KO words count. */
export const KO_KEY = 'OHKO, 2HKO, 3HKO: the chance that many hits in a row take it from its HP now to 0, with no crit and nothing else changing. KO figures assume the move hits.';

/** The statuses that can stop a Pokémon moving this turn, as the server words them (lineView.ts). */
const MAY_NOT_MOVE: readonly string[] = ['asleep', 'frozen', 'paralysed'];

/** "Prinplup is asleep: it may not move." for a status of asleep, frozen or paralysed; null otherwise. */
export function mayNotMove(mon: LineMonJson | null): string | null {
  if (mon === null || mon.status === null || !MAY_NOT_MOVE.includes(mon.status)) return null;
  return `${mon.name} is ${mon.status}: it may not move.`;
}
