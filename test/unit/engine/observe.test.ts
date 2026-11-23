import { beforeAll, describe, expect, it } from 'vitest';
import type { Choice, EngineState } from '../../../src/contracts/engine.js';
import { applyChoices, createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { showdownEngine } from '../../../src/engine/index.js';
import { observe } from '../../../src/engine/observe.js';
import { BAG, emberTurn, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH = { p1: move(0), p2: move(0) };
const LEFTOVERS = 234;
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
const view = (state: EngineState) => showdownEngine.observe(state);
const parsed = (observation: string) => JSON.parse(observation);
/** The cartridge's HP bar: 48 pixels, rounded down, at least 1 while HP is left. */
const pixels = (hp: number, max: number) => (hp === 0 ? 0 : Math.max(1, Math.floor((48 * hp) / max)));

describe('observation hides exact enemy HP and counters', () => {
  it('enemy HP within one HP-bar pixel looks the same, the next pixel does not; the player sees his own exact HP', () => {
    const state = createBattle(emberTurn());
    const max = restore(state).p2.active[0]!.maxhp;
    let low = 1;
    while (pixels(low, max) !== pixels(low + 1, max)) low++;
    const at = (hp: number) => changed(state, (battle) => { battle.p2.active[0]!.hp = hp; });
    expect(at(low).key).not.toBe(at(low + 1).key);
    expect(view(at(low))).toBe(view(at(low + 1)));
    expect(parsed(view(at(low))).enemy.active.pixels).toBe(pixels(low, max));
    let other = low + 1;
    while (pixels(other, max) === pixels(low, max)) other++;
    expect(view(at(other))).not.toBe(view(at(low)));
    const mineMax = restore(state).p1.active[0]!.maxhp;
    const mineAt = (hp: number) => changed(state, (battle) => { battle.p1.active[0]!.hp = hp; });
    expect(view(mineAt(mineMax - 1))).not.toBe(view(mineAt(mineMax - 2)));
    expect(parsed(view(mineAt(mineMax - 1))).player[0]).toMatchObject({ species: 'Monferno', hp: mineMax - 1, maxhp: mineMax, active: true });
  });

  it('hidden counters do not show: PP, a confusion counter, a sleep counter', () => {
    const state = runFirstOutcome(createBattle(emberTurn([ID.tackle])), { p1: move(1), p2: move(0) });
    const foeWith = (change: (foe: Pokemon) => void) => changed(state, (battle) => change(battle.p2.active[0]!));
    const confused = (time: number) => foeWith((foe) => { foe.addVolatile('confusion'); foe.volatiles['confusion']!.time = time; });
    const asleep = (time: number) => foeWith((foe) => { foe.setStatus('slp'); foe.statusState.time = time; });
    for (const [a, b] of [[state, foeWith((foe) => { foe.moveSlots[0]!.pp -= 1; })], [confused(2), confused(4)], [asleep(1), asleep(3)]]) {
      expect(a!.key).not.toBe(b!.key);
      expect(view(a!)).toBe(view(b!));
    }
    expect(parsed(view(asleep(1))).enemy.active.status).toBe('slp');
  });

  it('a crit shows even when it deals the same damage', () => {
    const outcomes = expandTurn(changed(createBattle(emberTurn()), (battle) => { battle.p2.active[0]!.hp = 1; }), { p1: move(1), p2: move(0) }); // any Tackle KOs
    const [crit, plain] = [outcomes.find((outcome) => outcome.critBy.p1)!, outcomes.find((outcome) => !outcome.critBy.p1)!];
    expect([crit, plain].map((outcome) => restore(outcome.state).p2.pokemon[0]!.hp)).toEqual([0, 0]);
    expect(crit.observation).not.toBe(plain.observation);
    const tackle = (observation: string) => parsed(observation).events.find((event: { line?: string }) => event.line === '|move|p1a: Monferno|Tackle|p2a: Zigzagoon');
    expect(tackle(crit.observation)).toEqual({ line: '|move|p1a: Monferno|Tackle|p2a: Zigzagoon', crit: true, miss: false, effectiveness: [], damaged: ['p2a: Zigzagoon'] });
    expect(tackle(plain.observation)).toMatchObject({ crit: false, damaged: ['p2a: Zigzagoon'] });
  });

  it('per-hit damage dropped: two hit sequences with one end state look the same', () => {
    // The trainer's Fury Attack hits three times; swapping its first two hits' rolls ends in the same state.
    const state = createBattle({ player: [playerMon(ID.monferno, 30, [ID.meanLook])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 30, [ID.furyAttack])]), field: {} });
    const run = (script: number[]) => {
      const driver = new ChanceDriver(script);
      const battle = restore(state, driver);
      applyChoices(battle, BOTH);
      return { battle, points: driver.points, after: snapshot(battle) };
    };
    const first = run([]);
    const hits = first.points.findIndex((point) => point.kind === 'multiHit');
    expect(hits).toBeGreaterThanOrEqual(0);
    // Three hits, no crits: multiHit option 1, then each hit's crit (option 1, normal) and roll.
    const prefix = [...first.points.slice(0, hits).map((point) => point.chosen), 1];
    const sequence = (rolls: number[]) => run([...prefix, ...rolls.flatMap((roll) => [1, roll])]);
    const normal = run([...prefix, 1]).points[prefix.length + 1]!;
    expect(normal.kind).toBe('roll');
    const last = normal.options.length - 1; // the lowest roll
    expect(last).toBeGreaterThan(0);
    const [a, b] = [sequence([0, last, 0]), sequence([last, 0, 0])];
    expect(a.points.filter((point) => point.kind === 'roll').map((point) => point.chosen)).toEqual([0, last, 0]);
    expect([a.battle.p1.active[0]!.hp, a.after.key]).toEqual([b.battle.p1.active[0]!.hp, b.after.key]);
    const damage = (outcome: { battle: Battle }) => outcome.battle.log.filter((line) => line.startsWith('|-damage|'));
    expect(damage(a)).not.toEqual(damage(b));
    expect(observe(a.battle, a.battle.log)).toBe(observe(b.battle, b.battle.log));
    const events = parsed(observe(a.battle, a.battle.log)).events;
    expect(events.find((event: { line?: string }) => event.line?.includes('|Fury Attack|'))).toMatchObject({ crit: false, miss: false, damaged: ['p1a: Monferno'] });
    expect(events).toContain('|-hitcount|p1a: Monferno|3');
  });

  it('rendering rules, byte for byte: what a move event absorbs, what loses its HP field, what stays', () => {
    // observe.ts's predicates on hand-written lines (no |split| blocks; the only trainer Pokémon is Zigzagoon).
    const lines = [
      '|-damage|p2a: Zigzagoon|30/48', // before the first move line: a line, without its HP
      '|-crit|p2a: Zigzagoon', // before the first move line: as it is
      '|move|p1a: Monferno|Tackle|p2a: Zigzagoon', '|-supereffective|p2a: Zigzagoon', '|-resisted|p2a: Zigzagoon|[from] anything', '|-crit|p2a: Zigzagoon',
      '|-damage|p2a: Zigzagoon|20/48', '|-damage|p2a: Zigzagoon|10/48 par', // the same ident again: no duplicate
      '|-immune|p2a: Zigzagoon|[from] ability: Levitate', // four fields: a line
      '|-immune|p1a: Monferno', // three: absorbed
      '|-damage|p1a: Monferno|50/87|[from] Recoil', '|-heal|p1a: Monferno|60/87|[from] drain', // five fields: a line, without HP
      '|-damage|p2a: Zigzagoon|garbage', // no HP value: as it is
      '|-miss|p1a: Monferno|p2a: Zigzagoon', '|upkeep',
      '|-damage|p1a: Monferno|0 fnt', // after the turn's end (a Future Sight hit): still the open move event's
      '|move|p2a: Zigzagoon|Growl|p1a: Monferno', '|-sethp|p2a: Zigzagoon|40/48|[from] move: Pain Split', '|-unboost|p1a: Monferno|atk|1',
    ];
    const observation = observe(restore(createBattle(emberTurn())), lines);
    expect(parsed(observation).events).toEqual([
      '|-damage|p2a: Zigzagoon', '|-crit|p2a: Zigzagoon',
      { line: '|move|p1a: Monferno|Tackle|p2a: Zigzagoon', crit: true, miss: true, effectiveness: ['immune', 'resisted', 'super'], damaged: ['p1a: Monferno', 'p2a: Zigzagoon'] },
      '|-immune|p2a: Zigzagoon|[from] ability: Levitate', '|-damage|p1a: Monferno|[from] Recoil', '|-heal|p1a: Monferno|[from] drain', '|-damage|p2a: Zigzagoon|garbage', '|upkeep',
      { line: '|move|p2a: Zigzagoon|Growl|p1a: Monferno', crit: false, miss: false, effectiveness: [], damaged: [] },
      '|-sethp|p2a: Zigzagoon|[from] move: Pain Split', '|-unboost|p1a: Monferno|atk|1',
    ]);
    // The canonical bytes of a move event: keys sorted, no whitespace.
    expect(observation).toContain('{"crit":true,"damaged":["p1a: Monferno","p2a: Zigzagoon"],"effectiveness":["immune","resisted","super"],'
      + '"line":"|move|p1a: Monferno|Tackle|p2a: Zigzagoon","miss":true}');
    // The reveals fold reads the same lines: Growl, and the ability a [from] field names.
    expect(parsed(observation).enemy.revealed).toEqual({ Zigzagoon: { moves: ['Growl'], ability: 'Levitate', item: null, itemGone: false } });
    expect(parsed(observation).enemy.active).toMatchObject({ species: 'Zigzagoon', gender: 'M' });
  });

  it('rendering is a pure function of the end state and the step\'s lines: any leaf order gives the same bytes', () => {
    const state = createBattle(emberTurn([ID.tackle]));
    const leaves: { state: EngineState; log: string[]; live: string }[] = [];
    for (let script: number[] | null = []; script !== null && leaves.length < 40;) {
      const driver = new ChanceDriver(script);
      const battle = restore(state, driver);
      applyChoices(battle, { p1: move(1), p2: move(0) });
      leaves.push({ state: snapshot(battle), log: [...battle.log], live: observe(battle, battle.log) });
      script = nextScript(driver.points);
    }
    expect(leaves.length).toBeGreaterThan(10);
    const forward = leaves.map((leaf) => observe(restore(leaf.state), leaf.log));
    expect(forward).toEqual(leaves.map((leaf) => leaf.live));
    expect([...leaves].reverse().map((leaf) => observe(restore(leaf.state), leaf.log)).reverse()).toEqual(forward);
  });

  it('step events: the moves with their flags, no HP in any line, no exact enemy HP, no timestamps', () => {
    const battle = restore(createBattle(emberTurn([ID.tackle])));
    applyChoices(battle, { p1: move(1), p2: move(0) });
    snapshot(battle);
    const observation = observe(battle, battle.log);
    const events: (string | { line: string })[] = parsed(observation).events;
    const theirs = battle.p2.active[0]!;
    expect(battle.log.some((line) => line.startsWith('|-damage|p2a: Zigzagoon|'))).toBe(true);
    for (const [user, target] of [['p1a: Monferno', 'p2a: Zigzagoon'], ['p2a: Zigzagoon', 'p1a: Monferno']]) {
      expect(events).toContainEqual({ line: `|move|${user}|Tackle|${target}`, crit: true, miss: false, effectiveness: [], damaged: [target] });
    }
    const lines = events.filter((event): event is string => typeof event === 'string');
    expect([lines.some((line) => line.startsWith('|-damage|') || line.startsWith('|-crit|')), observation.includes(`${theirs.hp}/${theirs.maxhp}`), lines.some((line) => /^\|(t:|split|-hint)\|/.test(line))])
      .toEqual([false, false, false]);
    expect(parsed(observation).enemy.active.pixels).toBe(pixels(theirs.hp, theirs.maxhp)); // the bar shows in the end state
  });

  it('two enemies of one species go by the species name, as on screen', () => {
    const ko = runFirstOutcome(createBattle({
      player: [playerMon(ID.deoxys, 50, [ID.waterBall])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 5, [ID.tackle]), resolvedMon(ID.zigzagoon, 5, [ID.tackle])]), field: {},
    }), BOTH);
    expect(ko.phase).toEqual({ kind: 'enemyReplacement' });
    const [replaced] = expandTurn(ko, { p2: { kind: 'switch', index: 1 } });
    const max = restore(ko).p2.pokemon.find((pokemon) => pokemon.name === 'Zigzagoon 2')!.maxhp;
    expect(replaced!.log).toContain(`|switch|p2a: Zigzagoon 2|Zigzagoon, L5, M|${max}/${max}`); // the omniscient log keeps Showdown's names
    const seen = parsed(replaced!.observation);
    expect([seen.events.includes('|switch|p2a: Zigzagoon|Zigzagoon, L5, M|48/48'), replaced!.observation.includes('Zigzagoon 2'), seen.enemy.fainted]).toEqual([true, false, 1]);
  });

  it('a trainer Pokémon\'s Showdown name shows nowhere, bare names included (Beat Up\'s [of], Wish\'s [wisher])', () => {
    // Two identical Zigzagoons: nothing on screen tells them apart.
    const twins = [resolvedMon(ID.zigzagoon, 20, [ID.beatUp]), resolvedMon(ID.zigzagoon, 20, [ID.beatUp])];
    const battle = restore(createBattle({ player: [playerMon(ID.monferno, 30, [ID.meanLook])], trainer: resolvedTrainer(BAG.none, twins), field: {} }));
    applyChoices(battle, BOTH);
    snapshot(battle);
    const log = [...battle.log];
    expect(log).toContain('|-activate|p2a: Zigzagoon|move: Beat Up|[of] Zigzagoon 2'); // Showdown's own log names the twin
    const seen = observe(battle, log);
    expect(seen).not.toContain('Zigzagoon 2');
    expect(parsed(seen).events.filter((line: unknown) => typeof line === 'string' && line.includes('move: Beat Up'))).toEqual(Array(2).fill('|-activate|p2a: Zigzagoon|move: Beat Up|[of] Zigzagoon'));
    // Had the other twin been out, its hitters would come the other way round: the observation is the same.
    const otherTwin = (line: string) => (line.endsWith('[of] Zigzagoon 2') ? line.slice(0, -2) : line.endsWith('[of] Zigzagoon') ? `${line} 2` : line);
    expect(log.map(otherTwin)).not.toEqual(log);
    expect(observe(battle, log.map(otherTwin))).toBe(seen);
    // Wish names its user bare too.
    const wished = (wisher: string) => observe(battle, [...log, '|split|p2', `|-heal|p2a: Zigzagoon|51/51|[from] move: Wish|[wisher] ${wisher}`, `|-heal|p2a: Zigzagoon|48/48|[from] move: Wish|[wisher] ${wisher}`]);
    expect(wished('Zigzagoon 2')).toBe(wished('Zigzagoon'));
    expect(wished('Zigzagoon 2')).not.toContain('Zigzagoon 2');
  });

  it('the enemy\'s revealed moves and item accumulate; the trainer\'s bag items are not held items', () => {
    // The player's Mean Look keeps the foe alive through each chance's first outcome.
    const state = createBattle({ ...emberTurn([ID.tackle, ID.meanLook]), player: [playerMon(ID.monferno, 30, [ID.meanLook])] });
    expect(parsed(view(state)).enemy.revealed).toEqual({});
    const next = runFirstOutcome(state, BOTH);
    expect(parsed(view(next)).enemy.revealed).toEqual({ Zigzagoon: { moves: ['Tackle'], ability: null, item: null, itemGone: false } });
    expect(parsed(view(runFirstOutcome(next, { p1: move(0), p2: move(1) }))).enemy.revealed.Zigzagoon.moves).toEqual(['Mean Look', 'Tackle']);
    const leftovers = createBattle({ ...emberTurn(), trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook], { item: LEFTOVERS })]) });
    expect(parsed(view(runFirstOutcome(leftovers, { p1: move(1), p2: move(0) }))).enemy.revealed.Zigzagoon.item).toBe('Leftovers');
    const hurt = changed(createBattle({ ...emberTurn(), trainer: resolvedTrainer(BAG.fullRestore, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook])]) }), (battle) => { battle.p2.active[0]!.hp = 5; });
    expect(parsed(view(runFirstOutcome(hurt, { p1: move(1), p2: { kind: 'item', item: 'fullrestore' } }))).enemy.revealed.Zigzagoon?.item ?? null).toBeNull();
  });
});
