import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { buildMoves, type KaizoMove } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon, ResolvedTrainer } from '../../../src/battle/types.js';
import { damage } from '../../../src/calc/calc.js';
import type { LocalData } from '../../../src/data/load.js';
import { NATURES } from '../../../src/rom/natures.js';
import { buildBox } from '../../../src/server/box.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import { fieldText, type SheetBodyJson as SheetJson, sheetToJson } from '../../../src/server/sheet.js';
import { showdownSet } from '../../../src/server/showdown.js';
import { pickVariant } from '../../../src/server/trainers.js';
import { buildSheet, type StartingHp } from '../../../src/sheet/sheet.js';
import { EMBER, FISSURE, monferno as handMonferno, move, TACKLE, THUNDER, zigzagoon } from '../../fixtures/battleMons.js';
import { stats } from '../../fixtures/loadedData.js';
import { GARDENIA_ID, monferno, SERVER_SAVE, saveFile, serverData, starly, TRISTAN_ID, TWINS_ID } from './fixtures.js';

/** The team of a fixture save (the default one: Mon, party:1, Monferno Lv 15; Starly, party:2; Starly, box:1:1). */
const teamOf = (data: LocalData, file = saveFile()): PlayerMon[] =>
  buildBox({ file, savePath: '/mnt/c/x.dsv', savedAt: new Date('2026-11-08T09:30:00.000Z'), data, settings: DEFAULT_SETTINGS }).team;

/** Copy `variant` of trainer `id`, and how many copies it has. */
function trainerOf(data: LocalData, id: string, variant = 0): { trainer: ResolvedTrainer; variants: number } {
  const resolved = buildCatalog(data).byId(id)!;
  return { trainer: pickVariant(resolved, variant)!, variants: 1 + resolved.variants.length };
}

/** The real sheet, as JSON, for copy `variant` of trainer `id` against a fixture save's team. */
function sheetFor(id: string, opts: { variant?: number; data?: LocalData; hp?: StartingHp; file?: Uint8Array } = {}): SheetJson {
  const { variant = 0, data = serverData() } = opts;
  const { trainer, variants } = trainerOf(data, id, variant);
  const sheet = buildSheet(teamOf(data, opts.file), trainer, { moves: buildMoves(data), ...(opts.hp !== undefined && { hp: opts.hp }) });
  return sheetToJson(sheet, { names: data.names, variant, variants });
}

/** The real sheet, as JSON, for hand-made Pokémon against a hand-made Youngster Tristan; names from the server fixture data. */
function handSheet(team: PlayerMon[], party: ResolvedMon[], moves: KaizoMove[]): SheetJson {
  const trainer: ResolvedTrainer = {
    id: TRISTAN_ID, name: 'Youngster Tristan', split: 'Roark Split', location: 'Route 202', order: 0, romIndex: 1, trainerClass: 2,
    battleType: 'single', aiFlags: [], field: null, tags: { starred: false, raw: [] }, levelMismatch: false, party, variants: [],
  };
  return sheetToJson(buildSheet(team, trainer, { moves: new Map(moves.map((m) => [m.id, m])) }), { names: serverData().names, variant: 0, variants: 1 });
}

const ability = (value: number) => ({ ability: { value, source: 'rom' as const, disputed: false, alternatives: [] } });
const [DRIZZLE, DROUGHT] = [2, 70];
/** A Drought Monferno against a Drizzle Zigzagoon with Thunder: whoever came in last sets the weather. */
const weatherFight = () => handSheet([handMonferno({ ...ability(DROUGHT), moves: [52] })], [zigzagoon({ ...ability(DRIZZLE), moves: [87] })], [TACKLE, EMBER, THUNDER]);
/** Mon at 10 of 44 HP, burned (the party status word's bit 4). */
const HURT = saveFile({ ...SERVER_SAVE, party: [monferno({ currentHp: 10, status: 0x10 }), starly()] });

describe('sheetToJson', () => {
  it('keys the players by MonRef in team order and the enemies by party index, one pair each, players outer; each described in full', () => {
    const data = serverData();
    const sheet = sheetFor(TRISTAN_ID, { data });
    expect([sheet.players.map((mon) => mon.key), sheet.enemies.map((mon) => mon.key), sheet.pairs.map((pair) => `${pair.player} ${pair.enemy}`)]).toEqual([
      ['party:1', 'party:2', 'box:1:1'], ['enemy:0', 'enemy:1'],
      ['party:1 enemy:0', 'party:1 enemy:1', 'party:2 enemy:0', 'party:2 enemy:1', 'box:1:1 enemy:0', 'box:1:1 enemy:1'],
    ]);
    // Starly Lv 5, 31 IVs, Hardy: HP floor(111 × 5 / 100) + 15 = 20; Atk floor(141 × 5 / 100) + 5 = 12; Def, SpA and SpD
    // floor(91 × 5 / 100) + 5 = 9; Spe floor(151 × 5 / 100) + 5 = 12.
    expect([sheet.players[0], sheet.enemies[0]]).toEqual([{
      key: 'party:1', name: 'Monferno', speciesId: 391, nickname: 'Mon', level: 15, nature: 'Impish', ability: 'Blaze', item: 'Quick Claw',
      moves: ['Tackle', 'Ember'], stats: stats(44, 41, 24, 26, 21, 42), hp: 44, status: null, disputed: [], showdown: showdownSet(teamOf(data)[0]!, data.names),
    }, {
      key: 'enemy:0', name: 'Starly', speciesId: 396, nickname: null, level: 5, nature: 'Hardy', ability: 'Keen Eye', item: null,
      moves: ['Tackle', 'Growl'], stats: stats(20, 12, 9, 9, 9, 12), hp: 20, status: null, disputed: [],
      showdown: ['Starly (M)', 'Level: 5', 'Ability: Keen Eye', 'Hardy Nature', '- Tackle', '- Growl'].join('\n'),
    }]);
  });

  it('orders the pairs players outer whatever order the sheet lists them in; a pair with a stray enemy throws', () => {
    const data = serverData();
    const { trainer } = trainerOf(data, TRISTAN_ID);
    const team = teamOf(data);
    const sheet = buildSheet(team, trainer, { moves: buildMoves(data) });
    expect(sheet.pairs.map((pair) => pair.enemy.level)).toEqual([5, 5, 5, 6, 6, 6]);   // buildSheet lists the trainer's outer
    const ctx = { names: data.names, variant: 0, variants: 1 };
    const playersOuter = { ...sheet, pairs: team.flatMap((_, p) => sheet.pairs.filter((_pair, i) => i % team.length === p)) };
    expect(sheetToJson(playersOuter, ctx)).toEqual(sheetToJson(sheet, ctx));
    const stray = { ...sheet, pairs: [{ ...sheet.pairs[0]!, enemy: structuredClone(trainer.party[0]!) }] };
    expect(() => sheetToJson(stray, ctx)).toThrow(/not in Youngster Tristan's party/);
  });

  it('gives each Pokémon the HP and status its numbers use, and works the numbers out on them with hp "save"', () => {
    const [save, full] = [sheetFor(TRISTAN_ID, { file: HURT, hp: 'save' }), sheetFor(TRISTAN_ID, { file: HURT })];
    expect([save.players.map((p) => [p.hp, p.stats.hp, p.status]), save.enemies.map((e) => [e.hp, e.status])]).toEqual([
      [[10, 44, 'burn'], [35, 35, null], [35, 35, null]], save.enemies.map((e) => [e.stats.hp, null]),
    ]);
    // The full-HP sheet: the HP its numbers use is the max; the status is the save's either way.
    expect(full.players[0]).toMatchObject({ hp: 44, status: 'burn' });
    // At 10 HP Blaze powers up Ember, and Starly's Tackle needs fewer hits.
    expect(save.pairs[0]!.playerMoves[1]!.damage!.max).toBeGreaterThan(full.pairs[0]!.playerMoves[1]!.damage!.max);
    expect(save.pairs[0]!.enemyMoves[0]!.damage!.koChance).not.toEqual(full.pairs[0]!.enemyMoves[0]!.damage!.koChance);
  });

  it('gives a status move damage null and a damaging move the calc\'s numbers', () => {
    const data = serverData();
    const pair = sheetFor(TRISTAN_ID, { data }).pairs[0]!;
    const result = damage({ mon: trainerOf(data, TRISTAN_ID).trainer.party[0]! }, { mon: teamOf(data)[0]! }, buildMoves(data).get(33)!, {})!;
    const cell = { type: 'Normal', hitChance: 1, inaccurate: false, unmodelled: null, weatherDepends: false };
    expect(pair.enemyMoves).toEqual([{
      ...cell, name: 'Tackle', category: 'Physical', power: 35,
      damage: {
        rolls: result.rolls, critRolls: result.critRolls, min: result.min, max: result.max, percent: result.percent, koChance: result.koChance,
        koExact: result.koExact!.map(({ hits, count, total }) => ({ hits, num: String(count), den: String(total) })), bounded: true, ohko: false, desc: result.desc,
      },
    }, { ...cell, name: 'Growl', category: 'Status', power: 0, damage: null }]);
    expect([result.rolls.length, result.desc]).toEqual([16, expect.stringMatching(/^Starly Tackle vs\. Monferno: \d+-\d+/)]);
    expect(pair.playerMoves.map((m) => [m.name, m.type, m.category, m.damage === null])).toEqual([['Tackle', 'Normal', 'Physical', false], ['Ember', 'Fire', 'Special', false]]);
  });

  it('shows hand-made Pokémon\'s numbers: Ember 22–27; an OHKO move "ohko: true"; an unbounded move "bounded: false", no KO chance', () => {
    const [ember] = handSheet([handMonferno()], [zigzagoon()], [TACKLE, EMBER]).pairs[0]!.playerMoves;
    expect(ember).toMatchObject({
      name: 'Ember', type: 'Fire', category: 'Special', power: 40, weatherDepends: false,
      damage: { min: 22, max: 27, percent: [110, 135], bounded: true, ohko: false, desc: expect.stringMatching(/^Monferno Ember vs\. Zigzagoon: 22-27 \(110 - 135%\)/) },
    });
    // A level 30 Zigzagoon can land Fissure on the level 15 Monferno; the made-up "Odd Hit" has an effect the calc leaves out.
    const oddHit = move(500, { name: 'Odd Hit', unmodelled: 'Odd effect' });
    const [fissure, odd] = handSheet([handMonferno()], [zigzagoon({ level: 30, moves: [90, 500] })], [TACKLE, EMBER, FISSURE, oddHit]).pairs[0]!.enemyMoves;
    const [koChance, koExact] = [[1, 2, 3, 4].map((hits) => ({ hits, chance: 1 })), [1, 2, 3, 4].map((hits) => ({ hits, num: '1', den: '1' }))];
    expect([fissure, odd]).toMatchObject([
      { damage: { ohko: true, bounded: true, min: 44, max: 44, koChance, koExact } },
      { name: 'Odd Hit', unmodelled: 'Odd effect', damage: { bounded: false, ohko: false, koChance: null, koExact: null } },
    ]);
    expect(fissure!.hitChance > 0 && fissure!.hitChance < 1).toBe(true);
  });

  it('heads the sheet with the trainer, its copy and its field note, carries the sheet\'s notes as they are, and has no HP mode', () => {
    const [tristan, twins, gardenia] = [sheetFor(TRISTAN_ID), sheetFor(TWINS_ID), sheetFor(GARDENIA_ID, { variant: 1 })];
    expect([tristan.trainer, gardenia.trainer, twins.trainer.battleType]).toEqual([
      { id: TRISTAN_ID, name: 'Youngster Tristan', location: 'Route 202', battleType: 'single', variant: 0, variants: 1, field: null },
      { id: GARDENIA_ID, name: 'Leader Gardenia', location: 'Eterna Gym', battleType: 'single', variant: 1, variants: 2, field: 'PERMANENT RAIN' }, 'double',
    ]);
    expect([tristan.notes, twins.notes, gardenia.notes]).toEqual([[], ["Double battle: can't be built yet. Spread moves deal 3/4 damage here."], [
      'Docs field note: PERMANENT RAIN', 'Rain from the start: in the damage, hit chances and Speeds, except in pairs where a weather-setting ability replaces it',
    ]]);
    for (const sheet of [twins, tristan, sheetFor(TRISTAN_ID, { hp: 'save' })]) for (const key of ['hp', 'solverAvailable']) expect(sheet).not.toHaveProperty(key);
    // Plain JSON: it survives a round trip unchanged.
    for (const sheet of [tristan, twins, gardenia, weatherFight()]) expect(JSON.parse(JSON.stringify(sheet))).toStrictEqual(sheet);
  });

  it('lists a disputed nature, and a disputed ability, with every option: the one the numbers use first', () => {
    // Tristan's Starly Lv 6: the ROM says Hardy, the docs Adamant.
    expect(sheetFor(TRISTAN_ID).enemies.map((mon) => [mon.nature, mon.disputed])).toEqual([['Hardy', []], ['Hardy', [{ field: 'nature', options: ['Hardy', 'Adamant'] }]]]);
    const data = serverData();
    data.docs.trainers[0]!.party[1]!.ability = 'Intimidate';
    expect(sheetFor(TRISTAN_ID, { data }).enemies[1]!.disputed)
      .toEqual([{ field: 'nature', options: ['Hardy', 'Adamant'] }, { field: 'ability', options: ['Keen Eye', 'Intimidate'] }]);
  });

  it('gives a nature no source knows as null, with neutral stats, all 25 natures as options and no Nature line', () => {
    const data = serverData();
    data.rom.trainers[0]!.party[1]!.natureKnown = false;
    data.docs.trainers[0]!.party[1]!.nature = 'Hardy/Bold';
    // Lv 6, 31 IVs, neutral: HP floor(111 × 6 / 100) + 16 = 22; Atk floor(141 × 6 / 100) + 5 = 13; Def, SpA and SpD
    // floor(91 × 6 / 100) + 5 = 10; Spe floor(151 × 6 / 100) + 5 = 14.
    expect([sheetFor(TRISTAN_ID, { data }).enemies[1]!, NATURES.length]).toMatchObject([{
      nature: null, disputed: [{ field: 'nature', options: [...NATURES] }], stats: stats(22, 13, 10, 10, 10, 14),
      showdown: ['Starly (M)', 'Level: 6', 'Ability: Keen Eye', '- Tackle'].join('\n'),
    }, 25]);
  });

  it('names each pair\'s field in short: "No weather" without one, "Rain" in Gardenia\'s permanent rain, every part weather first', () => {
    expect(sheetFor(TRISTAN_ID).pairs.map((pair) => [pair.field, pair.weatherMayPersist, 'weatherCases' in pair])).toEqual(Array(6).fill(['No weather', false, false]));
    expect(new Set(sheetFor(GARDENIA_ID).pairs.map((pair) => pair.field))).toEqual(new Set(['Rain']));
    const every = { weather: 'hail', fog: true, trickRoom: true, gravity: true, reflect: true, lightScreen: true, doubles: true } as const;
    expect([fieldText({}), fieldText({ weather: 'sand' }), fieldText(every)]).toEqual(['No weather', 'Sandstorm', 'Hail, Fog, Trick Room, Gravity, Reflect, Light Screen']);
  });

  it('weather that is not settled: no single field, "depends", every cell weatherDepends, each case by name; weather that may persist', () => {
    const [pair] = weatherFight().pairs;
    // The worse case for the player: Thunder always hits in rain.
    expect([pair, pair!.playerMoves[0], pair!.enemyMoves[0]]).toMatchObject([
      { field: null, order: 'depends', weatherMayPersist: false }, { name: 'Ember', weatherDepends: true }, { name: 'Thunder', weatherDepends: true, hitChance: 1 },
    ]);
    const cases = pair!.weatherCases!;
    // Thunder is 50% in sun, sure in rain; a case's own cells are not weather-dependent.
    const summary = cases.map(({ enemyAbility, lastIn, when, field, enemyMoves: [thunder], playerMoves: [ember] }) =>
      [enemyAbility, lastIn, when, field, thunder!.hitChance, thunder!.weatherDepends, ember!.weatherDepends]);
    expect(summary).toEqual([['Drizzle', 'player', 'Fernando came in last', 'Sun', 0.5, false, false], ['Drizzle', 'enemy', 'Zigzagoon came in last', 'Rain', 1, false, false]]);
    expect(cases.every((c) => ['player', 'enemy', 'tie', 'depends'].includes(c.order) && c.playerSpeed > 0 && c.enemySpeed > 0)).toBe(true);
    // Ember is stronger in sun than in rain.
    expect(cases[0]!.playerMoves[0]!.damage!.max).toBeGreaterThan(cases[1]!.playerMoves[0]!.damage!.max);
    // A pair whose weather another Pokémon of the battle may have set is marked.
    const slugma = zigzagoon({ name: 'Slugma', species: 218, types: [10, 10], item: 0, ...ability(DROUGHT), moves: [52] });
    expect(handSheet([handMonferno()], [slugma, zigzagoon()], [TACKLE, EMBER]).pairs.map((p) => [p.enemy, p.field, p.weatherMayPersist]))
      .toEqual([['enemy:0', 'Sun', false], ['enemy:1', 'No weather', true]]);
  });
});
