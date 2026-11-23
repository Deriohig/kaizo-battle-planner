// The pure parts of line.ts, tree.ts and api.ts: a move's damage and KO words, the turn order, their reply's rows, exact
// odds, saved plans as read, and errors in plain words. Moves come from the fake line server's `damage()`: Scratch,
// 22–27 HP (44–54%), on a crit up to 54 HP (108%).

import { describe, expect, it } from 'vitest';
import type { LineAiChoiceJson, LineDamageJson, LineMoveDamageJson, LineNodeJson, LineOrderJson, LineRationalJson } from '../../../src/server/apiTypes';
import { ApiError, expandLine, getLineNode, NO_ANSWER, nextLine, startLine, streamExtract } from '../../../web/src/api';
import {
  choiceName, critMaxText, koLines, koText, koTitle, mayNotMove, moveText, type PathStep, priorityText, rangeText, readSaved, turnOrderOf, turnOrderText,
} from '../../../web/src/line';
import { likeliestMove, replyRows, sumOdds, timesOdds } from '../../../web/src/tree';
import { damage, lineServer, NOT_WON, r, view } from './lineServer';
import { box, liveStream, stubFetch, TRISTAN } from './stubServer';

const ZERO = r(0, 1);
const ONE = r(1, 1);
const ALL = [ONE, ONE, ONE, ONE];
const NONE = [ZERO, ZERO, ZERO, ZERO];
/** Exact fractions, one per pair. */
const K = (...p: [number, number][]) => p.map(([n, den]) => r(n, den));
const SASH = 'Focus Sash: survives one hit from full HP';
const M0 = { kind: 'move' as const, slot: 0 };

describe("a move's words", () => {
  it.each<[Partial<LineMoveDamageJson>, string]>([
    [{ koExact: ALL, koCritExact: ONE }, 'OHKO 100%'],
    [{ koExact: K([1, 16], [1, 1], [1, 1], [1, 1]), koCritExact: r(1, 16) }, 'OHKO 6.25%'],
    [{ koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: ONE }, 'OHKO 18.75% · on a crit 100%'],
    [{ koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: r(1, 2) }, 'No OHKO without a crit · on a crit 50% · 2HKO 39.84%'],
    [{ koExact: NONE, koCritExact: r(1, 2) }, 'No OHKO without a crit · on a crit 50%'],
    [{ koExact: K([0, 1], [0, 1], [1, 1], [1, 1]), koCritExact: ZERO }, '3HKO 100%'],
    [{ koExact: NONE, koCritExact: ZERO }, 'No KO in 4 hits without a crit'],
    [{ status: true, percent: null, koExact: null, koCritExact: null }, 'Status move'],
    [{ percent: null, koExact: null, koCritExact: null, note: "can't calculate here: an effect the calculator leaves out", hitChance: 0.9 }, "can't calculate here: an effect the calculator leaves out"],
    // A move that can miss never shows a bare 100%; one with a range and no KO figures still says it can miss.
    [{ hitChance: 0.85, koExact: ALL, koCritExact: ONE }, 'Hits 85% · if it hits: OHKO 100%'],
    [{ hitChance: 0.85, ko: null, koCrit: null, koExact: null, koCritExact: null }, 'Hits 85%'],
    // A held item that survives one hit is said after any one-hit claim, and only then.
    [{ koExact: ALL, koCritExact: ONE, survives: 'Focus Sash' }, `OHKO 100% · ${SASH}`],
    [{ koExact: ALL, koCritExact: ONE, survives: 'Focus Sash', hitChance: 0.85 }, `Hits 85% · if it hits: OHKO 100% · ${SASH}`],
    [{ koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: ONE, survives: 'Focus Sash' }, `OHKO 18.75% · on a crit 100% · ${SASH}`],
    [{ koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: r(1, 2), survives: 'Focus Sash' }, `No OHKO without a crit · on a crit 50% · 2HKO 39.84% · ${SASH}`],
    [{ koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: ZERO, survives: 'Focus Sash' }, '2HKO 39.84%'],
    [{ koExact: NONE, koCritExact: ZERO, survives: 'Focus Sash' }, 'No KO in 4 hits without a crit'],
    // No crit figure from the server: none is borrowed.
    [{ koExact: ALL, koCritExact: null }, 'OHKO 100%'],
    [{ koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: null }, 'OHKO 18.75%'],
    [{ koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: null }, '2HKO 39.84%'],
    [{ koExact: NONE, koCritExact: null }, 'No KO in 4 hits without a crit'],
  ])('koText of %j is "%s"', (over, text) => {
    expect(koText(damage(over))).toBe(text);
  });

  it('a move with no `survives` key at all reads as no held item', () => {
    const bare = (over: Partial<LineMoveDamageJson>) => {
      const m: Partial<LineMoveDamageJson> = damage(over);
      delete m.survives;
      return m as LineMoveDamageJson;
    };
    expect(koText(bare({ koExact: ALL, koCritExact: ONE }))).toBe('OHKO 100%');
    expect(koText(bare({}))).toBe('No OHKO without a crit · on a crit 50% · 2HKO 39.84%');
    expect(replyRows(replyNode([bare({ name: 'A', koExact: ALL, koCritExact: ONE })], [pick('A', ONE)]))[0]).toMatchObject({ tone: 'danger', ko: 'Can KO you: OHKO 100%' });
    expect(replyRows(replyNode([bare({ name: 'A' })], [pick('A', ONE)]))[0]).toMatchObject({ tone: 'warn', ko: 'Can KO you on a crit: on a crit 50% · 2HKO 39.84%' });
  });

  it.each<[Partial<LineMoveDamageJson>, string[]]>([
    [{ hitChance: 0.85, koExact: ALL, koCritExact: null }, ['85% to hit', 'OHKO 100%']],
    [{ koExact: ALL, koCritExact: null }, ['OHKO 100%']],
    [{ koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: ONE }, ['OHKO 18.75%', 'Crit: OHKO 100%']],
    [{ koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: r(1, 2) }, ['No OHKO · 2HKO 39.84%', 'Crit: OHKO 50%']],
    [{ koExact: NONE, koCritExact: null }, ['No KO in 4 hits']],
    // No crit line when the crit chance equals the plain one, or is unknown.
    [{ koExact: ALL, koCritExact: ONE }, ['OHKO 100%']],
    [{ koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: r(3, 16) }, ['OHKO 18.75%']],
    [{ koExact: K([0, 1], [1, 1], [1, 1], [1, 1]), koCritExact: ZERO }, ['No OHKO · 2HKO 100%']],
    [{ koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: null }, ['OHKO 18.75%']],
    [{ koExact: K([1, 2], [1, 1], [1, 1], [1, 1]), koCritExact: ZERO }, ['OHKO 50%', 'Crit: no OHKO']],
    // The Sash line only comes with an OHKO claim.
    [{ koExact: ALL, koCritExact: null, survives: 'Focus Sash' }, ['OHKO 100%', 'Focus Sash: survives 1 hit']],
    [{ koExact: K([0, 1], [1, 1], [1, 1], [1, 1]), koCritExact: ONE, survives: 'Focus Sash' }, ['No OHKO · 2HKO 100%', 'Crit: OHKO 100%', 'Focus Sash: survives 1 hit']],
    [{ koExact: K([0, 1], [1, 1], [1, 1], [1, 1]), koCritExact: null, survives: 'Focus Sash' }, ['No OHKO · 2HKO 100%']],
    [{ status: true, percent: null }, ['Status move']],
    [{ percent: null, note: 'Depends on the hit it takes' }, ['Depends on the hit it takes']],
    [{ koExact: null }, []],
    [{ koExact: null, hitChance: 0.9 }, ['90% to hit']],
  ])('koLines of %j', (over, lines) => {
    expect(koLines(damage({ koExact: NONE, koCritExact: null, ...over }))).toEqual(lines);
  });

  it.each<[Partial<LineMoveDamageJson>, string]>([
    [{}, '22–27 HP (44–54%) · on a crit up to 54 HP (108%)'],
    [{ critHp: null, critPercent: null }, '22–27 HP (44–54%)'],
    [{ multiHit: true }, '22–27 HP (44–54%) · if every hit crits, up to 54 HP (108%)'],
    [{ hp: [40, 40], percent: [40, 40] }, '40 HP (40%) · on a crit up to 54 HP (108%)'],
    [{ hp: [0, 0], percent: [0, 0], critHp: null }, '0 HP'],
    [{ hp: null, percent: [44, 54] }, '44–54% · on a crit up to 54 HP (108%)'],
    [{ hp: null, percent: [40, 40] }, '40% · on a crit up to 54 HP (108%)'],
    [{ hp: null, percent: null }, ''],
  ])('rangeText of %j is "%s"', (over, text) => {
    expect(rangeText(damage(over))).toBe(text);
  });

  it.each<[Partial<LineMoveDamageJson>, string]>([
    [{ critHp: [27, 32], critPercent: [54, 64] }, ' · on a crit up to 32 HP (64%)'],
    [{ critHp: [27, 32], critPercent: [54, 64.04] }, ' · on a crit up to 32 HP (64%)'],
    [{ critHp: [27, 32], critPercent: [10, 12.25] }, ' · on a crit up to 32 HP (12.3%)'],
    // The server sends crit figures only where a crit can land, so an equal top is a real crit's.
    [{ hp: [40, 40], percent: [40, 40], critHp: [40, 40], critPercent: [40, 40] }, ' · on a crit up to 40 HP (40%)'],
    [{ multiHit: true, critHp: [54, 64], critPercent: [108, 128] }, ' · if every hit crits, up to 64 HP (128%)'],
    [{ multiHit: false, critHp: [54, 64], critPercent: [108, 128] }, ' · on a crit up to 64 HP (128%)'],
    [{ critHp: null }, ''],
    [{ critPercent: null }, ''],
    [{ critHp: [0, 0] }, ''],
  ])('critMaxText of %j is "%s"', (over, text) => {
    expect(critMaxText(damage(over))).toBe(text);
  });

  it('moveText, koTitle, priorityText and mayNotMove', () => {
    const miss = damage({ hitChance: 0.85, ko: null, koCrit: null, koExact: null, koCritExact: null });
    expect(moveText(miss)).toBe('22–27 HP (44–54%) · on a crit up to 54 HP (108%) · Hits 85%');
    expect(moveText({ ...miss, hitChance: 1 })).toBe('22–27 HP (44–54%) · on a crit up to 54 HP (108%)');
    expect(moveText(damage({ hitChance: 0.85, koExact: ALL, koCritExact: ONE }))).toBe('22–27 HP (44–54%) · on a crit up to 54 HP (108%) · Hits 85% · if it hits: OHKO 100%');
    expect(koTitle(damage({}))).toBe('1 hit 0/1 · 2 hits 51/128 · 3 hits 1/1 · 4 hits 1/1 · on a crit 1/2');
    expect(koTitle(miss)).toBeUndefined();
    expect(koTitle(damage({ status: true, percent: null, koExact: null, koCritExact: null }))).toBeUndefined();
    expect([1, 2, -1, 0].map(priorityText)).toEqual(['Priority +1', 'Priority +2', 'Priority -1', null]);
    // Only sleep, freezing and paralysis stop it moving.
    const blaze = (status: string | null) => view({ me: { status } }).player.active;
    expect(mayNotMove(blaze('asleep'))).toBe('Blaze is asleep: it may not move.');
    expect(mayNotMove(blaze('frozen'))).toBe('Blaze is frozen: it may not move.');
    for (const active of [blaze('burned'), blaze(null), null]) expect(mayNotMove(active)).toBeNull();
    expect(choiceName({ kind: 'move', slot: 0 }, 'Use Scratch')).toBe('Scratch');
    expect(choiceName({ kind: 'item', item: 'potion' }, 'Use Potion')).toBe('Use Potion');
    expect(choiceName({ kind: 'switch', index: 1 }, 'Switch to Bench')).toBe('Switch to Bench');
  });
});

describe('the turn order', () => {
  const o = (first: LineOrderJson['first'], player: number, enemy: number, changers: string[] = []): LineOrderJson => ({ first, player, enemy, changers });
  it.each<[LineOrderJson | null, number[], string]>([
    [o('player', 26, 21), [0, 0], 'You move first · Speed 26 vs 21'],
    [o('enemy', 16, 21), [0], 'It moves first · Speed 16 vs 21'],
    [o('tie', 21, 21), [0], 'Speed tie at 21: either moves first'],
    [null, [1], 'Speed order not worked out here.'],
    [o('player', 16, 21), [0], 'You move first · Speed 16 vs 21'],                                   // `first` under Trick Room
    // "at equal priority" on a first-mover form when any move has a priority other than 0
    [o('player', 26, 21), [0, 1], 'You move first · Speed 26 vs 21 · at equal priority'],
    [o('player', 26, 21), [-6], 'You move first · Speed 26 vs 21 · at equal priority'],
    [o('enemy', 26, 21), [-6, 0], 'It moves first · Speed 26 vs 21 · at equal priority'],
    [o('tie', 21, 21), [1], 'Speed tie at 21: either moves first'],
    [o('player', 26, 21), [], 'You move first · Speed 26 vs 21'],
    // a Quick Claw or Custap Berry that can change the order
    [o('enemy', 26, 21, ['Quick Claw']), [0], 'It moves first · Speed 26 vs 21 · Quick Claw can change this'],
    [o('tie', 21, 21, ['Quick Claw', 'Custap Berry']), [0], 'Speed tie at 21: either moves first · Quick Claw or Custap Berry can change this'],
    [o('player', 16, 21, ['Custap Berry']), [0, 3], 'You move first · Speed 16 vs 21 · at equal priority · Custap Berry can change this'],
  ])('turnOrderText(%j, %j)', (order, priorities, text) => {
    expect(turnOrderText(order, priorities)).toBe(text);
  });

  it("turnOrderOf reads the damage's order and every move's priority on both sides", () => {
    const numbers = (yours: number[], theirs: number[], order: LineOrderJson | null = o('player', 26, 21)): LineDamageJson => ({
      against: 'Blaze', order, yours: yours.map((priority, slot) => damage({ slot, priority })), theirs: theirs.map((priority) => damage({ priority })),
    });
    expect(turnOrderOf(undefined)).toBeNull();
    expect(turnOrderOf(numbers([0, 0], [0]))).toBe('You move first · Speed 26 vs 21');
    expect(turnOrderOf(numbers([0], [0, 1]))).toBe('You move first · Speed 26 vs 21 · at equal priority');
    expect(turnOrderOf(numbers([3], [0]))).toBe('You move first · Speed 26 vs 21 · at equal priority');
    expect(turnOrderOf(numbers([0], [0], null))).toBe('Speed order not worked out here.');
  });
});

const pick = (label: string, p: LineRationalJson): LineAiChoiceJson => ({ label, probability: p, percent: Number(p.num) / Number(p.den) * 100 });
function replyNode(theirs: LineMoveDamageJson[], choices?: LineAiChoiceJson[]): LineNodeJson {
  return {
    phase: 'turnChoice', aiOdds: choices === undefined ? undefined : { kind: 'turn', choices },
    damage: { yours: [], theirs, against: 'Prinplup', order: null },
  } as unknown as LineNodeJson;
}
const plainMove = (name: string, over: Partial<LineMoveDamageJson> = {}) => damage({ name, koExact: NONE, koCritExact: ZERO, ...over });

describe("their reply's rows", () => {
  it('sort by the AI odds, highest first, an exact 0% last; equal odds by name', () => {
    const n = replyNode(['Flame Wheel', 'Selfdestruct', 'Earth Power', 'AncientPower'].map((name) => plainMove(name)),
      [pick('AncientPower', r(4702, 10000)), pick('Earth Power', r(4258, 10000)), pick('Selfdestruct', r(104, 1000)), pick('Flame Wheel', ZERO)]);
    expect(replyRows(n).map((x) => x.name)).toEqual(['AncientPower', 'Earth Power', 'Selfdestruct', 'Flame Wheel']);
    const tie = replyNode([plainMove('Tackle'), plainMove('Bite')], [pick('Tackle', r(1, 2)), pick('Bite', r(1, 2))]);
    expect(replyRows(tie).map((x) => x.name)).toEqual(['Bite', 'Tackle']);
  });

  it.each<[string, Partial<LineMoveDamageJson>, LineRationalJson | undefined, { tone: string | null; ko: string }]>([
    ['a move that can KO is danger', { koExact: ALL, koCritExact: ONE }, ONE, { tone: 'danger', ko: 'Can KO you: OHKO 100%' }],
    ['a move that can only KO on a crit is warn', { koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: r(1, 2) }, ONE,
      { tone: 'warn', ko: 'Can KO you on a crit: on a crit 50% · 2HKO 39.84%' }],
    ['a crit KO that can miss is warn', { hitChance: 0.85, koExact: NONE, koCritExact: r(1, 2) }, ONE, { tone: 'warn', ko: 'Can KO you on a crit: Hits 85% · if it hits: on a crit 50%' }],
    ['any other row has no tone', { koExact: NONE, koCritExact: ZERO }, ONE, { tone: null, ko: 'No KO in 4 hits without a crit' }],
    ['a status move has no tone', { status: true, percent: null, hp: null, koExact: null, koCritExact: null }, ONE, { tone: null, ko: 'Status move' }],
    // A sure OHKO a Focus Sash survives leaves him at 1 HP, which weather or poison can finish: warn, never "Can KO you".
    ['a Sash-survived OHKO is warn', { koExact: ALL, koCritExact: ONE, survives: 'Focus Sash' }, ONE, { tone: 'warn', ko: `OHKO 100% · ${SASH}` }],
    ['a Sash-survived partial OHKO is warn', { koExact: K([3, 16], [1, 1], [1, 1], [1, 1]), koCritExact: ONE, survives: 'Focus Sash' }, undefined,
      { tone: 'warn', ko: `OHKO 18.75% · on a crit 100% · ${SASH}` }],
    ['a Sash-survived crit-only KO has no tone', { koExact: K([0, 1], [51, 128], [1, 1], [1, 1]), koCritExact: r(1, 2), survives: 'Focus Sash' }, undefined,
      { tone: null, ko: `No OHKO without a crit · on a crit 50% · 2HKO 39.84% · ${SASH}` }],
    ['an exact 0% is zero over warn', { koExact: ALL, koCritExact: ONE, survives: 'Focus Sash' }, ZERO, { tone: 'zero', ko: `OHKO 100% · ${SASH}` }],
  ])('%s', (_, over, ai, expected) => {
    const move = damage({ name: 'Aqua Cutter', ...over });
    const [row] = replyRows(replyNode([move], ai === undefined ? undefined : [pick('Aqua Cutter', ai)]));
    expect(row).toMatchObject({ name: 'Aqua Cutter', move, ...expected });
  });

  it('an exact 0%, named or accounted for, is zero over danger, its words unchanged; an unnamed move gets a figure only when the odds add up', () => {
    const kill = plainMove('Flamethrower', { koExact: ALL, koCritExact: ONE });
    for (const choices of [[pick('Tackle', ONE), pick('Flamethrower', ZERO)], [pick('Tackle', ONE)]]) {
      expect(replyRows(replyNode([kill, plainMove('Tackle')], choices)).find((x) => x.name === 'Flamethrower')).toMatchObject({ tone: 'zero', ko: 'OHKO 100%', ai: ZERO });
    }
    const unnamed = replyRows(replyNode([plainMove('Tackle'), plainMove('Bite')], [pick('Tackle', r(1, 2)), pick('Mystery', r(1, 2))]));
    expect(unnamed.find((x) => x.name === 'Bite')).toMatchObject({ ai: null, tone: null });
    const sure = replyRows(replyNode([plainMove('Tackle'), plainMove('Bite')], [pick('Tackle', r(3, 4)), pick('Switch to Onix', r(1, 4))]));
    expect(sure.find((x) => x.name === 'Bite')).toMatchObject({ ai: ZERO, tone: 'zero' });
  });

  it('add a row for every AI action that is not one of their moves, with no damage or KO', () => {
    const rows = replyRows(replyNode([plainMove('Tackle')], [pick('Tackle', r(1, 2)), pick('Switch to Onix', r(1, 4)), pick('Full Restore', r(1, 4))]));
    expect(rows.map((x) => x.name)).toEqual(['Tackle', 'Full Restore', 'Switch to Onix']);
    expect(rows[2]).toEqual({ name: 'Switch to Onix', ai: r(1, 4), move: null, tone: null, ko: '' });
  });

  it('likeliestMove is the top move, skipping a switch; null without odds or with every move at 0%', () => {
    const [ancient, earth] = [plainMove('AncientPower'), plainMove('Earth Power')];
    expect(likeliestMove(replyNode([ancient, earth], [pick('Switch to Onix', r(3, 5)), pick('Earth Power', r(1, 5)), pick('AncientPower', r(1, 5))]))).toBe('AncientPower');
    expect(likeliestMove(replyNode([ancient, earth], [pick('AncientPower', r(4702, 10000)), pick('Switch to Onix', r(3, 10)), pick('Earth Power', r(2298, 10000))]))).toBe('AncientPower');
    expect(likeliestMove(replyNode([ancient, earth]))).toBeNull();
    expect(likeliestMove(replyNode([ancient], [pick('AncientPower', ZERO), pick('Switch to Onix', ONE)]))).toBeNull();
  });

  it('exact odds add and multiply, however long', () => {
    expect(sumOdds([r(1, 8), r(1, 8), r(1, 16)])).toEqual(r(5, 16));
    expect(sumOdds([])).toEqual(r(0, 1));
    expect(timesOdds(r(11, 16), r(2, 3))).toEqual(r(11, 24));
    const big = { num: '1', den: '340282366920938463463374607431768211456' };            // 2^-128
    expect(sumOdds([big, big])).toEqual({ num: '1', den: '170141183460469231731687303715884105728' });
  });
});

describe('the line API', () => {
  it('a failed fetch, an empty gateway answer, a dropped event stream and one that closes early are NO_ANSWER', async () => {
    stubFetch({ 'POST /api/line/expand': () => { throw new TypeError('Failed to fetch'); }, 'POST /api/line/start': { status: 502, json: 'x' } });
    await expect(expandLine({ line: 'a', node: 'b' })).rejects.toMatchObject({ status: 0, code: NO_ANSWER });
    await expect(startLine({ trainerId: 'a', team: [], draft: [] })).rejects.toMatchObject({ status: 502, code: NO_ANSWER });
    const live = liveStream();
    stubFetch({ 'POST /api/setup/extract': { stream: live.stream } });
    const extracting = streamExtract('/rom.nds', { onProgress: () => {} });
    live.close();
    await expect(extracting).rejects.toMatchObject({ code: NO_ANSWER });
    stubFetch({ 'POST /api/setup/extract': () => ({ stream: new ReadableStream<Uint8Array>({ pull(c) { c.error(new TypeError('network error')); } }) }) });
    await expect(streamExtract('/rom.nds', { onProgress: () => {} })).rejects.toMatchObject({ status: 0, code: NO_ANSWER });
  });

  it('nextLine asks for the next trainer from a won node: a new line whose root says where its team came from; a lost line or a step short of a win is refused', async () => {
    const server = lineServer();
    const stub = stubFetch(server.routes);
    const root = await startLine({ trainerId: TRISTAN, team: ['party:1', 'party:2'], draft: [] });
    await expandLine({ line: root.line, node: 'root', choice: M0 });
    await expandLine({ line: root.line, node: 'faint' });
    await expandLine({ line: root.line, node: 'mouse', choice: M0 });
    server.gate.dropped = ['Gloom'];
    const next = await nextLine({ line: root.line, node: 'won', trainerId: 'next', lead: 'party:2', heal: true });
    expect(stub.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/line/next', body: { line: 'L1', node: 'won', trainerId: 'next', lead: 'party:2', heal: true } });
    expect(stub.calls.at(-1)!.headers.get('Content-Type')).toBe('application/json');
    expect([next.line, next.node, next.carried]).toEqual(['L2', 'root', { fromLine: 'L1', fromNode: 'won', dropped: ['Gloom'] }]);
    expect([next.view.player.active?.name, next.view.player.party.map((m) => [m.name, m.level, m.hp, m.active])]).toEqual(['Bench', [['Bench', 5, 30, true], ['Blaze', 16, 44, false]]]);
    expect(await getLineNode(next.line, 'root')).toEqual(next);                    // a reload reads the same root, `carried` and all
    expect((await getLineNode(root.line, 'root')).carried).toBeUndefined();
    expect((await nextLine({ line: 'L1', node: 'won', trainerId: 'next' })).view.player.party.map((m) => [m.name, m.hp])).toEqual([['Blaze', 30], ['Bench', 30]]);
    await expect(nextLine({ line: 'L1', node: 'faint', trainerId: 'next' })).rejects.toMatchObject({ status: 422, message: NOT_WON });
    const lost = await nextLine({ line: 'L9', node: 'won', trainerId: 'next' }).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ApiError);
    expect(lost).toMatchObject({ status: 404, code: 'LINE_LOST' });
  });
});

describe('saved plans as they are read', () => {
  const KEY = `pkp.tree.saved.${TRISTAN}.0`;
  const START = { trainerId: TRISTAN, variant: 0, world: 0, team: ['party:1', 'party:2'], draft: [{ ref: 'party:1' }, { ref: 'party:2' }] };
  const SAVE = { savePath: box().savePath, savedAt: box().savedAt };
  const WIN: PathStep[] = [{ choice: M0, outcome: 'o-faint', auto: false }, { choice: null, outcome: 'o-mouse', auto: true }, { choice: M0, outcome: 'o-win', auto: false }];
  const CARRIED = { trainerId: TRISTAN, variant: 0, world: 0, team: ['party:1', 'party:2'], draft: [], carried: { start: START, path: WIN, line: 'L1', node: 'won', heal: false } };
  const step = { choice: M0, outcome: 'h1', auto: false };
  const put = (...entries: unknown[]) => localStorage.setItem(KEY, JSON.stringify(entries));
  const entry = (over: Record<string, unknown>) => ({ name: 'plan', save: SAVE, start: START, path: [], others: [], ...over });
  const startRead = () => readSaved(TRISTAN, 0)[0]!.start;

  it('reads a saved plan with its name, save, start, path and at most 24 other branches; junk branches are left out', () => {
    put(entry({ path: [step], others: [[step], 'junk', [{ ...step, outcome: 7 }]] }));
    expect(readSaved(TRISTAN, 0)).toEqual([{ name: 'plan', save: SAVE, start: START, path: [step], others: [[step]] }]);
    put(entry({ save: undefined, others: undefined, start: { ...START, hp: 'full' } }));
    expect(readSaved(TRISTAN, 0)).toEqual([{ name: 'plan', save: null, start: START, path: [], others: [] }]);
    put(entry({ others: Array.from({ length: 30 }, () => [step]) }));
    expect(readSaved(TRISTAN, 0)[0]!.others).toHaveLength(24);
  });

  it('keeps keys only when there is one string for each team member', () => {
    const keys = ['key-party:1', 'key-party:2'];
    put(entry({ start: { ...START, keys } }));
    expect(startRead()).toEqual({ ...START, keys });
    for (const bad of [['key-party:1'], ['key-party:1', 'key-party:2', 'key-x'], ['key-party:1', 7], 'key-party:1']) {
      put(entry({ start: { ...START, keys: bad } }));
      expect(startRead()).toEqual(START);
    }
  });

  it('reads a carried start, however deep; junk under carried leaves the entry out', () => {
    put(entry({ start: CARRIED }));
    expect(startRead()).toEqual(CARRIED);
    const deep = { ...CARRIED, carried: { ...CARRIED.carried, start: CARRIED } };
    put(entry({ start: deep }));
    expect(startRead()).toEqual(deep);
    for (const bad of ['x', {}, { ...CARRIED.carried, heal: 'no' }, { ...CARRIED.carried, node: 7 }, { ...CARRIED.carried, path: [{ outcome: 7 }] }, { ...CARRIED.carried, start: { ...START, team: 'x' } }, { ...CARRIED.carried, start: { ...CARRIED, carried: 'x' } }]) {
      put(entry({ start: { ...CARRIED, carried: bad } }), entry({ name: 'ok' }));
      expect(readSaved(TRISTAN, 0).map((l) => l.name), JSON.stringify(bad)).toEqual(['ok']);
    }
  });

  it('skips an entry without a string name, a bad start or a bad path, and reads nothing from a non-array', () => {
    put(entry({ name: 7 }), entry({ name: undefined }), entry({ start: { ...START, draft: undefined } }), entry({ start: { ...START, draft: [{ ref: 'box:9:9' }] } }), entry({ path: 'x' }), 'junk', entry({ name: 'ok' }));
    expect(readSaved(TRISTAN, 0).map((l) => l.name)).toEqual(['ok']);
    localStorage.setItem(KEY, JSON.stringify({ name: 'plan' }));
    expect(readSaved(TRISTAN, 0)).toEqual([]);
    localStorage.removeItem(KEY);
    expect(readSaved(TRISTAN, 0)).toEqual([]);
  });
});
