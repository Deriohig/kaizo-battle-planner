// The trainer's field conditions at battle start, as the cartridge's overworld weather (bl:3649-3711, read once before the
// leads' abilities): rain, hail, sand and sun permanent with no turn count; fog the deep fog. The hack's map weathers 12,
// 17 and 18 are Gravity, sun and Trick Room, and its subscripts 238 and 251 re-arm Gravity and Trick Room, so both last.
// A weather ability replaces the weather unless it is that weather already permanent (:3740-3780).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, FieldSpec } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import * as engine from '../../../src/engine/index.js';
import { cartridgeHitRate } from '../../../src/engine/mod/accuracy.js';
import { FIELD_COMBINATION_NOTE, FOG_KEY } from '../../../src/engine/mod/field.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const base = fixtureDex();
beforeAll(() => installKaizoDex(base.data, base.moves));
afterAll(() => installKaizoDex(base.data, base.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const SOLARBEAM = 76;

/** Monferno (L30, Growl or `mine`) against Zigzagoon (L20), under `field`, with the trainer's ability if given. */
function battle(field: FieldSpec, fields: { mine?: number[]; ability?: number; item?: number; hp?: number } = {}): BattleInput {
  return {
    player: [playerMon(ID.monferno, 30, fields.mine ?? [ID.growl], fields.hp === undefined ? {} : { currentHp: fields.hp })],
    trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.growl], fields.item === undefined ? {} : { item: fields.item })]),
    field, ...(fields.ability === undefined ? {} : { world: { enemy: [{ ability: fields.ability }] } }),
  };
}
const start = (field: FieldSpec, fields: Parameters<typeof battle>[1] = {}) => createBattle(battle(field, fields));
const fieldOf = (state: EngineState) => restore(state).field;
const weatherOf = (state: EngineState) => ({ id: fieldOf(state).weather as string, duration: fieldOf(state).weatherState['duration'] as number | undefined });
const permanent = (id: string) => ({ id, duration: 0 });
const weatherLines = (state: EngineState) => engine.battleStartLog(state).filter((line) => line.startsWith('|-weather|'));
/** `turns` turns on from `state`, each the first outcome. */
function advance(state: EngineState, turns: number, choices: { p1?: Choice; p2?: Choice } = BOTH_FIRST): EngineState {
  for (let i = 0; i < turns; i++) state = runFirstOutcome(state, choices);
  return state;
}
/** Tackle's hit rate from the player's active Pokémon in `state`. */
const rate = (state: EngineState): number | true => {
  const restored = restore(state);
  return cartridgeHitRate(restored.p1.active[0]!, restored.p2.active[0]!, restored.dex.getActiveMove('tackle'), restored);
};
const fogged = (state: EngineState): boolean => (JSON.parse(state.json) as { formatData: Record<string, unknown> }).formatData[FOG_KEY] === true;

describe('field weather (the overworld weather: permanent, no end turn)', () => {
  it.each([['rain', 'raindance', 'RainDance'], ['sun', 'sunnyday', 'SunnyDay'], ['sand', 'sandstorm', 'Sandstorm'], ['hail', 'hail', 'Hail']] as const)(
    'a %s note starts it permanently, with a plain |-weather| line, still up 8 turns on', (weather, id, name) => {
      const state = start({ weather });
      expect([weatherOf(state), weatherLines(state), weatherOf(advance(state, 8))]).toEqual([permanent(id), [`|-weather|${name}`], permanent(id)]);
    },
  );

  it('no weather note, no weather', () => {
    expect([weatherOf(start({})).id, weatherLines(start({}))]).toEqual(['', []]);
  });

  it('a weather ability replaces another field weather; the same weather\'s ability changes nothing (:3740-3780)', () => {
    expect(([[ABILITY.drought, 'rain'], [ABILITY.drizzle, 'rain'], [ABILITY.sandStream, 'hail'], [ABILITY.snowWarning, 'hail']] as const)
      .map(([ability, weather]) => weatherOf(start({ weather }, { ability }))))
      .toEqual([permanent('sunnyday'), permanent('raindance'), permanent('sandstorm'), permanent('hail')]);
    expect(engine.battleStartLog(start({ weather: 'rain' }, { ability: ABILITY.drizzle })).some((line) => line.includes('ability: Drizzle'))).toBe(false);
  });

  it('Rain Dance fails under permanent rain; Hail starts five turns of hail under permanent hail (effect_script_0164.s:5)', () => {
    expect(weatherOf(advance(start({ weather: 'rain' }, { mine: [ID.rainDance] }), 1))).toEqual(permanent('raindance'));
    expect(weatherOf(advance(start({ weather: 'hail' }, { mine: [ID.hail] }), 1))).toEqual({ id: 'hail', duration: 4 });
  });

  it('the weather survives every outcome of a turn', () => {
    for (const outcome of expandTurn(start({ weather: 'sand' }, { item: ITEM.leftovers }), BOTH_FIRST)) expect(weatherOf(outcome.state)).toEqual(permanent('sandstorm'));
  });
});

describe('fog (FIELD_CONDITION_DEEP_FOG)', () => {
  it('fog lowers accuracy x 6 / 10 (bcp:2935-2937), but not past Cloud Nine or Air Lock (:2923); it is no weather and lasts', () => {
    expect([start({}), start({ fog: true }), start({ fog: true }, { ability: ABILITY.cloudNine }), start({ fog: true }, { ability: ABILITY.airLock })].map(rate))
      .toEqual([100, 60, 100, 100]);
    expect([weatherOf(start({ fog: true })).id, rate(advance(start({ fog: true }), 8))]).toEqual(['', 60]);
  });

  // FIELD_CONDITION_WEATHER includes the fog bit: every weather move and ability clears it as it sets its weather; Defog clears it too.
  it.each([ID.rainDance, ID.sunnyDay, ID.sandstorm, ID.hail])('weather move %i ends it: the next move\'s hit rate is 100 again', (weatherMove) => {
    const state = start({ fog: true }, { mine: [weatherMove] });
    expect(rate(state)).toBe(60);
    for (const outcome of expandTurn(state, BOTH_FIRST)) expect([fogged(outcome.state), rate(outcome.state)]).toEqual([false, 100]);
  });

  it('a weather ability at switch-in ends it; Cloud Nine does not (the fog only stops counting while it is out)', () => {
    for (const ability of [ABILITY.drizzle, ABILITY.drought, ABILITY.sandStream, ABILITY.snowWarning]) {
      expect([fogged(start({ fog: true }, { ability })), rate(start({ fog: true }, { ability }))]).toEqual([false, 100]);
    }
    expect(fogged(start({ fog: true }, { ability: ABILITY.cloudNine }))).toBe(true);
  });

  it('Defog blows it away, with its line; the next hit rate is 133 (its evasion drop), not 79', () => {
    const outcomes = expandTurn(start({ fog: true }, { mine: [ID.defog] }), BOTH_FIRST);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(outcome.log).toContain('|-fieldend|Deep Fog|[from] move: Defog|[of] p1a: Monferno');
      expect([fogged(outcome.state), rate(outcome.state)]).toEqual([false, 133]);
    }
  });

  it('SolarBeam after Sunny Day replaced the fog: no charge turn and full power, as in sun with no fog (bl:7058)', () => {
    const solarBeamDamage = (field: FieldSpec): string[] => {
      const outcomes = expandTurn(runFirstOutcome(start(field, { mine: [ID.sunnyDay, SOLARBEAM] }), BOTH_FIRST), { p1: move(1), p2: move(0) });
      for (const outcome of outcomes) expect(outcome.log.some((line) => line.startsWith('|-damage|p2a: Zigzagoon|'))).toBe(true);
      return [...new Set(outcomes.flatMap((outcome) => outcome.log).filter((line) => line.startsWith('|-damage|p2a: Zigzagoon|')))].sort();
    };
    expect(solarBeamDamage({ fog: true })).toEqual(solarBeamDamage({}));
  });

  it('Weather Ball in fog: double power (bs:6847-6850), its type unchanged (bl:7894-7911)', () => {
    const power = (field: FieldSpec) => {
      const restored = restore(start(field, { mine: [ID.weatherBall] }));
      const user = restored.p1.active[0]!;
      const active = restored.dex.getActiveMove(user.moveSlots[0]!.id);
      const handlers = active as unknown as Record<'onModifyType' | 'onModifyMove', (this: Battle, move: ActiveMove, pokemon: Pokemon, target: Pokemon) => void>;
      handlers.onModifyType.call(restored, active, user, restored.p2.active[0]!); // as Showdown's `useMove` runs them
      handlers.onModifyMove.call(restored, active, user, restored.p2.active[0]!);
      return { power: active.basePower, type: active.type };
    };
    expect([power({}), power({ fog: true }), power({ fog: true, weather: 'rain' }).type]).toEqual([{ power: 50, type: 'Normal' }, { power: 100, type: 'Normal' }, 'Water']);
  });

  it('Synthesis and Moonlight heal a quarter of the max HP in fog (bs:5970-5976), half without', () => {
    const maxhp = restore(start({})).p1.active[0]!.maxhp;
    const healed = (healing: number, field: FieldSpec) => restore(expandTurn(start(field, { mine: [healing], hp: 1 }), BOTH_FIRST)[0]!.state).p1.active[0]!.hp - 1;
    for (const healing of [ID.synthesis, ID.moonlight]) expect([healed(healing, {}), healed(healing, { fog: true })]).toEqual([Math.floor(maxhp / 2), Math.floor(maxhp / 4)]);
  });

  it('Synthesis and Moonlight at full HP, fog or none: "HP is full!", as Roost (subscript_recover_hp.s:5-6, :22-28)', () => {
    const atFullHp = (healing: number, field: FieldSpec) => {
      const outcomes = expandTurn(start(field, { mine: [healing] }), BOTH_FIRST);
      expect(outcomes.length).toBeGreaterThan(0);
      return [...new Set(outcomes.map((outcome) => JSON.stringify({
        fail: outcome.log.filter((line) => line.startsWith('|-fail|p1a: Monferno')), lastResult: restore(outcome.state).p1.active[0]!.moveLastTurnResult,
      })))];
    };
    const roost = JSON.stringify({ fail: ['|-fail|p1a: Monferno|heal'], lastResult: false });
    expect(atFullHp(ID.roost, {})).toEqual([roost]);
    for (const healing of [ID.synthesis, ID.moonlight]) for (const field of [{}, { fog: true }]) expect(atFullHp(healing, field)).toEqual([roost]);
  });
});

describe('Trick Room and Gravity (re-armed by subscripts 251 and 238)', () => {
  it('Trick Room is up from the start and never ends; the slower Zigzagoon moves first in it', () => {
    const state = start({ trickRoom: true });
    expect(fieldOf(state).pseudoWeather['trickroom']!['duration']).toBe(0);
    expect(engine.battleStartLog(state).filter((line) => line.startsWith('|-fieldstart|'))).toEqual(['|-fieldstart|move: Trick Room']);
    const outcomes = expandTurn(state, BOTH_FIRST);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect(outcome.log.find((line) => line.startsWith('|move|'))).toMatch(/^\|move\|p2a: Zigzagoon\|/);
    expect(fieldOf(advance(state, 8)).pseudoWeather['trickroom']).toBeDefined();
    // The Trick Room move still ends it: it toggles (effect_script_0259.s:3, :14).
    expect(fieldOf(advance(start({ trickRoom: true }, { mine: [ID.trickRoom] }), 1)).pseudoWeather['trickroom']).toBeUndefined();
  });

  it('a Gravity or Trick Room move never ends either: the expiry subscript re-arms whatever set it (bcp:1226-1235, :1822-1830)', () => {
    for (const [moveId, id] of [[ID.gravity, 'gravity'], [ID.trickRoom, 'trickroom']] as const) {
      const set = runFirstOutcome(start({}, { mine: [moveId, ID.growl] }), BOTH_FIRST);
      expect(fieldOf(set).pseudoWeather[id]!['duration'], id).toBe(0);
      expect(fieldOf(advance(set, 8, { p1: move(1), p2: move(0) })).pseudoWeather[id], id).toBeDefined();
    }
  });

  it('Gravity is up from the start and never ends, and raises accuracy x 10 / 6 (bcp:2972-2974)', () => {
    const state = start({ gravity: true });
    expect(fieldOf(state).pseudoWeather['gravity']!['duration']).toBe(0);
    expect(engine.battleStartLog(state)).toContain('|-fieldstart|move: Gravity');
    const later = advance(state, 8);
    expect([fieldOf(later).pseudoWeather['gravity'] !== undefined, rate(later)]).toEqual([true, 166]);
  });
});

describe('the field in the state', () => {
  it('battleField(state) gives the stored note (empty for none), and the state keeps it for the trainer AI', () => {
    expect([engine.battleField(start({})), engine.battleField(start({ weather: 'sand', fog: false })), engine.battleField(advance(start({ trickRoom: true }), 2))])
      .toEqual([{}, { weather: 'sand', fog: false }, { trickRoom: true }]);
  });

  it('a field note is no longer unmodelled; two overworld weathers at once are (the map holds one)', () => {
    for (const field of [{ weather: 'rain' }, { fog: true }, { trickRoom: true }, { gravity: true }] as const) expect(engine.unmodelledIn(start(field))).toEqual([]);
    for (const field of [{ weather: 'rain', fog: true }, { trickRoom: true, gravity: true }] as const) expect(engine.unmodelledIn(start(field))).toEqual([FIELD_COMBINATION_NOTE]);
  });
});
