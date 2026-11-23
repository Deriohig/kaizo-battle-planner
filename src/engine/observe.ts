// What the player sees: the observation, and the reveals record it reads.
//
// The observation is the visible end-of-step state plus the step's message kinds: coarser
// than the screen, as a plan may ignore information (coarsening never makes a proof unsound; it can only miss a line
// that needed the finer detail). It never holds a hidden counter (sleep, confusion and Disable turns, durations, the
// Protect counter, the stored Quick Claw roll, Speed values), the enemy's PP, stats or exact HP, an unrevealed move,
// ability or item, or a chance with no message. Two enemies of one species are told apart by nothing but what shows.
//
// Rendering rules (byte-exact: a native engine would render the same bytes from them). The observation is a pure
// function of the battle's visible state at the end of the step and the step's protocol lines (Showdown's, `|split|`
// blocks included; none for a root view), with no other input (no leaf order, no replay state, no object identity).
// "Sorted" below always means JavaScript's default `Array.prototype.sort`: by UTF-16 code units. The observation is
// `canonicalJson` (key.ts) of `{ turn, player, enemy, field, events }`: every object's keys sorted, arrays in order, no
// whitespace, each string, number, boolean and null as `JSON.stringify` writes it, an object property that is
// undefined left out.
// - `turn`: the battle's turn number.
// - `player`: the player's whole party in `side.team` order (the order of the sets at battle start: his party, lead first),
//   not the slot order Showdown's `side.pokemon` changes as Pokémon switch. Each is `{ species, level, hp, maxhp,
//   status, item, active, boosts, moves }`: `species` the current forme's display name (`species.name`, so
//   "Castform-Sunny"), exact HP and max HP, the status ID, the held item's ID ('' for none), `active`, `boosts` with
//   all seven stages (atk, def, spa, spd, spe, accuracy, evasion), and `moves`, its move slots in order (Transform's
//   and Mimic's copies included), each `{ move, pp, maxpp }` with the move's ID.
//   - The status ID is '', 'brn', 'par', 'slp', 'frz', 'psn' or 'tox', or 'fnt' for a fainted Pokémon still in an
//     active slot once Showdown's `checkFainted` has run (dist/sim/battle.js:2063-2067). Its one call, in `runAction`,
//     comes when an action ends with no action left queued (Gen 4): a turn's actions are done and the battle goes on,
//     which is every replacement state. A battle that ended on the faint (`if (this.ended) return true` comes first)
//     and a mid-turn state with a queued `instaswitch`, such as a U-turn user's switch, skip it, so there the fainted
//     Pokémon keeps the status it had (battle.js:2336-2351). A switch-in that replaces a fainted Pokémon resets its
//     status to '' (dist/sim/battle-actions.js:126).
//   - `active` is Showdown's `isActive`: false once the Pokémon has fainted, even while it is still in the slot
//     (`faintMessages` clears it, dist/sim/battle.js:2103, at terminal, mid-turn and replacement states alike).
// - `enemy`: `{ active, fainted, revealed }`.
//   - `active`: the Pokémon in the trainer's active slot (`p2.active[0]`; a fainted one stays there until its
//     replacement comes in, with 0 pixels: status 'fnt' at a replacement state, its old status at a terminal or
//     mid-turn state, as for the player), `{ species, level, gender, pixels, status, boosts }`: `species` as for the
//     player (`species.name`), `gender` 'M', 'F' or '' (Showdown keeps a genderless Pokémon's 'N' as '',
//     sim/pokemon.ts:341), `pixels` the HP bar's (`barPixels`: 0 at 0 HP, else floor(HP × 48 / max HP), at least 1),
//     status (as for the player) and boosts. It is null when `p2.active[0]` is undefined; once the battle has started
//     the slot always holds a Pokémon (Showdown's empty slot, `null` before the start, dist/sim/side.js:94, is never
//     observed).
//   - `fainted`: how many of the trainer's Pokémon have fainted.
//   - `revealed`: the reveals record (`kaizoReveals` in `formatData`: what earlier steps showed) with this step's lines
//     folded in. It is keyed by base species name (`baseSpecies.baseSpecies`, so "Castform" whatever the forme), each
//     `{ moves, ability, item, itemGone }`: the sorted names of the moves seen, without duplicates, and the ability and
//     held item names seen (null for none), `itemGone` whether the item was seen to go. The fold reads player 1's
//     channel (below, before the renaming), line by line, fields split on '|': a line with no subject field, or with
//     a `[trainer]` field, is skipped; a subject or `[of]` ident (`p2a: NAME` or `p2: NAME`; the `[of]` Pokémon is the
//     first field starting `[of] `) names a trainer Pokémon by its Showdown name, and only those are recorded (a
//     record starts as `{ moves: [], ability: null, item: null, itemGone: false }` the first time something is set
//     for it). Then:
//     - `|-ability|SUBJECT|ABILITY…` sets the subject's ability, and also the `[of]` Pokémon's when a field matches
//       `^\[from\] ?ability: ?Trace$`; nothing else of the line is read;
//     - `|move|SUBJECT|MOVE…` adds the move unless it is Struggle or a field matches `^\[from\] ?move:`;
//     - `|-item|SUBJECT|ITEM…` sets the held item and clears `itemGone`, `|-enditem|SUBJECT|ITEM…` sets it and sets
//       `itemGone`;
//     - then (any line but `-ability`) every field after the subject that matches `^\[from\] ?(ability|item): ?(.+)$`
//       names the ability or item of the `[of]` Pokémon if the line has one, else the subject's; one that matches
//       `^(ability|item): ?(.+)$` names the subject's (an item named this way leaves `itemGone` as it is);
//     - an item that is one of the trainer's bag items (`isTrainerItemName`, trainerItems.ts) is never recorded.
// - `field`: `{ weather, pseudoWeather, p1, p2 }`: Showdown's weather ID ('' for none); the sorted IDs among
//   'trickroom' and 'gravity' that are up; for each side, its conditions among 'reflect', 'lightscreen', 'safeguard',
//   'mist', 'tailwind', 'luckychant', 'spikes', 'toxicspikes' and 'stealthrock', as ID → layers (1 for a condition
//   without layers).
// - `events`: the step's lines in three passes.
//   1. Player 1's channel (`playerChannel`). A `|split|SIDE` line takes the next two lines, the secret copy then the
//      public one: for SIDE p1 the secret copy stays; for any other the public copy stays, with HP from the secret
//      one: if the public copy is '' nothing stays; if the two copies have different numbers of '|' fields the public
//      copy stays as it is; else each field of the secret copy that matches `^(\d+)\/(\d+)(.*)$` becomes `PIXELS/48`
//      and the rest of that field (`barPixels` of the two numbers), and every other field is the public copy's.
//      Every other line stays. Then '' lines and lines matching `^\|(t:|-hint|debug)\|` or `\|\[silent\](\||$)` are
//      dropped.
//   2. The renaming (`enemiesBySpecies`). Each trainer Pokémon whose Showdown name ("Zubat 2") is not its base species
//      name is renamed to the base species name: in every '|' field of every line, except a field matching
//      `^(\[of\] )?p1[a-z]?: ` (the player's idents), each occurrence of such a name that is neither preceded nor
//      followed by a Unicode letter, a Unicode digit or '_' is replaced, in one left-to-right pass of one pattern that
//      tries the longest names first.
//   3. The message kinds (`messageKinds`). Each line is split on '|' into fields (field 0 is '', field 1 the command).
//      A `move` line opens a move event `{ line, crit, miss, effectiveness, damaged }` (`line` the whole line, then
//      false, false, [], []), placed in the events where the line was; it stays open until the step's next `move`
//      line. While an event is open, these lines are dropped into it:
//      - `-crit`, with any fields: `crit` is true;
//      - `-miss`, with any fields: `miss` is true;
//      - `-supereffective` or `-resisted`, with any fields, and `-immune` with exactly three fields (`|-immune|IDENT`):
//        'super', 'resisted' or 'immune' is added to `effectiveness`;
//      - `-damage` with exactly four fields whose fourth matches `^\d+(\/\d+)?( [a-z]+)?$` (`|-damage|IDENT|HP`, HP as
//        `HP/MAX` or bar pixels, an optional status, or `0 fnt`): the third field (the ident) is added to `damaged`.
//        That is any such line up to the next `move` line, whatever dealt it: an end-of-turn Future Sight or Doom
//        Desire hit, or a move's own HP cost (Substitute, Belly Drum), joins the step's last move event before it.
//      `effectiveness` and `damaged` are sorted, without duplicates. Every other line (and every line before the step's
//      first `move` line) is kept: as it is, except a `-damage`, `-heal` or `-sethp` line with at least four fields
//      whose fourth matches that HP pattern, which is kept without its fourth field (the remaining fields joined by
//      '|' again).
//   So the events drop per-hit damage amounts and the order of identical events, and keep the moves used (in order,
//   with their user, target and tags), whether each crit, missed or hit and how effective it was, status and stat
//   changes, faints, switches and drags, and on-screen item and ability activations.
// Where in doubt it leaves things out: a coarser view than the screen's only costs proofs, a finer one would make them
// unsound.
//
// The reveals record lives in the battle's `formatData` (`kaizoReveals`), so it is part of the state and its key: the
// observation is a function of the state and the step's messages, so equal keys give equal futures of what the player sees.
// `snapshot` (battle.ts) folds each step's log into it, as player 1's channel shows it. Showdown's log can't carry it
// instead: each snapshot keeps only its own step's log, so restores stay small.

import { canonicalJson } from './key.js';
import { isTrainerItemName } from './trainerItems.js';

/**
 * The cartridge's HP bar: 6 cells of 8 pixels (`HEALTHBOX_HP_CELL_COUNT`, pokeplatinum src/battle/healthbox.c:61).
 * `FillCells` (healthbox.c:1559-1601) fills `temp * 48 / max` pixels, or `(temp * 48 / max) >> 8` when max HP is below
 * 48 and `temp` holds HP << 8 (both are floor(HP × 48 / max HP), as integer division rounds down), and 1 pixel when that
 * is 0 with HP left (:1585). `UpdateGauge` (:1482-1557) settles `temp` at the current HP once the bar stops moving.
 */
export function barPixels(hp: number, maxhp: number): number {
  if (hp <= 0) return 0;
  const pixels = Math.floor((hp * 48) / maxhp);
  return pixels === 0 ? 1 : pixels;
}

/** What the player has seen of one enemy species over the battle: moves used, its ability and its held item. */
interface Revealed { moves: string[]; ability: string | null; item: string | null; itemGone: boolean }
type Reveals = Record<string, Revealed>;

const REVEALS_KEY = 'kaizoReveals';

const IDENT = /^(p[12])[a-z]?: (.+)$/;

/** The species name the player sees for each of the trainer's Pokémon, by its Showdown name. */
function enemyNames(battle: Battle): Map<string, string> {
  return new Map(battle.p2.pokemon.map((pokemon) => [pokemon.name, pokemon.baseSpecies.baseSpecies]));
}

/**
 * Folds the reveals in `lines` (player 1's channel) into `reveals`, for the trainer's Pokémon only:
 * - `|move|` adds the move, unless another move called it (`[from] move: …`);
 * - `|-ability|` sets the ability (and Trace's `[of]` Pokémon has the traced ability); `|-item|` sets the held item,
 *   `|-enditem|` sets it and marks it gone;
 * - an `ability: X` or `item: X` argument names the line's Pokémon's ability or item; with `[from]`, the `[of]`
 *   Pokémon's when there is one;
 * - the trainer's bag items, which `runTrainerItem` logs with `[trainer]` or names in `[from] item:`, are not held items.
 * Every step sets a field to a value from the line, so folding the same lines twice changes nothing.
 */
function foldReveals(reveals: Reveals, names: ReadonlyMap<string, string>, lines: readonly string[]): void {
  const record = (ident: string | undefined): Revealed | null => {
    const match = ident === undefined ? null : IDENT.exec(ident);
    const species = match?.[1] === 'p2' ? names.get(match[2]!) : undefined;
    if (species === undefined) return null;
    return (reveals[species] ??= { moves: [], ability: null, item: null, itemGone: false });
  };
  const setAbility = (ident: string | undefined, ability: string) => {
    const seen = record(ident);
    if (seen) seen.ability = ability;
  };
  const setItem = (ident: string | undefined, item: string, gone?: boolean) => {
    if (isTrainerItemName(item)) return;
    const seen = record(ident);
    if (!seen) return;
    seen.item = item;
    if (gone !== undefined) seen.itemGone = gone;
  };
  for (const line of lines) {
    const args = line.split('|').slice(1);
    const [command, subject, value] = args;
    if (subject === undefined || args.includes('[trainer]')) continue;
    const of = args.find((arg) => arg.startsWith('[of] '))?.slice('[of] '.length);
    if (command === '-ability') {
      if (value === undefined) continue;
      setAbility(subject, value);
      if (of !== undefined && args.some((arg) => /^\[from\] ?ability: ?Trace$/.test(arg))) setAbility(of, value);
      continue;
    }
    if (command === 'move' && value !== undefined && value !== 'Struggle' && !args.some((arg) => /^\[from\] ?move:/.test(arg))) {
      const seen = record(subject);
      if (seen && !seen.moves.includes(value)) seen.moves = [...seen.moves, value].sort();
    }
    if ((command === '-item' || command === '-enditem') && value !== undefined) setItem(subject, value, command === '-enditem');
    for (const arg of args.slice(2)) {
      const from = /^\[from\] ?(ability|item): ?(.+)$/.exec(arg);
      const named = from ?? /^(ability|item): ?(.+)$/.exec(arg);
      if (named === null) continue;
      const owner = from && of !== undefined ? of : subject;
      if (named[1] === 'ability') setAbility(owner, named[2]!);
      else setItem(owner, named[2]!);
    }
  }
}

function storedReveals(battle: Battle): Reveals {
  return (battle.formatData[REVEALS_KEY] as Reveals | undefined) ?? {};
}

/**
 * Folds `log` (Showdown's protocol lines, `|split|` blocks included) into `battle`'s reveals record, from what player
 * 1's screen shows of it (`playerChannel`), so the record never holds more than the player saw.
 */
export function recordReveals(battle: Battle, log: readonly string[]): void {
  const reveals = (battle.formatData[REVEALS_KEY] ??= {}) as Reveals;
  foldReveals(reveals, enemyNames(battle), playerChannel(log));
}

/**
 * The omniscient view of Showdown's protocol lines, the standard spectator-omniscient stream: each `|split|` block's
 * secret copy, without the wall-clock `|t:|` lines.
 */
export function omniscientLog(log: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < log.length; i++) {
    const line = log[i]!;
    if (line.startsWith('|split|')) {
      lines.push(log[i + 1] ?? '');
      i += 2;
    } else if (!line.startsWith('|t:|')) {
      lines.push(line);
    }
  }
  return lines;
}

const HP_FIELD = /^(\d+)\/(\d+)(.*)$/;

/**
 * An enemy line as player 1's screen shows it: Showdown's public copy (`shared`), with each HP field of the secret copy
 * as HP-bar pixels out of 48 (`barPixels`), not Showdown's own rounding. An empty public copy shows nothing.
 */
function withBarPixels(secret: string, shared: string): string {
  if (shared === '') return '';
  const [secretParts, sharedParts] = [secret.split('|'), shared.split('|')];
  if (secretParts.length !== sharedParts.length) return shared;
  return secretParts.map((part, k) => {
    const hp = HP_FIELD.exec(part);
    return hp ? `${barPixels(Number(hp[1]), Number(hp[2]))}/48${hp[3]}` : sharedParts[k]!;
  }).join('|');
}

/**
 * Lines the cartridge never shows: timestamps, Showdown's hints and debug lines, and lines Showdown marks `[silent]`
 * (no text on its own client either). Leaving a line out only makes the view coarser, never finer than the screen.
 */
const OFF_SCREEN = /^\|(t:|-hint|debug)\||\|\[silent\](\||$)/;

/**
 * Player 1's channel of `log` (as Showdown's `extractChannelMessages` gives a player): his own `|split|` blocks' secret
 * copies, the trainer's public copies (with HP-bar pixels, `withBarPixels`), and every other line, without the lines
 * the screen never shows (`OFF_SCREEN`).
 */
function playerChannel(log: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < log.length; i++) {
    let line = log[i]!;
    if (line.startsWith('|split|')) {
      const [side, secret, shared] = [line.slice('|split|'.length), log[i + 1] ?? '', log[i + 2] ?? ''];
      i += 2;
      line = side === 'p1' ? secret : withBarPixels(secret, shared);
    }
    if (line !== '' && !OFF_SCREEN.test(line)) lines.push(line);
  }
  return lines;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Renames the trainer's Pokémon to their species, as the screen names them, wherever a line names one: in an ident
 * (`p2a: Zubat 2`) and bare (Beat Up's `[of] Zubat 2`, Wish's `[wisher] Zubat 2`, gen4 moves.js), so Showdown's unique
 * names never tell two same-species Pokémon apart. Every whole-word occurrence of a renamed Pokémon's Showdown name is
 * replaced, whatever tag carries it, except in the player's own idents (`p1a: …`), which name his Pokémon.
 */
function enemiesBySpecies(names: ReadonlyMap<string, string>): (line: string) => string {
  const renamed = [...names].filter(([name, species]) => name !== species).sort(([a], [b]) => b.length - a.length);
  if (renamed.length === 0) return (line) => line;
  const species = new Map(renamed);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${renamed.map(([name]) => escapeRegExp(name)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return (line) => line.split('|')
    .map((part) => (/^(\[of\] )?p1[a-z]?: /.test(part) ? part : part.replace(pattern, (name) => species.get(name)!)))
    .join('|');
}

/** A move event: the `|move|` line and the flags of the lines that followed it (see the top of this file). */
interface MoveEvent { line: string; crit: boolean; miss: boolean; effectiveness: string[]; damaged: string[] }

/** A `|-damage|`, `|-heal|` or `|-sethp|` line's HP field: `HP/MAX` or bar pixels, with a status, or `0 fnt`. */
const HP_VALUE = /^\d+(\/\d+)?( [a-z]+)?$/;
const HP_LINES: ReadonlySet<string> = new Set(['-damage', '-heal', '-sethp']);
const EFFECTIVENESS: Readonly<Record<string, string>> = { '-supereffective': 'super', '-resisted': 'resisted', '-immune': 'immune' };

const addSorted = (list: string[], item: string) => {
  if (!list.includes(item)) {
    list.push(item);
    list.sort();
  }
};

/**
 * The step's message kinds from player 1's renamed lines (see the top of this file): move events with their flags,
 * and every other line, `|-damage|`, `|-heal|` and `|-sethp|` without their HP.
 */
function messageKinds(lines: readonly string[]): (string | MoveEvent)[] {
  const events: (string | MoveEvent)[] = [];
  let current: MoveEvent | null = null;
  for (const line of lines) {
    const parts = line.split('|'); // ['', command, ...arguments]
    const command = parts[1] ?? '';
    if (command === 'move') {
      current = { line, crit: false, miss: false, effectiveness: [], damaged: [] };
      events.push(current);
      continue;
    }
    if (current !== null) {
      if (command === '-crit') {
        current.crit = true;
        continue;
      }
      if (command === '-miss') {
        current.miss = true;
        continue;
      }
      if (Object.hasOwn(EFFECTIVENESS, command) && (command !== '-immune' || parts.length === 3)) {
        addSorted(current.effectiveness, EFFECTIVENESS[command]!);
        continue;
      }
      if (command === '-damage' && parts.length === 4 && HP_VALUE.test(parts[3]!)) {
        addSorted(current.damaged, parts[2]!);
        continue;
      }
    }
    if (HP_LINES.has(command) && parts.length >= 4 && HP_VALUE.test(parts[3]!)) {
      events.push([...parts.slice(0, 3), ...parts.slice(4)].join('|'));
      continue;
    }
    events.push(line);
  }
  return events;
}

const VISIBLE_SIDE_CONDITIONS: ReadonlySet<string> = new Set([
  'reflect', 'lightscreen', 'safeguard', 'mist', 'tailwind', 'luckychant', 'spikes', 'toxicspikes', 'stealthrock',
]);
const VISIBLE_PSEUDO_WEATHER: ReadonlySet<string> = new Set(['trickroom', 'gravity']);

/** A side's visible conditions, each with its layers (1 for a condition without layers). */
function sideConditions(side: Battle['p1']): Record<string, number> {
  return Object.fromEntries(Object.entries(side.sideConditions)
    .filter(([id]) => VISIBLE_SIDE_CONDITIONS.has(id))
    .map(([id, state]) => [id, (state['layers'] as number | undefined) ?? 1]));
}

/**
 * What the player sees in `battle` after a step whose protocol lines are `stepLog` (Showdown's, with `|split|` blocks; empty
 * for a root view). See the top of this file.
 */
export function observe(battle: Battle, stepLog: readonly string[]): string {
  const names = enemyNames(battle);
  const messages = playerChannel(stepLog);
  const revealed = structuredClone(storedReveals(battle));
  foldReveals(revealed, names, messages); // already in the record after `snapshot`; folding twice is a no-op
  const side = battle.p1;
  const player = side.team.map((set) => side.pokemon.find((pokemon) => pokemon.set === set)!).map((pokemon) => ({
    species: pokemon.species.name, level: pokemon.level, hp: pokemon.hp, maxhp: pokemon.maxhp, status: pokemon.status,
    item: pokemon.item, active: pokemon.isActive, boosts: { ...pokemon.boosts },
    moves: pokemon.moveSlots.map((slot) => ({ move: slot.id, pp: slot.pp, maxpp: slot.maxpp })),
  }));
  const foe = battle.p2.active[0];
  const enemy = {
    active: foe === undefined ? null : {
      species: foe.species.name, level: foe.level, gender: foe.gender, pixels: barPixels(foe.hp, foe.maxhp),
      status: foe.status, boosts: { ...foe.boosts },
    },
    fainted: battle.p2.pokemon.filter((pokemon) => pokemon.fainted).length,
    revealed,
  };
  const field = {
    weather: battle.field.weather,
    pseudoWeather: Object.keys(battle.field.pseudoWeather).filter((id) => VISIBLE_PSEUDO_WEATHER.has(id)).sort(),
    p1: sideConditions(battle.p1), p2: sideConditions(battle.p2),
  };
  return canonicalJson({ turn: battle.turn, player, enemy, field, events: messageKinds(messages.map(enemiesBySpecies(names))) });
}
