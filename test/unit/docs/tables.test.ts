import { describe, expect, it } from 'vitest';
import { parseLearnsetTab, parseMovesTab, parsePersonalTab } from '../../../src/docs/tables.js';

// Rows copied verbatim from the official docs' CSV export. Row 0 of each tab is a placeholder.
const MOVES_HEADER = `ID Number,Name,Additional Effect,Category,Power,Type,Accuracy,PP,Additional Effect Chance (%),Target(s),Priority,Contact Move,Blocked by Protect,Reflected by Magic Coat,Affected by Snatch,Affected by Mirror Move,Triggers Kings Rock,Hide HP Bars,Remove Target's Shadow,Contest Effect,Contest Type`;
const MOVE_0 = `0,-,None,Physical,0,Normal,0,0,0,One opponent,0,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,0,0`;
const POUND = `1,Pound,None,Physical,40,Normal,100,35,0,One opponent,0,TRUE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE,FALSE,5,4`;
const WATER_BALL = `4,Water Ball,None,Special,100,Water,100,15,0,One opponent,0,FALSE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE,FALSE,7,4`;

const PERSONAL_HEADER = `ID Number,Name,HP,Attack,Defense,Sp. Atk,Sp. Def,Speed,BST,Type 1,Type 2,Catch Rate,Exp Drop,Uncommon Held Item,Rare Held Item,Gender Ratio,Hatch Multiplier,Base Happiness,Growth Rate,Egg Group 1,Egg Group 2,Ability 1,Ability 2,Safari Zone Run Chance,DO NOT TOUCH`;
const PERSONAL_0 = `0,-----,0,0,0,0,0,0,0,Normal,Normal,0,0,None,None,0,0,0,Medium Fast,~,~,-,-,0,0`;
// A changed stat carries its change from vanilla: Venusaur's Attack went from 82 to 92, Blastoise's Speed from 78 to 60.
const VENUSAUR = `3,VENUSAUR,80,92 (+10),83,100,100,80,535 (+10),Grass,Poison,20,208,None,None,31,20,70,Medium Slow,Monster,Grass,Chlorophyll,Overgrow,45,3`;
const BLASTOISE = `9,BLASTOISE,79,81 (-2),100,110 (+25),105,60 (-18),535 (+5),Water,Water,20,210,None,None,31,20,70,Medium Slow,Monster,Water 1,Torrent,Shell Armor,45,1`;
const MONFERNO = `391,MONFERNO,64,78,52,78,52,81,405,Fire,Fighting,59,142,None,None,31,20,70,Medium Slow,Field,Human-Like,Blaze,Blaze,0,133`;

const LEARNSET_HEADER = `ID Number,Name,${Array(21).fill('Move,Level').join(',')}`;
const MONFERNO_LEARNSET = `391,MONFERNO,Shadow Claw,1,Fire Spin,1,Karate Chop,1,Submission,7,Ember,9,Double Kick,14,Secret Power,16,Flame Wheel,19,Feint,26,Brick Break,29,Fire Punch,36,Facade,39,ThunderPunch,46,Flare Blitz,49,Ice Punch,66,Fake Out,84,Mach Punch,99,,,,,,,,`;

/** The export ends lines with CRLF. */
const csv = (...lines: string[]) => lines.join('\r\n');

describe('the docs table tabs', () => {
  it('parse the Moves tab, skipping row 0', () =>
    expect(parseMovesTab(csv(MOVES_HEADER, MOVE_0, WATER_BALL, POUND))).toEqual([
      { id: 4, name: 'Water Ball', effectText: 'None', category: 'special', power: 100, type: 'Water', accuracy: 100, pp: 15, effectChance: 0, targets: 'One opponent', priority: 0, contact: false },
      { id: 1, name: 'Pound', effectText: 'None', category: 'physical', power: 40, type: 'Normal', accuracy: 100, pp: 35, effectChance: 0, targets: 'One opponent', priority: 0, contact: true }]));

  it('parse the Personal tab, skipping row 0 and blank lines and rows, reading changed stats', () => {
    // The export keeps the sheet's empty rows as rows of empty cells.
    const species = parsePersonalTab(csv(PERSONAL_HEADER, PERSONAL_0, VENUSAUR, '', BLASTOISE, ','.repeat(24), MONFERNO));
    expect(species.map((s) => [s.id, s.baseStats])).toEqual([
      [3, { hp: 80, atk: 92, def: 83, spa: 100, spd: 100, spe: 80 }],
      [9, { hp: 79, atk: 81, def: 100, spa: 110, spd: 105, spe: 60 }],
      [391, { hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }]]);
    expect(species[2]).toEqual({ id: 391, name: 'MONFERNO', baseStats: species[2]!.baseStats, types: ['Fire', 'Fighting'], growthRate: 'Medium Slow', abilities: ['Blaze', 'Blaze'] });
  });

  it('read a stat cell that is not a number as NaN, not 0', () =>
    expect(parsePersonalTab(csv(PERSONAL_HEADER, VENUSAUR.replace('92 (+10)', '')))[0]).toMatchObject({
      id: 3, baseStats: { hp: 80, atk: NaN, def: 83, spa: 100, spd: 100, spe: 80 }, abilities: ['Chlorophyll', 'Overgrow'] }));

  it('parse the Level-Up Learnsets tab, skipping the blank pairs and row 0', () => {
    const learnsets = parseLearnsetTab(csv(LEARNSET_HEADER, `0,-----${','.repeat(42)}`, MONFERNO_LEARNSET));
    expect([...learnsets.keys()]).toEqual([391]);
    expect(learnsets.get(391)).toHaveLength(17);
    expect(learnsets.get(391)?.slice(0, 5)).toEqual([
      { move: 'Shadow Claw', level: 1 }, { move: 'Fire Spin', level: 1 }, { move: 'Karate Chop', level: 1 }, { move: 'Submission', level: 7 }, { move: 'Ember', level: 9 }]);
    expect(learnsets.get(391)?.at(-1)).toEqual({ move: 'Mach Punch', level: 99 });
  });

  it.each([
    ['an unknown move category, naming the move', csv(MOVES_HEADER, POUND.replace('Physical', 'Physic')), 'The Moves tab gives Pound the unknown category "Physic"'],
    ['a missing column it reads', csv(MOVES_HEADER.replace('Priority', 'Prio'), POUND), 'The Moves tab has no "Priority" column'],
  ])('throw on %s', (_, text, message) => expect(() => parseMovesTab(text)).toThrow(message));
});
