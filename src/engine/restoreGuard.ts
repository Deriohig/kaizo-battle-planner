// A guard on Showdown's restore of a Transformed Pokémon with more moves of its own than it copied. Installed once, when this module loads: engine/dex.ts imports it, as every restore needs the mod's format,
// which dex.ts registers when it loads.
//
// `State.deserializePokemon` (pokemon-showdown sim/state.ts; dist/sim/state.js:196-213) rebuilds `baseMoveSlots` from the
// JSON. For each index it reads `pokemon.moveSlots[i].id`, and when the IDs match and that slot is not a virtual copy it
// puts the move slot in place of the base slot, so the two lists share their objects as a live battle's do. With more base
// slots than move slots that read throws ("Cannot read properties of undefined (reading 'id')"). That is a Transformed
// Pokémon with more moves of its own than the copy:
// - on the trainer's side, a Transform user with more moves than the Pokémon of the player's it copies (the hack's Smeargle:
//   Transform and three other moves);
// - on the player's side, a Transformed Pokémon that learns a move into a free slot of its own (levelUp.ts `applyLevel`; the
//   cartridge's reload leaves a Transformed battler's moves alone, battle_lib.c:183-190).
// The live battle holds such a Pokémon without trouble: the copied slots are virtual, so no base slot shares an object with
// them.
//
// The guard runs Showdown's own function on the base slots the copy covers. It then appends the rest as read from the JSON,
// shared with nothing, as the live battle holds them. A Pokémon with no more base slots than move slots goes straight to
// Showdown's function, so every state that restored before restores to the same battle. A state that threw now restores to
// the live one (test/unit/engine/restoreGuard.test.ts). facts.ts `restoredBaseSlots` mirrors it.

import ShowdownState from 'pokemon-showdown/dist/sim/state.js';

const { State } = ShowdownState;

/** Marks Showdown's `State` once guarded, so a second load of this module (a test runner's) wraps nothing twice. */
const GUARDED = Symbol.for('plat-kaizo-planner.restoreGuard');

type Guardable = typeof State & { [GUARDED]?: true };

const state = State as Guardable;
if (state[GUARDED] !== true) {
  const deserializePokemon = State.deserializePokemon;
  State.deserializePokemon = function guardedDeserializePokemon(this: typeof State, json: AnyObject, pokemon: Pokemon): void {
    const base = json['baseMoveSlots'] as unknown[] | undefined;
    const copied = (json['moveSlots'] as unknown[] | undefined)?.length ?? 0;
    if (base === undefined || base.length <= copied) {
      deserializePokemon.call(this, json, pokemon);
      return;
    }
    deserializePokemon.call(this, { ...json, baseMoveSlots: base.slice(0, copied) }, pokemon);
    pokemon.baseMoveSlots.push(...(this.deserializeWithRefs(base.slice(copied), pokemon.battle) as Pokemon['baseMoveSlots']));
  };
  state[GUARDED] = true;
}
