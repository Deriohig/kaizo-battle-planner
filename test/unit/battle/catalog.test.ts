import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { buildPkcalcDex, type PkcalcData, type PkcalcSet } from '../../../src/check/pkcalc.js';
import { docMon, docSpecies, docTrainer, loadedData, romSpecies, romTrainer, trainerMon } from '../../fixtures/loadedData.js';

// Roark Split: Youngster Tristan (ROM 1), two "Barry #2" teams (ROM 2 and 3), a two-trainer gauntlet in Oreburgh Mine
// (ROM 4 and 5), and Maid Yoki, whose party no ROM trainer has. Gardenia Split: the player's tag partner Cheryl (ROM 6),
// and Galactic Mercury, a double battle with two identical ROM copies (ROM 7 and 8).
const mine = { location: 'Oreburgh Mine' };
const gauntlet = (end: 'start' | 'end') => ({ ...mine, tags: { gauntlet: end, starred: false, raw: [`Gauntlet ${end === 'start' ? 'Start' : 'End'}`] } });
const catalog = buildCatalog(loadedData({
  species: [romSpecies(16), romSpecies(19), romSpecies(161), romSpecies(263)],
  trainers: [
    romTrainer(1, [trainerMon(263, 5)]), romTrainer(2, [trainerMon(16, 9)]), romTrainer(3, [trainerMon(16, 10)]), romTrainer(4, [trainerMon(19, 7)]),
    romTrainer(5, [trainerMon(19, 8)]), romTrainer(6, [trainerMon(16, 20)]), romTrainer(7, [trainerMon(263, 15)], { battleType: 2 }), romTrainer(8, [trainerMon(263, 15)], { battleType: 2 }),
  ],
  docSpecies: [docSpecies(16, 'PIDGEY'), docSpecies(19, 'RATTATA'), docSpecies(161, 'SENTRET'), docSpecies(263, 'ZIGZAGOON')],
  docTrainers: [
    docTrainer('Roark Split', 'Youngster Tristan', 0, [docMon('Zigzagoon', 5)]), docTrainer('Roark Split', 'Barry #2', 1, [docMon('Pidgey', 9)]),
    docTrainer('Roark Split', 'Barry #2', 2, [docMon('Pidgey', 10)]), docTrainer('Roark Split', 'Worker Mason', 3, [docMon('Rattata', 7)], gauntlet('start')),
    docTrainer('Roark Split', 'Worker Colin', 4, [docMon('Rattata', 8)], gauntlet('end')), docTrainer('Roark Split', 'Maid Yoki', 5, [docMon('Sentret', 67)], mine),
    docTrainer('Gardenia Split', 'Trainer Cheryl', 0, [docMon('Pidgey', 20)], { tags: { playerPartner: true, starred: false, raw: ['TAG PARTNER'] } }),
    docTrainer('Gardenia Split', 'Galactic Mercury', 1, [docMon('Zigzagoon', 15)]),
  ],
}));

describe('buildCatalog', () => {
  it('lists the matched opponents in docs order, leaving out player partners and trainers with no ROM match, and the gauntlets', () => {
    expect(catalog.trainers.map((trainer) => [trainer.id, trainer.romIndex])).toEqual([
      ['roark-split/youngster-tristan/1', 1], ['roark-split/barry-2/1', 2], ['roark-split/barry-2/2', 3],
      ['roark-split/worker-mason/1', 4], ['roark-split/worker-colin/1', 5], ['gardenia-split/galactic-mercury/1', 8]]);
    expect(catalog.gauntlets).toEqual([{
      id: 'roark-split/oreburgh-mine/gauntlet-1', name: 'Oreburgh Mine: Worker Mason to Worker Colin', trainerIds: ['roark-split/worker-mason/1', 'roark-split/worker-colin/1'],
    }]);
  });

  it('keeps a player partner reachable by ID, and a shared ROM copy as a variant of its docs trainer', () => {
    expect(catalog.byId('gardenia-split/trainer-cheryl/1')).toMatchObject({ name: 'Trainer Cheryl', romIndex: 6, tags: { playerPartner: true } });
    expect(catalog.byId('roark-split/youngster-tristan/1')).toBe(catalog.trainers[0]);
    expect(catalog.byId('roark-split/maid-yoki/1')).toBeUndefined();
    const mercury = catalog.byId('gardenia-split/galactic-mercury/1')!;
    expect([mercury.romIndex, mercury.battleType, mercury.variants.map((variant) => variant.romIndex)]).toEqual([8, 'double', [7]]);
  });

  it.each([
    ['tristan', ['roark-split/youngster-tristan/1']], ['Barry #2', ['roark-split/barry-2/1', 'roark-split/barry-2/2']],
    ['gardenia mercury', ['gardenia-split/galactic-mercury/1']], ['roark-split/barry-2/2', ['roark-split/barry-2/2']], ['cheryl', []], ['   ', []],
  ])('finds trainers by words of their name, split or location, or by ID: "%s"', (query, ids) => expect(catalog.search(query).map((trainer) => trainer.id)).toEqual(ids));
});

describe('buildCatalog: docs natures against PKCalc\'s', () => {
  // Tristan with an override on his first Pokémon, so the ROM knows neither nature; the docs give Hasty (11) and Hardy
  // (0), PKCalc's sets Jolly (13) and Hardy.
  const base = loadedData({
    species: [romSpecies(16), romSpecies(263)],
    trainers: [romTrainer(1, [trainerMon(263, 5, { natureKnown: false, abilityOverride: 1 }), trainerMon(16, 5, { natureKnown: false })])],
    docSpecies: [docSpecies(16, 'PIDGEY'), docSpecies(263, 'ZIGZAGOON')],
    docTrainers: [docTrainer('Roark Split', 'Youngster Tristan', 0, [docMon('Zigzagoon', 5, { nature: 'Hasty' }), docMon('Pidgey', 5)])],
  });
  const set = (nature: string): PkcalcSet => ({ ability: 'Gluttony', gender: 'Male', ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 }, level: 5, moves: ['Tackle'], nature });
  const dexEntry = (num: number, name: string) => [name.toLowerCase(), { num, id: name.toLowerCase(), name }] as const;
  const pkcalc: PkcalcData = {
    sets: { Zigzagoon: { 'Youngster Tristan': set('Jolly') }, Pidgey: { 'Youngster Tristan': set('Hardy') } }, aiFlags: {}, partyOrder: { 'Youngster Tristan': ['Zigzagoon', 'Pidgey'] },
    dex: buildPkcalcDex({ SPECIES: Object.fromEntries([dexEntry(263, 'Zigzagoon'), dexEntry(16, 'Pidgey')]), MOVES: {}, ITEMS: {}, ABILITIES: {} }),
  };
  const natures = (data: typeof base) => buildCatalog(data).trainers[0]!.party.map((mon) => mon.nature);
  const others = (own: number) => Array.from({ length: 25 }, (_, id) => id).filter((id) => id !== own);

  it('disputes every docs nature, listing PKCalc\'s where it differs, and every other nature without PKCalc\'s data, so the worlds never shrink', () => {
    expect(natures({ ...base, pkcalc })).toEqual([{ value: 11, source: 'docs', disputed: true, alternatives: [13] }, { value: 0, source: 'docs', disputed: true, alternatives: [] }]);
    expect(natures(base)).toEqual([{ value: 11, source: 'docs', disputed: true, alternatives: others(11) }, { value: 0, source: 'docs', disputed: true, alternatives: others(0) }]);
  });
});
