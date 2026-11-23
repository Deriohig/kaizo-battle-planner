// The engine's battle-level notes: every `engine:` note a battle records in `unmodelledIn`
// (unmodelled.ts `addUnmodelledNote`), besides the per-move ones (`<move>: <reason>`, and `engine: move "…" is not a hack
// move`). Other modules name them by constant, or ask `isBattleNote`; test/unit/engine/notes.test.ts checks that
// every `addUnmodelledNote` call in src/engine records one of them, or a trainer item's note (trainerItems.ts), which
// is not an `engine:` note and not on this list.

import { BATTLE_START_CHANCE_NOTE, PICKUP_NOTE } from './battle.js';
import { ENGINE_EFFECTS, NO_ENTRY_PLAIN, NO_ENTRY_REASON } from './effects.js';
import { RECHARGE_NOTE } from './mod/conditions.js';
import { FIELD_COMBINATION_NOTE } from './mod/field.js';
import {
  BRICK_BREAK_IMMUNE_NOTE, KNOCK_OFF_PLATE_NOTE, LAST_RESORT_CALLER_NOTE, METRONOME_GAP_NOTE, metronomeCallNote, SLEEP_TALK_NOTE,
  PURSUIT_FIELD_NOTE, WISH_RECIPIENT_NOTE,
} from './mod/moves.js';
import { BAD_DREAMS_NOTE, TRANSFORMED_GIRATINA_NOTE } from './mod/procs.js';
import { METRONOME_COUNT_NOTE, RESIST_BERRY_NOTE } from './mod/scripts.js';
import { DOUBLE_REPLACEMENT_NOTE, FLAGGED_ITEM_NOTE } from './mod/speedOrder.js';
import { UNDEFINED_CATEGORY_NOTE } from './trainerItems.js';

/** Every fixed battle-level note, in no particular order. */
export const BATTLE_NOTES: readonly string[] = [
  BATTLE_START_CHANCE_NOTE, PICKUP_NOTE, RECHARGE_NOTE, FIELD_COMBINATION_NOTE, BRICK_BREAK_IMMUNE_NOTE, KNOCK_OFF_PLATE_NOTE,
  LAST_RESORT_CALLER_NOTE, METRONOME_GAP_NOTE, SLEEP_TALK_NOTE, WISH_RECIPIENT_NOTE, BAD_DREAMS_NOTE, TRANSFORMED_GIRATINA_NOTE,
  METRONOME_COUNT_NOTE, RESIST_BERRY_NOTE, DOUBLE_REPLACEMENT_NOTE, FLAGGED_ITEM_NOTE, PURSUIT_FIELD_NOTE,
];

const FIXED: ReadonlySet<string> = new Set(BATTLE_NOTES);

/** `metronomeCallNote`'s shape, any move name in it. */
const METRONOME_CALL = (() => {
  const [before, after] = metronomeCallNote('\u0000').split('\u0000') as [string, string];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(before)}.+${escape(after)}$`);
})();

/** Whether `entry` is one of the engine's battle-level notes: a fixed one (`BATTLE_NOTES`) or a Metronome call's. */
export function isBattleNote(entry: string): boolean {
  return FIXED.has(entry) || METRONOME_CALL.test(entry);
}

/**
 * What the fight page says for each note above and the trainer item's `UNDEFINED_CATEGORY_NOTE`: one plain sentence for a
 * player who knows Pokémon but not the code, with no function names, file cites or engine labels. The detailed note stays
 * as it is for the proofs and the docs; only this text goes to the page (`plainUnmodelled`).
 */
export const PLAIN_NOTES: Readonly<Record<string, string>> = {
  [BATTLE_START_CHANCE_NOTE]: 'A random event at the start of the battle was assumed to go one particular way',
  [PICKUP_NOTE]: 'A carried Pokémon with Pickup or Honey Gather may have picked up an item after the last fight',
  [RECHARGE_NOTE]: 'A Pokémon that was asleep or frozen had to recharge, and the game may handle that turn differently',
  [FIELD_COMBINATION_NOTE]: "The trainer's field note names more than one weather, which the game can't hold at once, so the weather here may be wrong",
  [BRICK_BREAK_IMMUNE_NOTE]: "Brick Break hit a target it can't damage while a screen was up; the game breaks the screen anyway, which the planner may not",
  [KNOCK_OFF_PLATE_NOTE]: "Knock Off by an Arceus holding a Plate: the planner may differ from the game on whether it works",
  [LAST_RESORT_CALLER_NOTE]: 'Last Resort by a Pokémon that also knows a move that calls other moves (like Metronome): the game counts the called moves too, so whether Last Resort works may differ',
  [METRONOME_GAP_NOTE]: 'Metronome could pick a move the planner has no data for',
  [SLEEP_TALK_NOTE]: 'Sleep Talk with a disabled move: which moves it can call may differ from the game',
  [WISH_RECIPIENT_NOTE]: 'Wish healed a different Pokémon than the one that used it, and the amount healed may differ from the game',
  [BAD_DREAMS_NOTE]: 'Bad Dreams damage may land in a different order at the end of the turn than in the game',
  [TRANSFORMED_GIRATINA_NOTE]: 'A Transformed Giratina-Origin: the game works out its copied stats as if it were in Altered Forme, which the planner does not',
  [METRONOME_COUNT_NOTE]: "A Metronome item's boost after a failed or locked-in move may be counted differently from the game",
  [RESIST_BERRY_NOTE]: 'A resist berry halved a hit that Endure, False Swipe, Counter, Mirror Coat, Metal Burst or Shell Bell also reads, and the game orders these differently, so the damage may differ',
  [DOUBLE_REPLACEMENT_NOTE]: 'Both sides sent in a new Pokémon at once with entry hazards down, and the order the hazards hit may differ from the game',
  [FLAGGED_ITEM_NOTE]: 'An item-taking move met a Quick Claw or Custap Berry activation, and the result may differ from the game',
  [PURSUIT_FIELD_NOTE]: "Your Pursuit knocked out a switching foe while weather, Trick Room, Gravity, Uproar or fog was up, which scrambles those field conditions in the game, so the rest of this branch may not match the game",
  [UNDEFINED_CATEGORY_NOTE]: "A trainer item has no known behaviour, so the planner can't predict when the trainer uses it",
};

/** Said for an entry nothing above recognises, so the page never shows a developer reason. */
const UNKNOWN_NOTE = "Something in this battle the planner can't predict";

/** The plain sentence of each unmodelled move effect, by its reason (the `engine:`-free text a move's entry carries). */
let plainByReason: [string, string][] | undefined;

const NO_HACK_MOVE = /^engine: move "(.*)" is not a hack move$/;
const TRAINER_ITEM = /^trainer item: (.+)'s HP recovery /;
const [CALL_BEFORE, CALL_AFTER] = metronomeCallNote('\u0000').split('\u0000') as [string, string];

/** One entry of the engine's `unmodelledIn`, said plainly (`plainUnmodelled`). */
function plainEntry(entry: string): string {
  const fixed = Object.hasOwn(PLAIN_NOTES, entry) ? PLAIN_NOTES[entry] : undefined;
  if (fixed !== undefined) return fixed;
  if (METRONOME_CALL.test(entry)) return `Metronome called ${entry.slice(CALL_BEFORE.length, entry.length - CALL_AFTER.length)}, whose effect the planner can't predict`;
  const noMove = NO_HACK_MOVE.exec(entry);
  if (noMove !== null) return `A move (${noMove[1]}) isn't in this hack's data, so the planner can't predict it`;
  const item = TRAINER_ITEM.exec(entry);
  if (item !== null) return `The trainer's ${item[1]} may heal more or less than the planner expects`;
  const colon = entry.indexOf(': ');
  if (colon <= 0 || /^(engine|integration|trainer item):/.test(entry)) return UNKNOWN_NOTE;
  const name = entry.slice(0, colon);
  const rest = entry.slice(colon + 2);
  plainByReason ??= [
    [NO_ENTRY_REASON, NO_ENTRY_PLAIN],
    ...Object.values(ENGINE_EFFECTS).flatMap((effect): [string, string][] => (effect.kind === 'unmodelled' ? [[effect.reason, effect.plain]] : [])),
  ];
  const found = plainByReason.find(([reason]) => rest.startsWith(reason));
  if (found !== undefined) return `${name}: ${found[1]}`;
  if (/^a (status|damaging)-move effect on a /.test(rest)) return `${name}: ${NO_ENTRY_PLAIN}`;
  return `${name}: the planner can't fully predict this move`;
}

/**
 * What the fight page shows for the engine's `unmodelledIn` entries: one plain sentence each, in the same order. A move's
 * entry is the move's name, then why in a clause ("Secret Power: its added effect depends on where the battle takes
 * place, which the planner doesn't know"); the other notes are whole sentences. An entry nothing recognises is said
 * generally, never as the developer text.
 */
export function plainUnmodelled(entries: readonly string[]): string[] {
  return entries.map(plainEntry);
}
