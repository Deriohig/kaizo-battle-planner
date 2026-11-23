// What the line builder shows of an engine state (`LineViewJson`, src/contracts/api.ts): both sides' Pokémon in team
// order with their HP, status, stat stages, item and ability, each side's active Pokémon, and the field. Read from the
// state's Showdown battle (`restore`), omniscient: the player is planning, so the trainer's item and ability show as they are.
// The trainer's HP percent is its HP bar's (48 pixels, `barPixels` in engine/observe.ts), which is all the game shows of it.
// The dex must be installed (`installKaizoDex`; `baseDeps` does it).

import type { KaizoMove } from '../battle/moves.js';
import type { LineMonJson, LineSideJson, LineViewJson } from '../contracts/api.js';
import type { EngineState, Side } from '../contracts/engine.js';
import { barPixels, battleField, restore } from '../engine/index.js';
import { buildLookups, type Lookups } from '../integration/battleView.js';
import { spriteFormOf } from '../sprites/forms.js';

const STATUS: Record<string, string> = { brn: 'burned', par: 'paralysed', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep', frz: 'frozen' };
const WEATHER: Record<string, string> = { raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sandstorm', hail: 'Hail' };
const PSEUDO: Record<string, string> = { trickroom: 'Trick Room', gravity: 'Gravity' };
const SIDE_CONDITION: Record<string, string> = {
  reflect: 'Reflect', lightscreen: 'Light Screen', safeguard: 'Safeguard', mist: 'Mist', tailwind: 'Tailwind', luckychant: 'Lucky Chant',
  spikes: 'Spikes', toxicspikes: 'Toxic Spikes', stealthrock: 'Stealth Rock',
};
const STAGES = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** `pokemon`'s sprite form (sprites/forms.ts `spriteFormOf`), as `formId` when it has one. */
function formOf(pokemon: Pokemon): Pick<LineMonJson, 'formId'> {
  const form = spriteFormOf(pokemon.species.num, pokemon.species.forme);
  return form === undefined ? {} : { formId: form };
}

/** The view function over the hack's moves (`buildMoves`): moves by the hack's names, as the labeler names them. */
export function createLineView(moves: ReadonlyMap<number, KaizoMove>): (state: EngineState, labels: readonly string[]) => LineViewJson {
  let lookups: Lookups | null = null;

  function monOf(battle: Battle, side: Side, pokemon: Pokemon, label: string | undefined, withMoves: boolean): LineMonJson {
    const maxHp = pokemon.maxhp;
    const fainted = pokemon.fainted || pokemon.hp <= 0;
    const percent = side === 'p2' ? (barPixels(pokemon.hp, maxHp) * 100) / 48 : (pokemon.hp * 100) / maxHp;
    const boosts: Record<string, string> = {};
    for (const stat of STAGES) {
      const stage = pokemon.boosts[stat];
      if (stage !== 0) boosts[stat] = stage > 0 ? `+${stage}` : String(stage);
    }
    const mon: LineMonJson = {
      ident: pokemon.name, name: label ?? pokemon.name, species: pokemon.species.name, speciesId: pokemon.species.num,
      ...formOf(pokemon), level: pokemon.level, hp: pokemon.hp, maxHp,
      percent: round1(percent), status: fainted ? null : STATUS[pokemon.status] ?? null, boosts,
      item: pokemon.item === '' ? null : battle.dex.items.get(pokemon.item).name,
      ability: battle.dex.abilities.get(pokemon.ability).name, fainted, active: pokemon.isActive,
    };
    if (withMoves) {
      lookups ??= buildLookups(moves);
      mon.moves = pokemon.moveSlots.map((slot) => ({ name: lookups!.byId.get(slot.id)?.name ?? slot.move, pp: slot.pp, maxPp: slot.maxpp }));
    }
    return mon;
  }

  function sideOf(battle: Battle, side: Side, labels: readonly string[]): LineSideJson {
    const { team, pokemon, active } = battle[side];
    const party = team.map((set, i) => {
      const member = pokemon.find((p) => p.set === set);
      if (member === undefined) throw new Error(`lineView: no ${side} Pokémon for team slot ${i}`);
      return monOf(battle, side, member, side === 'p1' ? labels[i] : undefined, side === 'p1' && active[0] === member);
    });
    const out = active[0];
    return { active: out === undefined || out === null ? null : party[team.indexOf(out.set)] ?? null, party };
  }

  const conditions = (battle: Battle, side: Side): string[] => Object.entries(battle[side].sideConditions).map(([id, state]) => {
    const name = SIDE_CONDITION[id] ?? id;
    const layers = (state as { layers?: number }).layers;
    return layers !== undefined && layers > 1 ? `${name} x${layers}` : name;
  });

  return (state, labels) => {
    const battle = restore(state);
    const shared = Object.keys(battle.field.pseudoWeather).map((id) => PSEUDO[id] ?? id);
    if (battleField(state).fog === true) shared.push('Deep fog');
    return {
      player: sideOf(battle, 'p1', labels), enemy: sideOf(battle, 'p2', labels),
      field: {
        weather: battle.field.weather === '' ? null : WEATHER[battle.field.weather] ?? battle.field.weather,
        conditions: shared, player: conditions(battle, 'p1'), enemy: conditions(battle, 'p2'),
      },
    };
  };
}
