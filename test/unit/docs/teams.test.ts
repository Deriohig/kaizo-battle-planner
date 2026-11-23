import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupGauntlets, parseTeamTab } from '../../../src/docs/teams.js';

// The real Roark Split tab's CSV export, its top 35 rows: the title, the AI flag key, then Route 202 to Logan's party.
const ROARK = readFileSync(new URL('../../fixtures/roarkSplitExcerpt.csv', import.meta.url), 'utf8');

/** One export row of 17 cells, keyed by column; a cell holding a comma is quoted, as the export does. */
const row = (cells: Record<number, string>) =>
  Array.from({ length: 17 }, (_, i) => cells[i] ?? '').map((cell) => (/[",]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(',');
const BLANK = row({});

/** A location or trainer heading in column 4, then the blank row the export keeps after it. */
const heading = (text: string) => [row({ 4: text }), BLANK];

/** A party in the export's layout (Pokémon, Nature/Abillity, Item, 4 move rows) of Hardy Simple mons with Tackle; '' leaves a column empty. */
function party(mons = ['Lv 5 Bidoof ♂'], monLabel = 'Pokémon'): string[] {
  /** A row of `labels`, plus each mon's cells from its column `c`. */
  const cells = (labels: Record<number, string>, value: (mon: string, c: number) => Record<number, string>) =>
    row(Object.assign(labels, ...mons.map((mon, i) => (mon ? value(mon, 4 + 2 * i) : {}))));
  return [
    cells({ 16: monLabel }, (mon, c) => ({ [c]: mon })),
    cells({ 16: 'Nature/Abillity' }, (_, c) => ({ [c]: 'Hardy', [c + 1]: 'Simple' })),
    cells({ 1: 'AI Flags:', 16: 'Item' }, (_, c) => ({ [c]: '(None)' })),
    cells({ 16: 'Moves' }, (_, c) => ({ [c]: 'Tackle' })),
    BLANK, BLANK, BLANK, BLANK];
}

/** A trainer heading and a one-Bidoof party. */
const trainer = (name: string) => [...heading(name), ...party()];

/** A split tab: the title and AI flag key rows the real tabs start with, then the blocks. The export ends lines with CRLF. */
const tab = (...blocks: string[][]) => [row({ 4: '  PLATINUM KAIZO - TEST SPLIT' }), row({ 4: 'AI Flag Key:' }), BLANK, ...blocks.flat()].join('\r\n');
/** The trainers of a test tab of `blocks` under Route 1. */
const route1 = (...blocks: string[][]) => parseTeamTab(tab(heading('Route 1'), ...blocks), 'Test');

describe('parseTeamTab', () => {
  it('parses the Roark Split excerpt: three trainers on Route 202, (None) items as null, a female mon, a party of 4', () => {
    const roark = parseTeamTab(ROARK, 'Roark Split');
    expect(roark.map((t) => [t.order, t.location, t.name, t.party.length])).toEqual([
      [0, 'Route 202', 'Youngster Tristan', 3], [1, 'Route 202', 'Lass Natalie', 3], [2, 'Route 202', 'Bug Catcher Logan', 4]]);
    expect(roark[0]).toMatchObject({ split: 'Roark Split', locationGauntlet: false, field: null, tags: { starred: false, raw: [] } });
    expect(roark[0]?.party).toEqual([
      { level: 5, species: 'Zigzagoon', gender: 'M', nature: 'Hasty', ability: 'Gluttony', item: 'Silk Scarf', moves: ['Quick Attack', 'Sand Attack'] },
      { level: 5, species: 'Sentret', gender: 'M', nature: 'Docile', ability: 'Adaptability', item: 'Silk Scarf', moves: ['Quick Attack', 'Sand Attack'] },
      { level: 5, species: 'Pidgey', gender: 'M', nature: 'Bashful', ability: 'Tangled Feet', item: 'Sharp Beak', moves: ['Mud Slap', 'Gust', 'Quick Attack', 'Sand Attack'] }]);
    expect(roark[1]?.party[0]).toMatchObject({ level: 6, species: 'Sunkern', gender: 'F', item: 'Oran Berry' });
    expect(roark[2]?.party.map((m) => m.item)).toEqual([null, null, null, null]);
    expect(roark[2]?.party[3]).toEqual({ level: 7, species: 'Kricketot', gender: 'M', nature: 'Rash', ability: 'Shed Skin', item: null, moves: ['Bug Bite', 'Mud Slap', 'Snore', 'Bide'] });
  });

  it('reads the mon cells the real tabs write: no gender, "LV", a double space, "♀/♂", forms', () =>
    expect(route1(party(['LV 50 Slaking', 'Lv 28  Torterra ♂', 'Lv 15 Swablu ♀/♂', 'Lv 9 Togepi ♀', 'Lv 55 Wormadam-Sandy', 'Lv 52 Mime Jr.']))[0]?.party
      .map((m) => [m.level, m.species, m.gender])).toEqual([
      [50, 'Slaking', null], [28, 'Torterra', 'M'], [15, 'Swablu', null], [9, 'Togepi', 'F'], [55, 'Wormadam-Sandy', null], [52, 'Mime Jr.', null]]));

  // The real tabs leave the cell empty 34 times; the Fantina Split writes "None" for Leader Fantina's first team.
  it.each<[string, Record<number, string>]>([['an empty item cell', {}], ['a bare "None" item', { 4: 'None' }]])('reads %s as null', (_, cells) =>
    expect(route1(party().with(2, row({ 1: 'AI Flags:', 16: 'Item', ...cells })))[0]?.party).toEqual([
      { level: 5, species: 'Bidoof', gender: 'M', nature: 'Hardy', ability: 'Simple', item: null, moves: ['Tackle'] }]));

  it('finds a party whose Pokémon label is missing and whose first mon column is empty, as in the Galactic Split', () =>
    expect(parseTeamTab(tab(heading('DISTORTION WORLD'), heading('Galactic Boss Cyrus'), party(['', '', 'Lv 100 GIRATINA-ORIGIN'], ''), trainer('Galactic Grunt')), 'Test')
      .map((t) => [t.location, t.name, t.party.map((m) => m.species)])).toEqual([
      ['DISTORTION WORLD', 'Galactic Boss Cyrus', ['GIRATINA-ORIGIN']], ['DISTORTION WORLD', 'Galactic Grunt', ['Bidoof']]]));

  it.each<[string, string, object | null]>([
    ['Route 223 (PERMANENT RAIN)', 'Route 223', { raw: 'PERMANENT RAIN', weather: 'rain' }],
    ['Route 999 (SOMETHING ODD)*', 'Route 999', { raw: 'SOMETHING ODD' }],
    ['Route 222 (PERMANENT SUN)', 'Route 222', { raw: 'PERMANENT SUN', weather: 'sun' }],
    ['Lake (SUNNY)', 'Lake', { raw: 'SUNNY', weather: 'sun' }],
    ['Oreburgh Gym (PERMANENT SANDSTORM)', 'Oreburgh Gym', { raw: 'PERMANENT SANDSTORM', weather: 'sand' }],
    ['Desert (SAND)', 'Desert', { raw: 'SAND', weather: 'sand' }],
    ['Route 216 (HAIL)', 'Route 216', { raw: 'HAIL', weather: 'hail' }],
    ['Veilstone Warehouse (PERMANENT TRICK ROOM)*', 'Veilstone Warehouse', { raw: 'PERMANENT TRICK ROOM', trickRoom: true }],
    ['CORONET HIGHLANDS ROOM 1 (FOG)', 'CORONET HIGHLANDS ROOM 1', { raw: 'FOG', fog: true }],
    ['Pokémon League (GRAVITY)', 'Pokémon League', { raw: 'GRAVITY', gravity: true }],
    ['Route 210 South*', 'Route 210 South', null],
  ])('reads the location heading %j as %j with its field note', (text, location, field) => {
    const [t] = parseTeamTab(tab(heading(text), trainer('Youngster Joey')), 'Test');
    expect([t?.location, t?.field]).toEqual([location, field]);
  });

  it.each<[string, string, object, object | null]>([
    ['Worker Mason (Gauntlet Start)*', 'Worker Mason', { gauntlet: 'start', starred: true, raw: ['Gauntlet Start'] }, null],
    ['Bug Catcher Brandon (Gauntlet)*', 'Bug Catcher Brandon', { gauntlet: 'middle', starred: true, raw: ['Gauntlet'] }, null],
    ['Aroma Lady Taylor (Gauntlet End)*', 'Aroma Lady Taylor', { gauntlet: 'end', starred: true, raw: ['Gauntlet End'] }, null],
    ['SwimmerF Mary (GAUNTLET START)*', 'SwimmerF Mary', { gauntlet: 'start', starred: true, raw: ['GAUNTLET START'] }, null],
    ['Twins Liv & Liz (DOUBLE) (Gauntlet Start)*', 'Twins Liv & Liz', { battle: 'double', gauntlet: 'start', starred: true, raw: ['DOUBLE', 'Gauntlet Start'] }, null],
    ['GalacticfTerra (MULTI BATTLE With Galactic Luna)*', 'GalacticfTerra', { battle: 'multi', partner: 'Galactic Luna', starred: true, raw: ['MULTI BATTLE With Galactic Luna'] }, null],
    ['Galactic Uranus (TAG BATTLE with Galactic Cupid)', 'Galactic Uranus', { battle: 'tag', partner: 'Galactic Cupid', starred: false, raw: ['TAG BATTLE with Galactic Cupid'] }, null],
    ['Galactic Hippocamp (MULTI BATTLE With Galactic Psamanthe, Right, Path 1)*', 'Galactic Hippocamp',
      { battle: 'multi', partner: 'Galactic Psamanthe', starred: true, raw: ['MULTI BATTLE With Galactic Psamanthe', 'Right', 'Path 1'] }, null],
    ['Galactic Mercury (MUTLI BATTLE with Galactic Venus)', 'Galactic Mercury', { battle: 'multi', partner: 'Galactic Venus', starred: false, raw: ['MUTLI BATTLE with Galactic Venus'] }, null],
    ['Jogger Raul (OPTIONAL)', 'Jogger Raul', { optional: true, starred: false, raw: ['OPTIONAL'] }, null],
    ['Twins Teri & Tia (DOUBLE BATTLE, RAIN)', 'Twins Teri & Tia', { battle: 'double', starred: false, raw: ['DOUBLE BATTLE', 'RAIN'] }, { raw: 'RAIN', weather: 'rain' }],
    ['Gambler John Keating (SUPERBOSS)*', 'Gambler John Keating', { superboss: true, starred: true, raw: ['SUPERBOSS'] }, null],
    ['Skier Bradley (OPTIONAL HAIL)*', 'Skier Bradley', { optional: true, starred: true, raw: ['OPTIONAL HAIL'] }, { raw: 'OPTIONAL HAIL', weather: 'hail' }],
    ['Galactic Valetudo (FOG, OPTIONAL)', 'Galactic Valetudo', { optional: true, starred: false, raw: ['FOG', 'OPTIONAL'] }, { raw: 'FOG', fog: true }],
    ['Champion Cynthia (Permanent Gravity)', 'Champion Cynthia', { starred: false, raw: ['Permanent Gravity'] }, { raw: 'Permanent Gravity', gravity: true }],
    // Shadow Tag is a mon's ability, which the docs and the ROM already carry, so it stays in raw only.
    ['   CYRUS (SHADOW TAG)*', 'CYRUS', { starred: true, raw: ['SHADOW TAG'] }, null],
    ['Galactic Mercury (B2B With Galactic Terra)', 'Galactic Mercury', { backToBack: 'Galactic Terra', starred: false, raw: ['B2B With Galactic Terra'] }, null],
    ['Gentleman Jeremy ', 'Gentleman Jeremy', { starred: false, raw: [] }, null],
    // Trainers on the player's side are marked, and kept in the output.
    ['Mira (Tag Partner)', 'Mira', { playerPartner: true, starred: false, raw: ['Tag Partner'] }, null],
    ['Trainer Marley (PARTNER)', 'Trainer Marley', { playerPartner: true, starred: false, raw: ['PARTNER'] }, null],
    ['Trainer Dawn/Lucas (TAG PARTNER, Player selected Chimchar)', 'Trainer Dawn/Lucas', { playerPartner: true, starred: false, raw: ['TAG PARTNER', 'Player selected Chimchar'] }, null],
    ['Barry (TAG PARTNER if Player chose Piplup)', 'Barry', { playerPartner: true, starred: false, raw: ['TAG PARTNER if Player chose Piplup'] }, null],
    ['Mira (TAG PARTNER Mira)', 'Mira', { playerPartner: true, partner: 'Mira', starred: false, raw: ['TAG PARTNER Mira'] }, null],
    ['TAG PARTNER MIRA*', 'TAG PARTNER MIRA', { playerPartner: true, partner: 'MIRA', starred: true, raw: [] }, null],
  ])('reads the trainer heading %j as %j with its tags and field note', (text, name, tags, field) => {
    const [t] = route1(trainer(text));
    expect([t?.name, t?.tags, t?.field]).toEqual([name, tags, field]);
  });

  it("merges a trainer's field notes with its location's, the trainer's winning where both set a field", () =>
    expect(parseTeamTab(tab(heading('Route 217 (HAIL)*'), trainer('Skier Bradley (OPTIONAL HAIL)*'), trainer('Skier Cal (SUN)'),
      trainer('Skier Dee (OPTIONAL)'), heading('Room (FOG)'), trainer('Twins Teri & Tia (DOUBLE BATTLE, RAIN)'),
      heading('Snowpoint Gym (HAIL)'), trainer('Ace Trainer Tenzing (HAIL)')), 'Test').map((t) => [t.location, t.field])).toEqual([
      ['Route 217', { raw: 'HAIL, OPTIONAL HAIL', weather: 'hail' }],
      ['Route 217', { raw: 'HAIL, SUN', weather: 'sun' }],
      ['Route 217', { raw: 'HAIL', weather: 'hail' }],
      ['Room', { raw: 'FOG, RAIN', fog: true, weather: 'rain' }],
      ['Snowpoint Gym', { raw: 'HAIL', weather: 'hail' }]]));

  it.each([
    ['a party with no trainer name above it', tab(party()), 'Test row 4: a party has no trainer name above it'],
    ['a mon cell it cannot read', tab(heading('Route 1'), heading('Youngster Joey'), party(['Level five Bidoof'])), 'Test row 8: cannot read the Pokémon cell "Level five Bidoof"'],
  ])('throws on %s, naming the split and row', (_, csv, message) => expect(() => parseTeamTab(csv, 'Test')).toThrow(message));
});

describe('groupGauntlets', () => {
  it('makes every trainer of a GYM TRAINERS ARE A GAUNTLET location one gauntlet', () => {
    const trainers = parseTeamTab(tab(heading('Route 205 North'), trainer('Fisherman Zachary'),
      heading('Eterna Gym (PERMANENT RAIN, GYM TRAINERS ARE A GAUNTLET)'), trainer('Lass Caroline'), trainer('Aroma Lady Jenna'), trainer('Leader Gardenia'),
      heading('Eterna City (GYM TRAINERS ARE A GAUNTLET)'), trainer('Lass Ana')), 'Gardenia Split');
    const rain = { raw: 'PERMANENT RAIN', weather: 'rain' };
    expect(trainers.map((t) => [t.location, t.locationGauntlet, t.field])).toEqual([
      ['Route 205 North', false, null], ['Eterna Gym', true, rain], ['Eterna Gym', true, rain], ['Eterna Gym', true, rain], ['Eterna City', true, null]]);
    expect(groupGauntlets(trainers).map((g) => [g.split, g.location, g.trainers.map((t) => t.name)])).toEqual([
      ['Gardenia Split', 'Eterna Gym', ['Lass Caroline', 'Aroma Lady Jenna', 'Leader Gardenia']], ['Gardenia Split', 'Eterna City', ['Lass Ana']]]);
  });

  // A run holds only gauntlet-tagged trainers and closes at its End, a change of location heading, or the next Start.
  // Each tab is [CSV, split]; each gauntlet [split, location, trainer names].
  it.each<[string, [string, string][], [string, string, string[]][]]>([
    ['the Start, middle and End trainers of a run in order, a run per Start, across splits', [
      [tab(heading('Route 213 (PERMANENT RAIN)'), trainer('TuberF Chelsea (OPTIONAL)*'), trainer('SwimmerF Mary (GAUNTLET START)*'),
        trainer('Swimmer Sheltin (GAUNTLET)*'), trainer('SwimmerF Haley (GAUNTLET)*'), trainer('Sailor Paul (GAUNTLET END)*'), trainer('Beauty Chelle')), 'Wake Split'],
      [tab(heading('Team Galactic Eterna Building'), trainer('Galactic Amalthia (Gauntlet Start)*'), trainer('Scientist Galileo (Gauntlet End)*'),
        trainer('Galactic Callisto (Gauntlet Start)*'), trainer('Galactic Europa (Gauntlet End)*'), trainer('Commander Jupiter')), 'Fantina Split']], [
      ['Wake Split', 'Route 213', ['SwimmerF Mary', 'Swimmer Sheltin', 'SwimmerF Haley', 'Sailor Paul']],
      ['Fantina Split', 'Team Galactic Eterna Building', ['Galactic Amalthia', 'Scientist Galileo']], ['Fantina Split', 'Team Galactic Eterna Building', ['Galactic Callisto', 'Galactic Europa']]]],
    ['no untagged trainers, and a run with no End closed at a change of heading, even back to the same name', [
      [tab(heading('Route 1'), trainer('Worker Mason (Gauntlet Start)*'), trainer('Worker Ivan'), trainer('Worker Colin (Gauntlet)*'),
        heading('Route 2'), trainer('Worker Cy (Gauntlet)'), trainer('Lass Ana'), heading('Route 1'), trainer('Worker Di (Gauntlet End)')), 'Test']],
      [['Test', 'Route 1', ['Worker Mason', 'Worker Colin']], ['Test', 'Route 2', ['Worker Cy']], ['Test', 'Route 1', ['Worker Di']]]],
    ['a run closed at its End and at a repeated Start', [[tab(heading('Route 1'), trainer('Worker Ann (Gauntlet Start)'), trainer('Worker Bo (Gauntlet Start)'),
      trainer('Worker Cy (Gauntlet End)'), trainer('Worker Di (Gauntlet End)'), trainer('Worker Ed (Gauntlet)')), 'Test']],
      [['Test', 'Route 1', ['Worker Ann']], ['Test', 'Route 1', ['Worker Bo', 'Worker Cy']], ['Test', 'Route 1', ['Worker Di']], ['Test', 'Route 1', ['Worker Ed']]]],
    ['both foes of a multi battle that share a Start or End tag, and a run with no Start (Wayward Cave)', [[tab(heading('Wayward Cave - OPTIONAL Gauntlet With Mira*'),
      trainer('Mira (Tag Partner)'), trainer('Collector Gerald (MULTI BATTLE with Clown Bob, GAUNTLET)*'), trainer('Clown Bob (MULTI BATTLE with Collector Gerald, GAUNTLET)'),
      trainer('Castle Valet Darach (MULTI BATTLE with Lady Caitlin, GAUNTLET END)'), trainer('Lady Caitlin (MULTI BATTLE with Castle Valet Darach, GAUNTLET END)'),
      trainer('Hiker Ann (MULTI BATTLE with Hiker Bo, Gauntlet Start)'), trainer('Hiker Bo (MULTI BATTLE with Hiker Ann, Gauntlet Start)'),
      trainer('Hiker Cy (Gauntlet End)')), 'Galactic Split']], [
      ['Galactic Split', 'Wayward Cave - OPTIONAL Gauntlet With Mira', ['Collector Gerald', 'Clown Bob', 'Castle Valet Darach', 'Lady Caitlin']],
      ['Galactic Split', 'Wayward Cave - OPTIONAL Gauntlet With Mira', ['Hiker Ann', 'Hiker Bo', 'Hiker Cy']]]],
    ["no trainer on the player's side", [[tab(heading('Eterna Gym (GYM TRAINERS ARE A GAUNTLET)'), trainer('Lass Caroline'), trainer('Cheryl (TAG PARTNER)'),
      trainer('Leader Gardenia'), heading('Route 1'), trainer('Mira (Tag Partner, Gauntlet Start)'), trainer('Worker Ann (Gauntlet Start)'),
      trainer('TAG PARTNER RILEY (Gauntlet)'), trainer('Worker Bo (Gauntlet End)'), trainer('Galactic Cy (B2B With Mira)')), 'Galactic Split']],
      [['Galactic Split', 'Eterna Gym', ['Lass Caroline', 'Leader Gardenia']], ['Galactic Split', 'Route 1', ['Worker Ann', 'Worker Bo']]]],
    // The real pair: Mercury names "Galactic Terra", whom the docs head "GalacticfTerra", so only Terra's side is found.
    ['each back-to-back pair once, named by both or by its second only, in docs order; none for a partner in another split', [
      [tab(heading('Floaroma Meadow'), trainer('Galactic Mercury (B2B With Galactic Terra)'), trainer('GalacticfTerra (B2B With Galactic Mercury)'),
        trainer('Maid Yoki'), trainer('Galactic Sol (B2B with Galactic Luna)'), trainer('Galactic Luna (B2B with Galactic Sol)')), 'Gardenia Split'],
      [tab(heading('Route 1'), trainer('Galactic Luna'), trainer('Worker Ann (Gauntlet Start)'), trainer('Worker Bo (Gauntlet End)'),
        trainer('Galactic Sol (B2B with GALACTIC  LUNA)')), 'Test'],
      [tab(heading('Route 1'), trainer('Galactic Mercury (B2B With Galactic Terra)')), 'Byron Split'], [tab(heading('Route 2'), trainer('Galactic Terra')), 'Fantina Split']], [
      ['Gardenia Split', 'Floaroma Meadow', ['Galactic Mercury', 'GalacticfTerra']], ['Gardenia Split', 'Floaroma Meadow', ['Galactic Sol', 'Galactic Luna']],
      ['Test', 'Route 1', ['Galactic Luna', 'Galactic Sol']], ['Test', 'Route 1', ['Worker Ann', 'Worker Bo']]]],
  ])('groups %s', (_, tabs, gauntlets) => expect(groupGauntlets(tabs.flatMap(([csv, split]) => parseTeamTab(csv, split)))
    .map((g) => [g.split, g.location, g.trainers.map((t) => t.name)])).toEqual(gauntlets));
});
