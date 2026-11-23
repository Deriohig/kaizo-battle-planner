// The line builder's log readers on Showdown protocol lines: the step summary (src/server/lineSummary.ts; the first case
// is a real step from the engine, the rest are written in its format) and an outcome's EXP and rolls (src/server/lineExp.ts).

import { describe, expect, it } from 'vitest';
import type { ChanceLabel } from '../../../src/contracts/engine.js';
import { expGains, expToNext, rollsOf } from '../../../src/server/lineExp.js';
import { summarizeLog, type SummarySeed } from '../../../src/server/lineSummary.js';

const hp = (entries: [string, number, number][]) => new Map(entries.map(([key, now, max]) => [key, { hp: now, maxHp: max }]));
const end = (name: string, now: number, max: number, percent: number) => ({ name, hp: now, maxHp: max, percent });

/** The player's NUTZZZZZZZ (page name Blaze) and the trainer's Zigzagoon, both at full HP; Sentret on their bench. */
const SEED: SummarySeed = {
  hp: hp([['p1|NUTZZZZZZZ', 44, 44], ['p2|Zigzagoon', 20, 20], ['p2|Sentret', 19, 19]]),
  active: { p1: 'NUTZZZZZZZ', p2: 'Zigzagoon' },
  name: (side, ident) => (side === 'p1' && ident === 'NUTZZZZZZZ' ? 'Blaze' : ident),
};
const [P1, P2] = ['p1a: NUTZZZZZZZ', 'p2a: Zigzagoon'];

describe('summarizeLog', () => {
  it.each<{ name: string; log: string[]; seed?: Partial<SummarySeed>; lines?: string[]; endHp?: object }>([
    { name: 'a real step: who moved first, damage as % of max HP, crits and the faint',
      log: ['|', `|move|${P2}|Quick Attack|${P1}`, `|-crit|${P1}`, `|-damage|${P1}|35/44`, `|move|${P1}|Scratch|${P2}`, `|-crit|${P2}`, `|-damage|${P2}|0 fnt`, `|faint|${P2}`, '|', '|upkeep'],
      lines: ['Zigzagoon moves first (Quick Attack)', 'Critical hit on Blaze', 'Blaze loses 20.5% (79.5% left)', 'Blaze uses Scratch', 'Critical hit on Zigzagoon', 'Zigzagoon loses 100% (0% left)', 'Zigzagoon fainted'],
      endHp: { p1: end('Blaze', 35, 44, 79.5), p2: end('Zigzagoon', 0, 20, 0) },
    },
    { name: 'a side moving alone "uses"; effectiveness, misses and immunities',
      log: [
        `|move|${P1}|Ember|${P2}`, `|-supereffective|${P2}`, `|-damage|${P2}|8/20`, `|move|${P1}|Ember|${P2}`, `|-resisted|${P2}`, `|-damage|${P2}|7/20`,
        `|move|${P1}|Ember|${P2}`, `|-miss|${P1}|${P2}`, `|move|${P1}|Ember|${P2}`, `|-immune|${P2}|[from] ability: Flash Fire`,
      ],
      lines: [
        'Blaze uses Ember', 'Super effective', 'Zigzagoon loses 60% (40% left)', 'Blaze uses Ember', 'Not very effective', 'Zigzagoon loses 5% (35% left)',
        'Blaze uses Ember', 'Blaze misses', 'Blaze uses Ember', 'Zigzagoon is immune (Flash Fire)',
      ],
    },
    { name: 'statuses, stat changes, items and abilities, with their source',
      seed: { hp: hp([['p1|NUTZZZZZZZ', 44, 44], ['p2|Zigzagoon', 10, 20]]) },
      log: [
        `|move|${P2}|Will-O-Wisp|${P1}`, `|-status|${P1}|brn`, `|-damage|${P1}|40/44|[from] brn`, `|-boost|${P2}|atk|1`,
        `|-unboost|${P1}|spe|2|[from] ability: Intimidate|[of] ${P2}`, `|-enditem|${P2}|Sitrus Berry|[eat]`, `|-heal|${P2}|20/20|[from] item: Sitrus Berry`,
        `|-item|${P1}|Leftovers|[from] move: Trick`, `|-ability|${P2}|Pickup`, `|-activate|${P2}|item: Quick Claw`, `|-curestatus|${P1}|slp|[msg]`,
      ],
      lines: [
        'Zigzagoon uses Will-O-Wisp', 'Blaze is burned', 'Blaze loses 9.1% (90.9% left) (burn)', "Zigzagoon's Attack +1", "Blaze's Speed -2 (Intimidate)",
        "Zigzagoon's Sitrus Berry is used up", 'Zigzagoon heals 50% (100% left) (Sitrus Berry)', 'Blaze holds Leftovers', "Zigzagoon's Pickup shows",
        "Zigzagoon's Quick Claw activates", 'Blaze is cured of sleep',
      ],
    },
    { name: 'switches, drags, weather, field and side effects, and a move that cannot happen',
      log: [
        '|switch|p2a: Sentret|Sentret, L5, M|19/19', `|drag|${P1}|NUTZZZZZZZ, L15, M|30/44`, '|-weather|RainDance', '|-weather|RainDance|[upkeep]',
        '|-fieldstart|move: Trick Room', '|-sidestart|p2: Roark|move: Spikes', `|cant|${P1}|par`, '|-weather|none',
      ],
      lines: ['The trainer sends out Sentret', 'Blaze is dragged out', 'Weather: Rain', 'Trick Room starts', "Spikes set on the trainer's side", "Blaze can't move (paralysis)", 'The weather clears'],
      endHp: { p1: end('Blaze', 30, 44, 68.2), p2: end('Sentret', 19, 19, 100) },
    },
    { name: 'nothing that touched the actives: the seed', log: ['|', '|upkeep'], lines: [], endHp: { p1: end('Blaze', 44, 44, 100) } },
    { name: "the enemy's HP as its bar shows it: 7/200 fills 1 pixel of 48", log: [`|-damage|${P2}|7/200`],
      seed: { hp: hp([['p2|Zigzagoon', 200, 200]]), active: { p1: null, p2: 'Zigzagoon' } },
      endHp: { p1: null, p2: end('Zigzagoon', 7, 200, 2.1) },
    },
    { name: 'confusion and infatuation starting and ending, with their source; a silent one is not said',
      log: [
        `|move|${P1}|Confusion|${P2}`, `|-damage|${P2}|12/20`, `|-start|${P2}|confusion`, `|-start|${P1}|confusion|[fatigue]`, `|-end|${P2}|confusion`,
        `|-start|${P1}|Attract|[from] ability: Cute Charm|[of] ${P2}`, `|-end|${P1}|move: Attract|[from] item: Mental Herb`, `|-start|${P2}|Attract`, `|-end|${P2}|Attract|[silent]`,
      ],
      lines: [
        'Blaze uses Confusion', 'Zigzagoon loses 40% (60% left)', 'Zigzagoon is confused', 'Blaze is confused', 'Zigzagoon snaps out of confusion',
        'Blaze fell in love (Cute Charm)', 'Blaze is no longer in love (Mental Herb)', 'Zigzagoon fell in love',
      ],
    },
    { name: 'any other effect starting or ending, by its name, with what it holds and its source',
      log: [
        `|-start|${P2}|move: Leech Seed`, `|-end|${P2}|Leech Seed|[from] move: Rapid Spin|[of] ${P2}`, `|-start|${P1}|Substitute`, `|-end|${P1}|Substitute`,
        `|-start|${P2}|Disable|Tackle`, `|-start|${P1}|typechange|Fire|[from] ability: Color Change`, `|-start|${P2}|perish3`, `|-start|${P1}|stockpile2`,
        `|-start|${P2}|Uproar|[upkeep]`, `|-start|${P1}|move: Focus Energy|[silent]`,
      ],
      lines: [
        'Leech Seed starts on Zigzagoon', 'Leech Seed ends on Zigzagoon (Rapid Spin)', 'Substitute starts on Blaze', 'Substitute ends on Blaze',
        'Disable starts on Zigzagoon (Tackle)', "Blaze's type is now Fire (Color Change)", "Zigzagoon's perish count is 3", 'Blaze has stockpiled 2',
      ],
    },
    { name: 'a move whose target fainted first (a real step: Selfdestruct) says it had no target',
      log: ['|', '|move|p2a: Deoxys|Selfdestruct|p1a: Machop', '|-damage|p1a: Machop|15/118', '|faint|p2a: Deoxys', '|-kaizoexp|p1a: Machop|1', '|move|p1a: Machop|Tackle|p2: Deoxys|[notarget]', '|-notarget|p1a: Machop', '|', '|upkeep'],
      seed: { hp: hp([['p1|Machop', 118, 118], ['p2|Deoxys', 72, 72]]), active: { p1: 'Machop', p2: 'Deoxys' }, name: (_side, ident) => ident },
      lines: ['Deoxys moves first (Selfdestruct)', 'Machop loses 87.3% (12.7% left)', 'Deoxys fainted', 'Machop uses Tackle (no target)'],
      endHp: { p2: end('Deoxys', 0, 72, 0) },
    },
    { name: 'skips lines it does not know, and reads damage without a known earlier HP as the HP left', seed: { hp: new Map() },
      log: ['|t:|1700000000', '|-hint|something', `|-damage|${P2}|10/20`, `|-singleturn|${P1}|Protect`], lines: ['Zigzagoon at 50%'],
    },
  ])('$name', ({ log, seed, lines, endHp }) => {
    const out = summarizeLog(log, { ...SEED, ...seed });
    if (lines) expect(out.lines).toEqual(lines);
    if (endHp) expect(out.endHp).toMatchObject(endHp);
  });
});

describe('expGains, expToNext and rollsOf', () => {
  const seed = { party: [{ ident: 'PRINPLUP', name: 'Prinplup', level: 21 }, { ident: 'Machop', name: 'Machop', level: 20 }, { ident: 'Chestnut', name: 'Chestnut', level: 19 }] };
  const gain = (index: number, name: string, gained: number, fromLevel: number, more: object = {}) => ({ index, name, gained, boosted: false, fromLevel, toLevel: fromLevel, learned: [], offered: [], ...more });
  it.each([
    ['one gain with a level-up and a learned move', ['|faint|p2a: Magikarp', '|-kaizoexp|p1a: Monferno|684', '|-kaizolevel|p1a: Monferno|31', '|-kaizolearn|p1a: Monferno|Slash'],
      { party: [{ ident: 'Monferno', name: 'Fernando', level: 30 }] }, [gain(0, 'Fernando', 684, 30, { toLevel: 31, learned: ['Slash'] })]],
    ['the bench paid, a traded one boosted, two levels give the last, a move with no room offered',
      ['|-kaizoexp|p1a: PRINPLUP|415', '|-kaizoexp|p1: Chestnut|622|[boosted]', '|-kaizolevel|p1: Chestnut|20', '|-kaizolevel|p1: Chestnut|21', '|-kaizooffer|p1: Chestnut|Bite'],
      seed, [gain(0, 'Prinplup', 415, 21), gain(2, 'Chestnut', 622, 19, { boosted: true, toLevel: 21, offered: ['Bite'] })]],
    ['one paid twice: the EXP adds up, the last level counts, a boost on either pay marks it',
      ['|-kaizoexp|p1a: PRINPLUP|415', '|-kaizolevel|p1a: PRINPLUP|22', '|-kaizolearn|p1a: PRINPLUP|Bubble Beam', '|-kaizoexp|p1a: PRINPLUP|301|[boosted]', '|-kaizolevel|p1a: PRINPLUP|23', '|-kaizooffer|p1a: PRINPLUP|Peck'],
      seed, [gain(0, 'Prinplup', 716, 21, { boosted: true, toLevel: 23, learned: ['Bubble Beam'], offered: ['Peck'] })]],
    ["none for no EXP lines, a name the party lacks, or the trainer's side", ['|move|p1a: PRINPLUP|Peck|p2a: Shuppet', '|-kaizoexp|p1a: Nobody|5', '|-kaizoexp|p2a: Shuppet|5'], seed, []],
    ['none for a level or a move with no EXP line before it', ['|-kaizolevel|p1a: PRINPLUP|22', '|-kaizolearn|p1a: PRINPLUP|Peck'], seed, []],
  ])('expGains: %s', (_name, log, party, expected) => {
    expect(expGains(log, party)).toEqual(expected);
  });

  it('expToNext: what the next level needs, 0 once passed, unknown past 100 or without the data; rollsOf: each roll, other labels skipped', () => {
    const rom = { species: { 394: { growthRate: 3 } }, growth: [[], [], [], Array.from({ length: 101 }, (_, level) => level ** 3)] };
    expect([
      expToNext(rom, 394, 21, 9500), expToNext(rom, 394, 21, 11_000), expToNext(rom, 394, 100, 1_000_000), expToNext(rom, 999, 21, 9500), expToNext({ ...rom, growth: [] }, 394, 21, 9500),
    ]).toEqual([1148, 0, null, null, null]);                                         // 22³ is 10648
    // A roll's damage, "at least the HP left" as null, and what the number is.
    const labels: ChanceLabel[] = [
      { kind: 'roll', side: 'p1', source: 'aquacutter', outcome: '23', rollValue: 'final' }, { kind: 'crit', side: 'p1', source: 'aquacutter', outcome: 'crit' },
      { kind: 'roll', side: 'p2', source: 'tackle', outcome: '≥hp', rollValue: 'final' }, { kind: 'roll', side: 'p1', source: 'ember', outcome: '87', rollValue: 'base' },
      { kind: 'roll', side: 'p2', source: 'tackle', outcome: '12' }, { kind: 'roll', side: null, source: 'x', outcome: '1' },
    ];
    expect(rollsOf(labels, (id) => id.toUpperCase())).toEqual([
      { side: 'p1', move: 'AQUACUTTER', damage: 23, rollValue: 'final' }, { side: 'p2', move: 'TACKLE', damage: null, rollValue: 'final' },
      { side: 'p1', move: 'EMBER', damage: 87, rollValue: 'base' }, { side: 'p2', move: 'TACKLE', damage: 12, rollValue: null },
    ]);
  });
});
