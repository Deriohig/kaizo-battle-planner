import { describe, expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon, ResolvedTrainer } from '../../../src/battle/types.js';
import { type CalcField, type CalcSide, damage, type DamageResult } from '../../../src/calc/calc.js';
import { buildSheet, type SheetMoveCell, type SheetOptions, type SheetPair, worseCell } from '../../../src/sheet/sheet.js';
import { effectiveSpeed, speedOrder } from '../../../src/sheet/speed.js';
import {
  ABILITY, BLIZZARD, EMBER, GROWL, ITEM, monferno, move, PSYWAVE, QUICK_ATTACK, TACKLE, THUNDER, zigzagoon,
} from '../../fixtures/battleMons.js';

const MOVES: ReadonlyMap<number, KaizoMove> = new Map([TACKLE, EMBER, QUICK_ATTACK, GROWL, THUNDER, PSYWAVE].map((m) => [m.id, m]));
const ability = (value: number, alternatives: number[] = []) =>
  ({ ability: { value, source: 'rom' as const, disputed: alternatives.length > 0, alternatives } });
const [DRIZZLE, DROUGHT, SNOW_WARNING, CUSTAP_BERRY] = [2, 70, 117, 210];
// A level 30 Zigzagoon has Speed 55, faster than Monferno's 32.
const FAST = { level: 30 };

/** The sheet of `team` against Youngster Tristan of the Roark Split holding `party`, with its notes as one string. */
function sheetOf(team: PlayerMon[], party: ResolvedMon[], fields: Partial<ResolvedTrainer> = {}, opts: Partial<SheetOptions> = {}) {
  const trainer: ResolvedTrainer = {
    id: 'roark-split/youngster-tristan/1', name: 'Youngster Tristan', split: 'Roark Split', location: 'Route 202', order: 0,
    romIndex: 1, trainerClass: 2, battleType: 'single', aiFlags: [], field: null, tags: { starred: false, raw: [] },
    levelMismatch: false, party, variants: [], ...fields,
  };
  const sheet = buildSheet(team, trainer, { moves: MOVES, ...opts });
  return { ...sheet, text: sheet.notes.join(' ') };
}

/** The one pair of `player` against `enemy`, with its notes as one string. */
function pairOf(player: PlayerMon, enemy: ResolvedMon, fields?: Partial<ResolvedTrainer>, opts?: Partial<SheetOptions>) {
  const pair = sheetOf([player], [enemy], fields, opts).pairs[0]!;
  return { ...pair, text: pair.notes.join(' ') };
}

describe('buildSheet', () => {
  it('has a pair for each enemy and team member, enemies outer, with both speeds and who moves first', () => {
    const sheet = sheetOf([monferno(), monferno({ nickname: 'Two' })], [zigzagoon(), zigzagoon(FAST)]);
    expect(sheet.pairs.map((p) => [p.enemy.level, p.player.nickname, p.order, p.playerSpeed, p.enemySpeed])).toEqual([
      [5, 'Fernando', 'player', 32, 13], [5, 'Two', 'player', 32, 13], [30, 'Fernando', 'enemy', 32, 55], [30, 'Two', 'enemy', 32, 55]]);
    expect(sheet.field).toEqual({});
  });

  it('gives each move its damage and hit chance both ways; status moves have no rolls, an unmodelled one keeps its flag', () => {
    const metronome = move(118, { name: 'Metronome', category: 'status', power: 0, accuracy: 0, target: 16, calc: { baseMove: 'Metronome' }, unmodelled: 'Metronome effect' });
    const pair = pairOf(monferno({ moves: [52, 45] }), zigzagoon({ moves: [33, 87, 118] }), {}, { moves: new Map([...MOVES, [118, metronome]]) });
    // Monferno's Ember against the Zigzagoon is the calc's 22-27.
    expect(pair.playerMoves.map((c) => [c.move.name, c.result?.min, c.result?.max, c.unmodelled])).toEqual([['Ember', 22, 27, null], ['Growl', undefined, undefined, null]]);
    expect(pair.playerMoves[1]).toMatchObject({ result: null, hitChance: 1, inaccurate: false });
    expect(pair.enemyMoves.slice(0, 2).map((c) => [c.move.name, c.hitChance, c.inaccurate, c.result === null])).toEqual([['Tackle', 1, false, false], ['Thunder', 0.7, true, false]]);
    expect(pair.enemyMoves[2]).toMatchObject({ result: null, unmodelled: 'Metronome effect' });
  });

  // At equal priority a Quick Claw or Custap Berry may move its holder first, before Lagging Tail, Stall, Trick Room and Speed.
  it.each<[string, PlayerMon, ResolvedMon, Partial<ResolvedTrainer>, Partial<SheetPair>, RegExp?]>([
    ['Trick Room from the docs field note: the slower side', monferno(), zigzagoon(), { field: { raw: 'TRICK ROOM', trickRoom: true } }, { order: 'enemy', field: { trickRoom: true } }, /Trick Room/],
    ['a Choice Scarf raises its holder\'s Speed (38 x 1.5)', monferno(), zigzagoon({ level: 20, item: ITEM.CHOICE_SCARF }), {}, { order: 'enemy', enemySpeed: 57 }, /Choice Scarf/],
    ['different priorities on the two sides give "depends"', monferno({ moves: [98, 52] }), zigzagoon({ ...FAST, moves: [33] }), {}, { order: 'depends' }, /Quick Attack \+1/],
    ['priority alone when every move of one side outprioritises the other\'s', monferno({ moves: [98] }), zigzagoon({ ...FAST, moves: [33] }), {}, { order: 'player' }],
    ['a speed tie', monferno(), { ...monferno(), moves: [33] }, {}, { order: 'tie' }],
    ['a slower player Quick Claw holder', monferno({ item: ITEM.QUICK_CLAW }), zigzagoon(FAST), {}, { order: 'depends' }, /Quick Claw \(Fernando\)/],
    ['a slower trainer Quick Claw holder', monferno(), zigzagoon({ item: ITEM.QUICK_CLAW }), {}, { order: 'depends' }],
    ['a slower trainer Custap Berry holder', monferno(), zigzagoon({ item: CUSTAP_BERRY }), {}, { order: 'depends' }, /Custap Berry \(Zigzagoon\)/],
    ['a Quick Claw holder in a speed tie', monferno(), { ...monferno(), item: ITEM.QUICK_CLAW, moves: [33] }, {}, { order: 'depends' }],
    ['a Quick Claw holder that moves first anyway', monferno({ item: ITEM.QUICK_CLAW }), zigzagoon(), {}, { order: 'player' }],
    ['a Klutz Quick Claw holder', monferno(), zigzagoon({ item: ITEM.QUICK_CLAW, ...ability(ABILITY.KLUTZ) }), {}, { order: 'player' }],
    ['an outprioritised Quick Claw holder', monferno({ moves: [98] }), zigzagoon({ item: ITEM.QUICK_CLAW }), {}, { order: 'player' }],
  ])('orders the pair for %s', (_, player, enemy, fields, expected, note) => {
    const pair = pairOf(player, enemy, fields);
    expect(pair).toMatchObject(expected);
    if (note) expect(pair.text).toMatch(note);
  });

  it('notes a default nickname (the species in capitals) as the species name, a real one as written', () => {
    const notes = (nickname: string) => pairOf(monferno({ nickname, moves: [98, 52] }), zigzagoon({ ...FAST, moves: [33] })).text;
    expect(notes('MONFERNO')).toMatch(/Priority: Monferno: /);
    expect(notes('MONFERNO')).not.toMatch(/MONFERNO/);
    expect(notes('NUTZ')).toMatch(/Priority: NUTZ: /);
  });

  it.each<[string, Partial<ResolvedTrainer>, Partial<SheetOptions>, object, number, RegExp?]>([
    ['fog from the docs field note lowers every hit chance', { field: { raw: 'FOG', fog: true } }, {}, { fog: true }, 0.6, /fog/i],
    ["a double battle calcs as doubles and can't be built yet", { battleType: 'double' }, {}, { doubles: true }, 1, /can't be built yet/],
    ["a field passed in replaces the trainer's", { field: { raw: 'FOG', fog: true } }, { field: { weather: 'rain' } }, { weather: 'rain' }, 1],
  ])('%s', (_, fields, opts, field, hitChance, note) => {
    const sheet = sheetOf([monferno()], [zigzagoon()], fields, opts);
    expect([sheet.field, sheet.pairs[0]!.enemyMoves[0]!.hitChance]).toEqual([field, hitChance]);
    if (note) expect(sheet.text).toMatch(note);
  });

  it('notes a disputed nature, Quick Claw and Psywave, whose rolls are never shown as equal odds', () => {
    const disputed = zigzagoon({ nature: { value: 11, source: 'rom', disputed: true, alternatives: [13] } });
    const { text } = pairOf(monferno({ item: ITEM.QUICK_CLAW, moves: [149] }), disputed);
    for (const note of [/Zigzagoon's nature \(Hasty, from the ROM\) is disputed/, /Quick Claw/, /Psywave.*1\/11/]) expect(text).toMatch(note);
    expect(pairOf(monferno(), zigzagoon()).text).not.toMatch(/disputed/);
  });

  it("starts the player at full HP by default, keeping the save's status; hp: 'save' uses the save's HP", () => {
    const damaged = monferno({ currentHp: 10, status: { kind: 'paralysis' } });
    const full = sheetOf([damaged], [zigzagoon()]);
    // Blaze stays off at 44 of 44 HP; paralysed Speed is 32 / 4.
    expect([full.hp, full.pairs[0]!.playerMoves[0]!.result!.max, full.pairs[0]!.playerSpeed]).toEqual(['full', 27, 8]);
    expect(full.pairs[0]!.enemyMoves[0]!.result!.koChance).toEqual(pairOf(monferno(), zigzagoon()).enemyMoves[0]!.result!.koChance);
    const save = sheetOf([damaged], [zigzagoon()], {}, { hp: 'save' });
    expect(save.hp).toBe('save');
    expect(save.pairs[0]!.playerMoves[0]!.result!.max).toBeGreaterThan(27); // Blaze on at 10 of 44 HP
    expect(save.pairs[0]!.enemyMoves[0]!.result!.koChance![3]!.chance).toBe(1);
  });

  it("counts a trainer's Zoom Lens in its hit chances whenever it may move second", () => {
    // x1.2 once the target has moved (battle_controller_player.c:2922-2974): 70 x 120 / 100 = 84.
    const zoom = zigzagoon({ ...FAST, item: ITEM.ZOOM_LENS, moves: [87] });
    const claw = pairOf(monferno({ item: ITEM.QUICK_CLAW }), zoom);
    expect([claw.order, claw.enemyMoves[0]!.hitChance]).toEqual(['depends', 0.84]);
    expect(claw.text).toMatch(/Zoom Lens \(Zigzagoon\): .* in its hit chances as the worst case/);
    const hits = (enemy: ResolvedMon) => [pairOf(monferno(), enemy).order, pairOf(monferno(), enemy).enemyMoves[0]!.hitChance];
    expect([hits(zoom), hits({ ...zoom, level: 5 })]).toEqual([['enemy', 0.7], ['player', 0.84]]);
  });

  describe('weather-setting abilities, pair by pair', () => {
    // On entry they replace the weather, a permanent one included, unless their own is already permanent.
    const WATER_GUN = move(55, { name: 'Water Gun', type: 11, category: 'special', power: 40, calc: { baseMove: 'Water Gun' } });
    const moves = new Map([...MOVES, [55, WATER_GUN], [59, BLIZZARD]]);
    const slugma = () => zigzagoon({ name: 'Slugma', species: 218, types: [10, 10], item: 0, ...ability(DROUGHT), moves: [52] });
    // Galactic Uranus's Articuno: Snow Cloak from an untrusted PID, so Snow Warning is as possible; hail makes Blizzard sure.
    const articuno = (alternatives: number[]) => zigzagoon({ name: 'Articuno', species: 144, types: [15, 2], moves: [59], ...ability(ABILITY.SNOW_CLOAK, alternatives) });

    it("works out a Drought Slugma's pair in sun over a permanent rain (Fire x1.5, Water x0.5, Chlorophyll x2 Speed), noting the sun stays", () => {
      const player = monferno({ moves: [52, 55], ...ability(ABILITY.CHLOROPHYLL) });
      const sheet = sheetOf([player], [slugma()], { field: { raw: 'PERMANENT RAIN', weather: 'rain' } }, { moves });
      const pair = sheet.pairs[0]!;
      expect([sheet.field, pair.field, pair.playerSpeed]).toEqual([{ weather: 'rain' }, { weather: 'sun' }, 64]);
      const rolls = (used: KaizoMove, weather?: 'sun') => damage({ mon: player }, { mon: slugma() }, used, weather ? { weather } : {})!.rolls;
      expect(pair.playerMoves.map((c) => c.result?.rolls)).toEqual([rolls(EMBER, 'sun'), rolls(WATER_GUN, 'sun')]);
      expect(Math.max(...rolls(EMBER, 'sun'))).toBeGreaterThan(Math.max(...rolls(EMBER)));
      expect(Math.max(...rolls(WATER_GUN, 'sun'))).toBeLessThan(Math.max(...rolls(WATER_GUN)));
      expect(pair.notes.join(' ')).toMatch(/Drought \(Slugma\): sun from its entry/);
      // A field weather is then no longer "all battle".
      for (const note of [/Weather-setting abilities: Slugma \(Drought\)/, /stays after it leaves/, /Rain from the start/]) expect(sheet.text).toMatch(note);
      expect(sheet.text).not.toMatch(/all battle/);
    });

    it('lets a Drizzle setter on a permanent-sand field bring rain, where Thunder always hits', () => {
      const sheet = sheetOf([monferno()], [zigzagoon({ ...ability(DRIZZLE), moves: [87] }), zigzagoon({ moves: [87] })], { field: { raw: 'PERMANENT SANDSTORM', weather: 'sand' } });
      expect(sheet.field).toEqual({ weather: 'sand' });
      expect(sheet.pairs.map((p) => [p.field?.weather, p.enemyMoves[0]?.hitChance])).toEqual([['rain', 1], ['sand', 0.7]]);
    });

    it('makes a pair where both sides set weather "depends", worked out under both, each cell the worse for the player', () => {
      const player = monferno({ ...ability(DROUGHT), moves: [52] });
      const drizzle = zigzagoon({ ...ability(DRIZZLE), moves: [87] });
      const pair = pairOf(player, drizzle);
      expect([pair.order, pair.field]).toEqual(['depends', null]);
      expect(pair.weatherCases?.map((c) => [c.lastIn, c.field.weather, c.enemyMoves[0]?.hitChance])).toEqual([['player', 'sun', 0.5], ['enemy', 'rain', 1]]);
      expect(pair.text).toMatch(/Drought \(Fernando\) and Drizzle \(Zigzagoon\).*came in last/);
      // Ember takes its rain (sun-less) damage, Thunder its rain accuracy.
      expect(pair.playerMoves[0]).toMatchObject({ weatherDepends: true, result: { rolls: damage({ mon: player }, { mon: drizzle }, EMBER, { weather: 'rain' })!.rolls } });
      expect(pair.enemyMoves[0]).toMatchObject({ weatherDepends: true, hitChance: 1 });
    });

    it('treats a disputed ability whose alternative sets weather as "depends", each cell the worse case', () => {
      const sheet = sheetOf([monferno()], [articuno([SNOW_WARNING])], {}, { moves });
      const pair = sheet.pairs[0]!;
      expect([pair.order, pair.field]).toEqual(['depends', null]);
      expect(pair.weatherCases?.map((c) => [c.enemyAbility, c.lastIn, c.field.weather, c.enemyMoves[0]?.hitChance]))
        .toEqual([[ABILITY.SNOW_CLOAK, null, undefined, 0.7], [SNOW_WARNING, null, 'hail', 1]]);
      expect(pair.enemyMoves[0]).toMatchObject({ weatherDepends: true, hitChance: 1 });
      expect(pair.notes.join(' ')).toMatch(/Articuno's ability is disputed: Snow Cloak or Snow Warning, which sets hail on entry/);
      expect(sheet.text).toMatch(/Weather-setting abilities: Articuno \(Snow Warning, if its disputed ability is that\)/);
    });

    it('leaves the pair alone when no candidate ability sets weather, or every one gives the same weather', () => {
      const plain = pairOf(monferno(), articuno([ABILITY.GLUTTONY]), {}, { moves });
      expect([plain.order, plain.field, plain.weatherCases]).toEqual(['player', {}, undefined]);
      const inHail = pairOf(monferno(), articuno([SNOW_WARNING]), { field: { raw: 'PERMANENT HAIL', weather: 'hail' } }, { moves });
      expect([inHail.field, inHail.weatherCases]).toEqual([{ weather: 'hail' }, undefined]);
    });

    it('marks each pair whose weather another Pokémon of the battle, on either side, may have set', () => {
      const sheet = sheetOf([monferno(), monferno({ nickname: 'Two' })], [slugma(), zigzagoon()], {}, { moves });
      expect(sheet.pairs.map((p) => [p.enemy.name, p.player.nickname, p.weatherMayPersist])).toEqual([
        ['Slugma', 'Fernando', false], ['Slugma', 'Two', false], ['Zigzagoon', 'Fernando', true], ['Zigzagoon', 'Two', true]]);
      const mixed = sheetOf([monferno(), monferno({ nickname: 'Rainy', ...ability(DRIZZLE) })], [zigzagoon()], {}, { moves });
      expect(mixed.pairs.map((p) => [p.player.nickname, p.weatherMayPersist])).toEqual([['Fernando', true], ['Rainy', false]]);
      expect(pairOf(monferno(), zigzagoon()).weatherMayPersist).toBe(false);
    });
  });
});

describe('worseCell: the worse of two weather cases, per statistic', () => {
  const result = (rolls: number[], koChance: number[], fields: Partial<DamageResult> = {}): DamageResult => ({
    rolls, critRolls: rolls, min: Math.min(...rolls), max: Math.max(...rolls), percent: [Math.min(...rolls), Math.max(...rolls)],
    koChance: koChance.map((chance, i) => ({ hits: i + 1, chance })), koExact: null, bounded: true, ohko: false, unmodelled: null, desc: '', ...fields,
  });
  const cell = (res: DamageResult, hitChance = 1): SheetMoveCell => ({ move: TACKLE, result: res, hitChance, inaccurate: hitChance < 1, unmodelled: null });
  const exact = (...fractions: [bigint, bigint][]) => fractions.map(([count, total], i) => ({ hits: i + 1, count, total }));
  // Made up so the top roll and the KO chance disagree: A has the higher top roll, B the higher one-use KO chance.
  const a = cell(result([...Array<number>(12).fill(10), 30, 30, 30, 40], [0.25, 1, 1, 1]), 0.9);
  const b = cell(result([...Array<number>(10).fill(30), 32, 32, 32, 32, 35, 35], [0.375, 0.5, 1, 1]), 0.8);

  it.each([
    [true, [0.375, 1, 1, 1], 30, 40, 0.9, [...Array<number>(10).fill(30), 32, 32, 32, 32, 35, 40]],
    [false, [0.25, 0.5, 1, 1], 10, 35, 0.8, [...Array<number>(12).fill(10), 30, 30, 30, 35]],
  ])('enemyAttacks %s: the worse KO chance per number of uses, range, hit chance, and roll at each index', (enemyAttacks, chances, min, max, hitChance, rolls) => {
    const worse = worseCell(a, b, enemyAttacks);
    expect(worse).toMatchObject({ hitChance, weatherDepends: true, result: { min, max, rolls, critRolls: rolls } });
    expect(worse.result?.koChance?.map((entry) => entry.chance)).toEqual(chances);
  });

  it('makes the cell unbounded when either case is', () => {
    const unbounded = cell(result([...Array<number>(15).fill(1), 2], [0, 0, 0, 0], { bounded: false, koChance: null, unmodelled: 'Counter' }));
    for (const enemyAttacks of [true, false]) {
      for (const [x, y] of [[a, unbounded], [unbounded, a]] as const) expect(worseCell(x, y, enemyAttacks).result).toMatchObject({ bounded: false, koChance: null });
    }
  });

  it("keeps exact KO fractions, picking each number of uses' on its own, compared exactly, whichever case comes first", () => {
    const x = cell(result(a.result!.rolls, [0.25, 1, 1, 1], { koExact: exact([1n, 4n], [1n, 1n], [1n, 1n], [1n, 1n]) }));
    const y = cell(result(b.result!.rolls, [0.375, 0.5, 1, 1], { koExact: exact([3n, 8n], [1n, 2n], [1n, 1n], [1n, 1n]) }));
    expect(worseCell(x, y, true).result?.koExact).toEqual(exact([3n, 8n], [1n, 1n], [1n, 1n], [1n, 1n]));
    expect(worseCell(x, y, false).result?.koExact).toEqual(exact([1n, 4n], [1n, 2n], [1n, 1n], [1n, 1n]));
    // (2^53 + 1) / 2^54 is above 1/2 but the same double: only an exact comparison tells them apart.
    const above = exact([2n ** 53n + 1n, 2n ** 54n]);
    const near = cell(result(a.result!.rolls, [0.5], { koExact: above }));
    const half = cell(result(a.result!.rolls, [0.5], { koExact: exact([1n, 2n]) }));
    for (const [p, q] of [[near, half], [half, near]] as const) {
      expect([worseCell(p, q, true).result?.koExact, worseCell(p, q, false).result?.koExact]).toEqual([above, exact([1n, 2n])]);
    }
  });

  // Lists pair by `hits`, never by index; a count only one case lists keeps its figure for a trainer, 0 for the player.
  it.each([
    [true, ['1:1/10', '2:3/4', '3:9/10', '4:1/1'], ['1:0.1', '2:0.75', '3:0.9', '4:1']],
    [false, ['1:0/1', '2:1/2', '3:0/1', '4:1/1'], ['1:0', '2:0.5', '3:0', '4:1']],
  ])('enemyAttacks %s: pairs KO lists of different hit counts by hits', (enemyAttacks, fractions, chances) => {
    const listed = (list: [number, number, number][]) => cell(result(Array<number>(16).fill(10), [], {
      koExact: list.map(([hits, count, total]) => ({ hits, count: BigInt(count), total: BigInt(total) })),
      koChance: list.map(([hits, count, total]) => ({ hits, chance: count / total })),
    }));
    // X lists hits 1, 2 and 4; Y lists hits 2, 3 and 4.
    const [x, y] = [listed([[1, 1, 10], [2, 1, 2], [4, 1, 1]]), listed([[2, 3, 4], [3, 9, 10], [4, 1, 1]])];
    for (const worse of [worseCell(x, y, enemyAttacks), worseCell(y, x, enemyAttacks)]) {
      expect(worse.result!.koExact!.map(({ hits, count, total }) => `${hits}:${count}/${total}`)).toEqual(fractions);
      expect(worse.result!.koChance!.map(({ hits, chance }) => `${hits}:${chance}`)).toEqual(chances);
    }
  });
});

// The cartridge's speed comparison (pokeplatinum battle_lib.c:1188-1454). Monferno's Speed stat is 32, Zigzagoon's 13.
const mon = (fields: Parameters<typeof monferno>[0] = {}, side: Omit<CalcSide, 'mon'> = {}): CalcSide => ({ mon: monferno(fields), ...side });
const zig = (fields: Parameters<typeof zigzagoon>[0] = {}): CalcSide => ({ mon: zigzagoon(fields) });

describe('effectiveSpeed', () => {
  it.each<[string, CalcSide, CalcField, number]>([
    ['the Speed stat with no modifiers', mon(), {}, 32],
    ['Choice Scarf x1.5, truncated', zig({ item: ITEM.CHOICE_SCARF }), {}, 19],
    ['a +1 stage, from the cartridge table', mon({}, { boosts: { spe: 1 } }), {}, 48],
    ['a -1 stage', mon({}, { boosts: { spe: -1 } }), {}, 21],
    ['a +1 stage doubled by Simple', mon(ability(ABILITY.SIMPLE), { boosts: { spe: 1 } }), {}, 64],
    ['a +4 stage doubled by Simple, to the +6 cap', mon(ability(ABILITY.SIMPLE), { boosts: { spe: 4 } }), {}, 128],
    ['paralysis on the mon quarters it', mon({ status: { kind: 'paralysis' } }), {}, 8],
    ['paralysis on the side quarters it', mon({}, { status: { kind: 'paralysis' } }), {}, 8],
    ['Quick Feet x1.5 with paralysis instead', mon({ ...ability(ABILITY.QUICK_FEET), status: { kind: 'paralysis' } }), {}, 48],
    ['Quick Feet x1.5 with sleep', mon({ ...ability(ABILITY.QUICK_FEET), status: { kind: 'sleep', turns: 2 } }), {}, 48],
    ['Swift Swim x2 in rain', mon(ability(ABILITY.SWIFT_SWIM)), { weather: 'rain' }, 64],
    ['Chlorophyll x2 in sun', mon(ability(ABILITY.CHLOROPHYLL)), { weather: 'sun' }, 64],
    ['Chlorophyll only in sun', mon(ability(ABILITY.CHLOROPHYLL)), { weather: 'rain' }, 32],
    ['Iron Ball halves it', mon({ item: ITEM.IRON_BALL }), {}, 16],
    ['Iron Ball halves it even under Klutz', mon({ item: ITEM.IRON_BALL, ...ability(ABILITY.KLUTZ) }), {}, 16],
    ['Klutz cancels Choice Scarf', mon({ item: ITEM.CHOICE_SCARF, ...ability(ABILITY.KLUTZ) }), {}, 32],
    ['Unburden is ignored', mon(ability(ABILITY.UNBURDEN)), {}, 32],
  ])('%s', (_, side, field, speed) => expect(effectiveSpeed(side, field)).toBe(speed));
});

describe('speedOrder', () => {
  const LAGGING = { item: ITEM.LAGGING_TAIL };
  it.each<[string, CalcSide, CalcSide, CalcField, ReturnType<typeof speedOrder>]>([
    ['the faster side first', mon(), zig(), {}, 'a'],
    ['a speed tie', mon(), mon(), {}, 'tie'],
    ['the slower side first under Trick Room', mon(), zig(), { trickRoom: true }, 'b'],
    ['a speed tie under Trick Room', mon(), mon(), { trickRoom: true }, 'tie'],
    ['a Choice Scarf turning the order', mon(), zig({ level: 30, item: ITEM.CHOICE_SCARF }), {}, 'b'],
    ['Lagging Tail last', mon(LAGGING), zig(), {}, 'b'],
    ['Full Incense last, before Trick Room counts', mon(), zig({ item: ITEM.FULL_INCENSE }), { trickRoom: true }, 'a'],
    ['Stall last', mon(ability(ABILITY.STALL)), zig(), {}, 'b'],
    ['two Lagging Tails: the slower first', mon(LAGGING), zig(LAGGING), {}, 'b'],
    ['two Stalls: the slower first', mon(ability(ABILITY.STALL)), zig(ability(ABILITY.STALL)), {}, 'b'],
  ])('%s', (_, a, b, field, order) => expect(speedOrder(a, b, field)).toBe(order));
});
