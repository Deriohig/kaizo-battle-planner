// The script and move-table diff tools: diffScripts, labelsFromSource and the move effect and field diffs.

import { describe, expect, it } from 'vitest';
import { labelsFromSource, type SourceLabel } from '../../../src/ai/diff/labels.js';
import { damageScoringNote, diffMoveEffects, diffMoveFields, effectRoutines } from '../../../src/ai/diff/moveDiff.js';
import { type ConstantNames, diffScripts, type ScriptChange } from '../../../src/ai/diff/scriptDiff.js';
import type { AiScript } from '../../../src/ai/rom/script.js';
import type { MoveRecord } from '../../../src/rom/types.js';
import { assemble } from './asm.js';

/** `src` assembled as a script whose 32 flag bits all start at word 0, with its labels in source order. */
function build(src: string): { script: AiScript; labels: SourceLabel[] } {
  const { words, labels } = assemble(src);
  return {
    script: { words, flagEntries: Array<number>(32).fill(0), sha256: '' },
    labels: Object.entries(labels).map(([name, at]) => ({ name, at })),
  };
}

/** Flag bit 0's diff of `vanilla` and `hack`, labelled from vanilla. */
function diff(vanilla: string, hack: string, names?: ConstantNames): ScriptChange[] {
  const v = build(vanilla);
  return diffScripts(v.script, build(hack).script, v.labels, names);
}
const basic = (vanillaLabel: string, vanilla: string[], hack: string[]): ScriptChange => ({ flag: 'Basic', vanillaLabel, vanilla, hack });

const SCORING = `
  Main: IfRandomLessThan 128, Skip
  LoadCurrentMoveEffect
  IfLoadedInTable Effects, Plus
  PushAndGoTo Sub
  Skip: PopOrEnd
  Plus: AddToMoveScore 1
  PopOrEnd
  Sub: AddToMoveScore -1
  PopOrEnd
  Effects: TableEntry 7
  TableEnd
`;
// Plus stays reachable through the GoTo, so retargeting the first branch changes only that branch.
const RETARGET = `
  Main: IfRandomLessThan 128, Plus
  IfRandomLessThan 64, Minus
  GoTo Plus
  Plus: AddToMoveScore 1
  PopOrEnd
  Minus: AddToMoveScore -1
  PopOrEnd
`;
const APPENDED = 'Main: IfRandomLessThan 128, Plus\nGoTo End\nPlus: AddToMoveScore 1\nEnd: PopOrEnd';
const ABILITY_TEST = 'Main: LoadBattlerAbility 0\nIfLoadedEqualTo 26, Minus\nPopOrEnd\nMinus: AddToMoveScore -12\nPopOrEnd';
const ability = Object.assign(Array.from({ length: 124 }, (_, i) => `ABILITY_${i}`), { 26: 'ABILITY_LEVITATE', 87: 'ABILITY_DRY_SKIN' });

describe('diffScripts', () => {
  it.each<[string, string, string, ScriptChange[], ConstantNames?]>([
    ['identical scripts diff empty', SCORING, SCORING, []],
    // Every flag reaches Sub, but the change is listed once, under the first flag (bit 0, Basic).
    ['a changed immediate is reported once', SCORING, SCORING.replace('AddToMoveScore -1', 'AddToMoveScore -2'),
      [basic('Sub', ['AddToMoveScore -1'], ['AddToMoveScore -2'])]],
    ['a retargeted jump is reported', RETARGET, RETARGET.replace('128, Plus', '128, Minus'),
      [basic('Main', ['IfRandomLessThan 128, Plus'], ['IfRandomLessThan 128, Minus'])]],
    // The GoTo now leads past the old script's end, to word 8, which vanilla has no label for.
    ['a hack-only routine appended', APPENDED, `${APPENDED.replace('GoTo End', 'GoTo New')}
      New: AddToMoveScore -5
      IfRandomLessThan 64, End
      AddToMoveScore -1
      GoTo End`, [
      basic('Main', ['GoTo End'], ['GoTo @8']),
      basic('Main', [], ['@8:', 'AddToMoveScore -5', 'IfRandomLessThan 64, End', 'AddToMoveScore -1', 'GoTo End']),
    ]],
    ['constants are named from the given lists', ABILITY_TEST, ABILITY_TEST.replace('26', '87'),
      [basic('Main', ['IfLoadedEqualTo ABILITY_LEVITATE, Minus'], ['IfLoadedEqualTo ABILITY_DRY_SKIN, Minus'])], { ability }],
  ])('%s', (_, vanilla, hack, expected, names) => {
    expect(diff(vanilla, hack, names)).toEqual(expected);
  });

  it('a flag entry that moved is reported under its flag', () => {
    const vanilla = build(SCORING);
    const hack = build(SCORING);
    hack.script.flagEntries[3] = hack.labels.find((label) => label.name === 'Plus')!.at;
    expect(diffScripts(vanilla.script, hack.script, vanilla.labels)).toEqual([
      { flag: 'SetupFirstTurn', vanillaLabel: 'Main', vanilla: ['LabelDistance Main'], hack: ['LabelDistance Plus'] },
    ]);
  });
});

it('labelsFromSource aligns macro lines, leaves named constants unchecked, and throws on the first mismatch', () => {
  const { script } = build('Main: IfRandomLessThan 128, Skip\nAddToMoveScore -1\nSkip: PopOrEnd');
  const source = (score: string) => [
    '    .text', '#include "constants/battle.h"', 'Main:', '    // a comment', '    IfRandomLessThan 128, Skip',
    `    AddToMoveScore ${score}`, 'Skip:', '    PopOrEnd ',
  ].join('\n');
  for (const score of ['-1', 'SCORE']) expect(labelsFromSource(source(score), script)).toEqual([{ name: 'Main', at: 0 }, { name: 'Skip', at: 5 }]);
  expect(() => labelsFromSource(source('-2'), script)).toThrow(/line 6/);
  expect(() => labelsFromSource(source('-1').replace('PopOrEnd', 'Escape'), script)).toThrow(/line 8/);
  expect(() => labelsFromSource(source('-1').replace('128, Skip', '128, Main'), script)).toThrow(/line 5/);
});

/** A move record with `effect` and plain values for the rest. */
function move(id: number, effect: number, fields: Partial<MoveRecord> = {}): MoveRecord {
  return { id, effect, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 0, ...fields };
}

// Effects are routed by a direct test of the current move's effect (Main), a table after LoadCurrentMoveEffect
// (Tables) and a test of the loaded move's effect (Last). A table of move IDs, an ability test and code no flag
// reaches (Dead) route nothing.
const MOVE_SCRIPT = `
  Main: IfCurrentMoveEffectEqualTo 48, Recoil
  IfCurrentMoveEffectNotEqualTo 7, Tables
  AddToMoveScore -1
  Tables: LoadCurrentMoveEffect
  IfLoadedInTable Risky, Plus
  IfLoadedNotInTable Setup, Last
  AddToMoveScore 1
  Last: LoadBattlerPreviousMove 0
  LoadEffectOfLoadedMove
  IfLoadedEqualTo 182, Plus
  IfLoadedNotEqualTo 32, Other
  AddToMoveScore 3
  Other: LoadCurrentMove
  IfLoadedInTable Moves, Plus
  LoadBattlerAbility 1
  IfLoadedEqualTo 48, Plus
  PopOrEnd
  Recoil: AddToMoveScore 1
  PopOrEnd
  Plus: AddToMoveScore 2
  PopOrEnd
  Dead: IfCurrentMoveEffectEqualTo 88, Plus
  PopOrEnd
  Risky: TableEntry 88
  TableEntry 182
  TableEnd
  Setup: TableEntry 51
  TableEnd
  Moves: TableEntry 48
  TableEnd
`;
const EFFECTS = Object.assign(Array.from({ length: 200 }, (_, i) => `EFFECT_${i}`), {
  48: 'BATTLE_EFFECT_RECOIL_QUARTER', 182: 'BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF',
});
const MOVES = ['-', 'Take Down', 'Pound', 'Triple Axel', 'Ember', 'Growl', 'Barrier'];
const TYPES = ['TYPE_NORMAL', 'TYPE_FIGHTING', 'TYPE_FLYING', 'TYPE_POISON', 'TYPE_GROUND', 'TYPE_ROCK', 'TYPE_BUG', 'TYPE_GHOST',
  'TYPE_STEEL', 'TYPE_MYSTERY', 'TYPE_FIRE'];

describe('move diffs', () => {
  const { script, labels } = build(MOVE_SCRIPT);

  it("effectRoutines lists each effect's branches in the reachable script, by the nearest label before the branch", () => {
    expect(Object.fromEntries(effectRoutines(script, labels))).toEqual({
      48: ['Main → Recoil'], 7: ['Main'], 88: ['Tables → Plus'], 182: ['Tables → Plus', 'Last → Plus'], 51: ['Tables'], 32: ['Last'],
    });
  });

  it("diffMoveEffects reports a changed effect with the routines that branch on each side's effect", () => {
    const vanilla = [move(0, 0), move(1, 48), move(2, 7, { power: 40 }), move(3, 88), move(4, 51), move(5, 5), move(6, 7)];
    const hack = [move(0, 0), move(1, 182), move(2, 7, { power: 50 }), move(3, 48), move(4, 32), move(5, 5), move(6, 0)];
    const change = (id: number, from: number, to: number, fromRoutines: string[], toRoutines: string[], damageScoring: string | null) => ({
      move: id, name: MOVES[id], vanillaEffect: from, hackEffect: to, vanillaEffectName: EFFECTS[from], hackEffectName: EFFECTS[to],
      vanillaRoutines: fromRoutines, hackRoutines: toRoutines, damageScoring,
    });
    expect(diffMoveEffects(vanilla, hack, script, labels, { effect: EFFECTS, move: MOVES })).toEqual([
      change(1, 48, 182, ['Main → Recoil'], ['Tables → Plus', 'Last → Plus'], 'no longer damage-scored'),
      change(3, 88, 48, ['Tables → Plus'], ['Main → Recoil'], null),
      change(4, 51, 32, ['Tables'], ['Last'], null),
      change(6, 7, 0, ['Main'], [], 'now damage-scored'),
    ]);
  });

  it("diffMoveEffects marks a row where the AI's damage-estimate test changes answer, and only there", () => {
    // 182 and 7 are never estimated, 88 at any power, any other effect only at power over 1.
    const pairs: [number, number, number, number][] = [
      [48, 90, 182, 90], [51, 90, 32, 90], [182, 150, 48, 180], [119, 10, 88, 20], [168, 0, 7, 255], [88, 1, 0, 121], [85, 0, 0, 70],
    ];
    const vanilla = [move(0, 0), ...pairs.map(([effect, power], i) => move(i + 1, effect, { power }))];
    const hack = [move(0, 0), ...pairs.map(([, , effect, power], i) => move(i + 1, effect, { power }))];
    expect(diffMoveEffects(vanilla, hack, script, labels, {}).map((change) => change.damageScoring)).toEqual([
      'no longer damage-scored', null, 'now damage-scored', null, null, null, 'now damage-scored',
    ]);
    expect(() => diffMoveEffects([move(0, 0)], [move(0, 0), move(1, 48)], script, labels, {})).toThrow(/1 moves.*2/);
  });

  it.each([
    [0, 60, 'now damage-scored'], [60, 0, 'no longer damage-scored'], [60, 90, null],
    [0, 1, null], // power 1 isn't over 1 (trainer_ai.c:1036)
  ])('damageScoringNote: power %i → %i', (before, after, expected) => {
    expect(damageScoringNote(move(1, 0, { power: before }), move(1, 0, { power: after }))).toBe(expected);
  });

  it('diffMoveFields reports power, type, class, accuracy, PP and priority, and nothing else', () => {
    const vanilla = [move(0, 0), move(1, 48), move(2, 0)];
    const hack = [
      move(0, 0),
      move(1, 182, { power: 50, type: 10, category: 'special', accuracy: 90, pp: 25, priority: 1, effectChance: 30, target: 4, flags: 1 }),
      move(2, 0, { priority: -1 }),
    ];
    const takeDown = (field: string, from: string, to: string) => ({ move: 1, name: 'Take Down', field, vanilla: from, hack: to });
    expect(diffMoveFields(vanilla, hack, { move: MOVES, type: TYPES })).toEqual([
      takeDown('power', '40', '50'), takeDown('type', 'TYPE_NORMAL', 'TYPE_FIRE'), takeDown('class', 'Physical', 'Special'),
      takeDown('accuracy', '100', '90'), takeDown('pp', '35', '25'), takeDown('priority', '0', '1'),
      { move: 2, name: 'Pound', field: 'priority', vanilla: '0', hack: '-1' },
    ]);
  });
});
