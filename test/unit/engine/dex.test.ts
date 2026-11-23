import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildMoves, type KaizoMove } from '../../../src/battle/moves.js';
import { loadLocalData } from '../../../src/data/load.js';
import { engineEffect } from '../../../src/engine/effects.js';
import {
  abilityId, installedData, installedMoves, installKaizoDex, itemId, KAIZO_FORMAT, KAIZO_MOD, moveId, pokedexWeightKg, showdownMoveData, speciesId,
} from '../../../src/engine/dex.js';
import { existsSync, readFileSync } from 'node:fs';
import { LAST_SPECIES } from '../../../src/engine/ids.js';
import { FORMS } from '../../../src/rom/forms.js';
import { FIXTURE_MOVES, fixtureDex, ID } from './fixtures.js';

const { Battle, Dex, toID } = PS;

const fixture = fixtureDex();
const kaizoMove = (id: number): KaizoMove => fixture.moves.get(id)!;
const mod = () => Dex.mod(KAIZO_MOD);
const dexMove = (id: number) => mod().moves.get(moveId(kaizoMove(id)));
const BIDOOF_STATS = { hp: 101, atk: 102, def: 103, spa: 104, spd: 105, spe: 106 };

/** A level 50 Showdown set: Hardy, 31 IVs, no EVs, no item. */
function set(species: string, ability: string, moves: number[]) {
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  return { name: '', species, ability, item: '', nature: 'Hardy', gender: '', level: 50, evs, ivs, moves: moves.map((id) => moveId(kaizoMove(id))) };
}
/** A battle in the format: Bidoof (Water Ball, Fire Ball, Solar-Beam) against Monferno (Ember). */
function fixtureBattle() {
  const battle = new Battle({ formatid: toID(KAIZO_FORMAT), seed: '1,2,3,4' });
  battle.setPlayer('p1', { name: 'Player', team: [set(speciesId(399, 0), 'Swift Swim', [4, 30, 130])] });
  battle.setPlayer('p2', { name: 'Trainer', team: [set(speciesId(391, 0), 'Blaze', [52])] });
  return battle;
}

it('keeps no data before an install', () => {
  expect(() => installedData()).toThrow(/installKaizoDex/);
});

describe('the platkaizo dex', () => {
  beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

  it('species and forms use their own ROM Personal rows; Castform\'s weather forms keep the types the battle gives them', () => {
    expect(mod().species.get(speciesId(399, 0))).toMatchObject({ baseStats: BIDOOF_STATS, types: ['Water', 'Dragon'], abilities: { 0: 'Swift Swim', 1: 'Levitate' } });
    expect(mod().species.get(speciesId(391, 0)).abilities).toEqual({ 0: 'Blaze' }); // the ROM gives Blaze twice
    expect(speciesId(386, 1)).toBe('deoxysattack');
    expect(mod().species.get('deoxysattack')).toMatchObject({ baseStats: { hp: 90, atk: 200, def: 20, spa: 200, spd: 20, spe: 150 }, abilities: { 0: 'Magic Guard' } });
    expect(mod().species.get('deoxys').baseStats).toEqual({ hp: 90, atk: 150, def: 70, spa: 150, spd: 70, spe: 150 });
    expect(mod().species.get(speciesId(351, 1))).toMatchObject({ id: 'castformsunny', baseStats: { hp: 70, atk: 70, def: 75, spa: 110, spd: 75, spe: 100 }, types: ['Fire'] });
    expect(mod().species.get('castform').types).toEqual(['Normal']);
  });

  it('every species and form has a Showdown species; a form a species lacks throws', () => {
    const missing: string[] = [];
    for (let species = 1; species <= 493; species++) {
      for (let form = 0; form < (FORMS[species]?.length ?? 1); form++) {
        const found = mod().species.get(speciesId(species, form));
        if (!found.exists || found.num !== species) missing.push(`${species}/${form} ${speciesId(species, form)}`);
      }
    }
    expect(missing).toEqual([]);
    expect(() => speciesId(25, 1)).toThrow(/form 1/);
  });

  it('moves take the hack\'s numbers: accuracy 0 always hits, the ROM effect chance (none at 0), and IDs past aliases and a shared ID', () => {
    const rom = FIXTURE_MOVES.get(4)!;
    expect([moveId(kaizoMove(4)), moveId(kaizoMove(30)), moveId(kaizoMove(76)), moveId(kaizoMove(130))]).toEqual(['waterball', 'fireball', 'solarbeam', 'solarbeam130']);
    expect(mod().moves.get('waterball')).toMatchObject({ id: 'waterball', num: 4, name: 'Water Ball', type: 'Water', category: 'Special', basePower: 100, accuracy: rom.accuracy, pp: rom.pp, priority: 0 });
    expect(mod().moves.get('fireball')).toMatchObject({ id: 'fireball', num: 30, name: 'Fire Ball', type: 'Fire', basePower: 100 }); // past Showdown's alias to G-Max Fireball
    expect(mod().moves.get('solarbeam')).toMatchObject({ id: 'solarbeam', num: 76, name: 'SolarBeam', pp: 10 });
    expect(mod().moves.get('solarbeam130')).toMatchObject({ id: 'solarbeam130', num: 130, name: 'Solar-Beam (130)', pp: 15 });
    expect(dexMove(73).accuracy).toBe(true); // Leech Seed; Showdown's has 90
    expect(dexMove(212)).toMatchObject({ accuracy: true, priority: 1 }); // Mean Look
    expect([dexMove(59).secondaries, dexMove(52).secondaries, dexMove(132).secondaries ?? null])
      .toEqual([[{ chance: 20, status: 'frz' }], [{ chance: 10, status: 'brn' }], null]); // Blizzard, Ember, Constrict
  });

  it('the format survives fromJSON, and has no clauses and no team preview', () => {
    const restored = Battle.fromJSON(JSON.stringify(fixtureBattle().toJSON()));
    expect([restored.format.id, restored.dex === mod()]).toEqual([KAIZO_FORMAT, true]);
    expect(restored.p1.pokemon[0]!.species).toMatchObject({ baseStats: BIDOOF_STATS, types: ['Water', 'Dragon'] });
    expect(restored.p1.pokemon[0]!.moveSlots.map((slot) => slot.id)).toEqual(['waterball', 'fireball', 'solarbeam130']);
    expect(restored.p2.pokemon[0]!.species.baseStats).toEqual({ hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 });
    const format = Dex.formats.get(KAIZO_FORMAT);
    expect(format).toMatchObject({ id: KAIZO_FORMAT, mod: KAIZO_MOD, gameType: 'singles', exists: true });
    expect([...Dex.formats.getRuleTable(format).keys()]).toEqual([]); // no sleep, species, OHKO or evasion clause
    const battle = fixtureBattle();
    expect([battle.requestState, battle.turn]).toEqual(['move', 1]);
  });

  it('ability and item IDs are Showdown\'s, by ROM number', () => {
    expect([abilityId(66), abilityId(0), itemId(220), itemId(0)]).toEqual(['blaze', '', 'choiceband', '']);
    const wrong: string[] = [];
    for (let id = 1; id <= 123; id++) {
      const ability = mod().abilities.get(abilityId(id));
      if (!ability.exists || ability.num !== id) wrong.push(`ability ${id} ${abilityId(id)}`);
    }
    // Every item the name index names (it leaves out the items that do nothing in battle, such as Potion).
    for (let id = 1; id <= 536; id++) {
      if (fixture.data.names.item(id).startsWith('(')) continue;
      const item = mod().items.get(itemId(id));
      if (!item.exists || item.num !== id) wrong.push(`item ${id} ${itemId(id)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('install is idempotent; new data replaces the mod and the data it keeps', () => {
    const installed = mod();
    installKaizoDex(fixture.data, fixture.moves);
    expect([mod() === installed, installedData() === fixture.data, installedMoves() === fixture.moves]).toEqual([true, true, true]);
    const other = fixtureDex();
    other.data.rom.species[399]!.baseStats.hp = 1;
    try {
      installKaizoDex(other.data, other.moves);
      expect([mod() === installed, mod().species.get('bidoof').baseStats.hp, installedData() === other.data, installedMoves() === other.moves]).toEqual([false, 1, true, true]);
    } finally {
      installKaizoDex(fixture.data, fixture.moves);
    }
  });
});

// The ROM's Pokédex weights, which Low Kick and Grass Knot read, against the trainer AI's cache of the ROM's tables (local only).
const aiCache = 'data/rom/trainer-ai.json';
it.skipIf(!existsSync(aiCache))(`every species and form weighs its species ID's entry of the ROM's tables (${aiCache})`, () => {
  const { weights, formWeights } = JSON.parse(readFileSync(aiCache, 'utf8')) as { weights: number[]; formWeights: number[] };
  const differences: string[] = [];
  let compared = 0;
  for (let species = 1; species <= LAST_SPECIES; species++) {
    for (let form = 0; form < (FORMS[species]?.length ?? 1); form++) {
      const id = speciesId(species, form);
      if (!Dex.mod('gen4').species.get(id).exists) continue;
      compared++;
      const rom = (form === 0 ? weights : formWeights)[species];
      if (Math.round(pokedexWeightKg(id) * 10) !== rom) differences.push(`${id}: ${pokedexWeightKg(id) * 10} hg, the ROM's ${rom}`);
    }
  }
  expect(compared).toBeGreaterThan(LAST_SPECIES);
  expect(differences).toEqual([]);
});

// Every hack move's dex entry names the behaviour source the engine runs (for the native engine).
describe('kaizoBehaviour', () => {
  beforeAll(() => installKaizoDex(fixture.data, fixture.moves));
  /** What the effect table runs: an `inherit` entry's source, or a table or unmodelled move's `calc.baseMove`. */
  const runs = (move: KaizoMove): [string, string] => {
    const effect = engineEffect(move);
    return effect.kind === 'inherit' ? ['inherit', effect.from] : [effect.kind === 'unmodelled' ? 'unmodelled' : 'table', toID(move.calc.baseMove)];
  };
  const behaviourOf = (data: unknown) => {
    const { kaizoBehaviourKind, kaizoBehaviour } = data as { kaizoBehaviour?: unknown; kaizoBehaviourKind?: unknown };
    return [kaizoBehaviourKind, kaizoBehaviour];
  };

  it('every installed hack move carries both as plain string fields, read through Showdown\'s Dex', () => {
    for (const move of installedMoves().values()) expect([move.id, ...behaviourOf(mod().moves.get(moveId(move)))]).toEqual([move.id, ...runs(move)]);
    // Where it differs from the calc's base: binding runs Wrap, Detect Protect, Whirlwind Roar; Future Sight is unmodelled and still runs.
    expect([ID.wrap, ID.detect, ID.whirlwind, ID.tackle, ID.futureSight].map((id) => behaviourOf(dexMove(id))))
      .toEqual([['inherit', 'wrap'], ['inherit', 'protect'], ['inherit', 'roar'], ['table', 'tackle'], ['unmodelled', 'futuresight']]);
  });

  it.skipIf(!existsSync('data/docs/Moves.csv'))('every real hack move carries both too (data/)', () => {
    for (const move of buildMoves(loadLocalData('data')).values()) expect([move.id, ...behaviourOf(showdownMoveData(move))]).toEqual([move.id, ...runs(move)]);
  });
});
