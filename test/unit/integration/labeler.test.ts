import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ChanceLabel, EngineState, Outcome } from '../../../src/contracts/engine.js';
import type { MonRef } from '../../../src/contracts/solver.js';
import { createBattle, expandTurn, installKaizoDex, ONE } from '../../../src/engine/index.js';
import { createLabeler } from '../../../src/integration/labeler.js';
import { BAG, emberTurn, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const FERNANDO = playerMon(ID.monferno, 30, [ID.ember, ID.tackle], { nickname: 'Fernando', location: { kind: 'party', slot: 1 } });
const HAWK = playerMon(ID.zigzagoon, 20, [ID.tackle], { nickname: 'Hawk', location: { kind: 'party', slot: 2 } });
const labeler = (mons: [MonRef, PlayerMon][] = [['party:1', FERNANDO]]) => createLabeler({ moves: fixture.moves, mons: new Map(mons) });
const MOVE_0 = { kind: 'move', slot: 0 } as const;
const zigzagoonParty = (level: number, slot: number, nickname = 'ZIGZAGOON') => playerMon(ID.zigzagoon, level, [ID.tackle], { nickname, location: { kind: 'party', slot } });

/** An outcome with `labels` and `log` only (the labeler reads no more), on `state`. */
const outcomeOf = (state: EngineState, labels: ChanceLabel[], log: string[], fainted: number[] = []): Outcome => ({
  probability: ONE, labels, critBy: { p1: false, p2: false }, unlabelled: false, state, observation: '', log, fainted: { p1: fainted, p2: [] }, merged: 1,
});
const label = (kind: ChanceLabel['kind'], side: ChanceLabel['side'], source: string, outcome: string): ChanceLabel => ({ kind, side, source, outcome });

describe('createLabeler: choices', () => {
  it("names moves by the request's move list (a Showdown name carrying its ID by its own name), and a bag item", () => {
    const state = createBattle(emberTurn([ID.meanLook, ID.tackle]));
    const l = labeler();
    expect([l.choice(state, 'p1', MOVE_0), l.choice(state, 'p1', { kind: 'move', slot: 1 }), l.choice(state, 'p2', { kind: 'move', slot: 1 })])
      .toEqual(['Use Ember', 'Use Tackle', 'Use Tackle']);
    expect(l.choice(state, 'p2', { kind: 'item', item: 'fullrestore' })).toBe('Use Full Restore');
    const SOLAR_BEAM_130 = 130;   // Showdown names it "Solar-Beam (130)"
    expect(l.choice(createBattle(emberTurn([ID.meanLook], { moves: [SOLAR_BEAM_130], pp: [15] })), 'p1', MOVE_0)).toBe('Use Solar-Beam');
  });

  it("names a switch by the party member's page name: its nickname, or its species for the default one", () => {
    const zigzagoon = zigzagoonParty(20, 2);
    const state = createBattle({
      player: [FERNANDO, zigzagoon], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.tackle]), resolvedMon(ID.bidoof, 20, [ID.tackle])]), field: {},
    });
    const l = labeler([['party:1', FERNANDO], ['party:2', zigzagoon]]);
    expect([l.choice(state, 'p1', { kind: 'switch', index: 1 }), l.choice(state, 'p2', { kind: 'switch', index: 1 })]).toEqual(['Switch to Zigzagoon', 'Switch to Bidoof']);
  });

  it('names two Pokémon with the same page name as the resolver does, by level or place, everywhere', () => {
    const [low, high] = [zigzagoonParty(20, 2), zigzagoonParty(22, 3)];
    // Battle order: the level-22 one first, so the engine names it "ZIGZAGOON" and the level-20 one "ZIGZAGOON 2".
    const state = createBattle({ player: [FERNANDO, high, low], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.tackle])]), field: {} });
    const l = labeler([['party:1', FERNANDO], ['party:2', low], ['party:3', high]]);
    expect([1, 2].map((index) => l.choice(state, 'p1', { kind: 'switch', index }))).toEqual(['Switch to Zigzagoon (Lv 22)', 'Switch to Zigzagoon (Lv 20)']);
    const death = outcomeOf(state, [], ['|move|p2a: Zigzagoon|Tackle|p1a: ZIGZAGOON 2', '|-damage|p1a: ZIGZAGOON 2|0 fnt', '|faint|p1a: ZIGZAGOON 2'], [2]);
    expect(l.killCause(death, 2)).toBe('Tackle on turn 2 kills Zigzagoon (Lv 20)');
  });
});

describe('createLabeler: outcomes', () => {
  it("words a step's chance events with the move's name, each outcome differently, and no events as ''", () => {
    const outcomes = expandTurn(createBattle(emberTurn()), { p1: MOVE_0, p2: MOVE_0 });
    const l = labeler();
    const labels = outcomes.map((o) => l.outcome(o));
    expect(new Set(labels).size).toBe(labels.length);
    for (const text of labels) expect(text).toMatch(/^If Ember /);
    for (const words of [/Ember crits/, /Ember burns/, /leaves Zigzagoon at \d+%/]) expect(labels.some((text) => words.test(text)), `${words}`).toBe(true);
    expect(labeler().outcome({ ...outcomes[0]!, labels: [] })).toBe('');
  });

  it('names the Pokémon Roar or Whirlwind brings in, by its page name', () => {
    const rocky = playerMon(ID.bidoof, 20, [ID.tackle], { nickname: 'Rocky', location: { kind: 'party', slot: 3 } });
    const lead = { ...FERNANDO, level: 15, currentHp: 30 };
    const state = createBattle({ player: [lead, HAWK, rocky], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 40, [ID.whirlwind])]), field: {} });
    const labels = expandTurn(state, { p1: MOVE_0, p2: MOVE_0 }).map((o) => labeler([['party:1', lead], ['party:2', HAWK], ['party:3', rocky]]).outcome(o));
    expect([/Whirlwind brings in Hawk/, /Whirlwind brings in Rocky/, /drags out/].map((words) => labels.some((text) => words.test(text)))).toEqual([true, true, false]);
  });

  it.each<{ name: string; labels: ChanceLabel[]; log: string[]; words: string; enemy?: number[]; team?: PlayerMon[] }>([
    {
      name: "matches a roll to its own side's hit (a hit on a Substitute logs no damage)", enemy: [ID.tackle],
      labels: [label('crit', 'p1', 'tackle', 'normal'), label('roll', 'p1', 'tackle', '20'), label('crit', 'p2', 'tackle', 'normal'), label('roll', 'p2', 'tackle', '15')],
      log: ['|move|p1a: Fernando|Tackle|p2a: Zigzagoon', '|-activate|p2a: Zigzagoon|Substitute|[damage]', '|move|p2a: Zigzagoon|Tackle|p1a: Fernando', '|-damage|p1a: Fernando|30/45'],
      words: "If Tackle doesn't crit, Tackle rolls 20, Tackle doesn't crit, Tackle leaves Fernando at 30/45 HP",
    },
    {
      name: "words the collapsed knock-out roll ('≥hp') when the step's log is gone", labels: [label('roll', 'p2', 'megakick', '≥hp')],
      log: ['|switch|p2a: Bidoof|Bidoof, L20, M|60/60'], words: 'If Mega Kick rolls at least the HP left',
    },
    {
      name: 'matches a roll to a move whose Showdown name carries its ID', labels: [label('roll', 'p1', 'solarbeam130', '50')],
      log: ['|move|p1a: Fernando|Solar-Beam (130)|p2a: Zigzagoon', '|-damage|p2a: Zigzagoon|20/55'], words: 'If Solar-Beam leaves Zigzagoon at 36%',
    },
    {
      name: 'names the Pokémon that was out when each chance happened, not one dragged in later', team: [HAWK],
      labels: [label('speedTie', null, 'order', 'p1First'), label('fullPara', 'p1', 'par', 'none'), label('hit', 'p2', 'whirlwind', 'hit'), label('switchTarget', 'p2', 'whirlwind', '1')],
      log: ['|move|p1a: Fernando|Tackle|p2a: Zigzagoon', '|-damage|p2a: Zigzagoon|30/55', '|move|p2a: Zigzagoon|Whirlwind|p1a: Fernando', '|drag|p1a: Hawk|Zigzagoon, L20, M|50/50'],
      words: "If Fernando moves first (speed tie), Fernando isn't fully paralysed, Whirlwind hits, Whirlwind brings in Hawk",
    },
  ])('$name', ({ labels, log, words, enemy, team = [] }) => {
    const mons = [FERNANDO, ...team].map((mon, i): [MonRef, PlayerMon] => [`party:${i + 1}`, mon]);
    expect(labeler(mons).outcome(outcomeOf(createBattle(emberTurn(enemy)), labels, log))).toBe(words);
  });
});

describe('createLabeler: kill causes', () => {
  it('names the move, the turn and the victim, and says when an enemy crit did it', () => {
    // Monferno at 1 HP: Zigzagoon's Tackle, after Monferno's Ember, kills it whatever the rolls.
    const state = createBattle(emberTurn([ID.tackle], { currentHp: 1, nickname: 'Fernando' }));
    const deaths = expandTurn(state, { p1: MOVE_0, p2: MOVE_0 }).filter((o: Outcome) => o.fainted.p1.length > 0);
    const l = labeler();
    const causes = new Set(deaths.map((o) => l.killCause(o, 3)));
    expect([...causes]).toEqual(expect.arrayContaining(['Tackle on turn 3 kills Fernando', 'enemy crit Tackle on turn 3 kills Fernando']));
  });

  it.each([
    ['Future Sight', ['|-end|p1a: Fernando|move: Future Sight', '|-damage|p1a: Fernando|0 fnt', '|faint|p1a: Fernando']],
    ['Doom Desire', ['|-end|p1a: Fernando|move: Doom Desire', '|-damage|p1a: Fernando|0 fnt', '|faint|p1a: Fernando']],
    ['Destiny Bond', ['|-damage|p2a: Zigzagoon|0 fnt', '|faint|p2a: Zigzagoon', '|-activate|p2a: Zigzagoon|move: Destiny Bond', '|faint|p1a: Fernando']],
    ['Perish Song', ['|-start|p1a: Fernando|perish0', '|faint|p1a: Fernando']],
  ])('names %s, which leaves no [from] damage line', (move, lines) => {
    const outcome = outcomeOf(createBattle(emberTurn()), [], ['|move|p1a: Fernando|Tackle|p2a: Zigzagoon', ...lines], [0]);
    expect(labeler().killCause(outcome, 4)).toBe(`${move} on turn 4 kills Fernando`);
  });
});
