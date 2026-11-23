// rememberStep folds Showdown's log lines into the AI's memory of a battle; memoryKey is that memory's canonical key.
import { describe, expect, it } from 'vitest';
import {
  type AiMemoryData, initialMemoryData, memoryKey, type ProtocolIds, recordLastMove, rememberStep,
} from '../../../src/ai/memory.js';
import { emptyKnowledge, fixtureView } from './fixtures.js';
import { deepFreeze } from './viewHarness.js';

// Vanilla Gen 4 IDs: line − 1 of generated/moves.txt, abilities.txt and items.txt.
const MOVE = {
  Surf: 57, Spark: 209, 'Dragon Claw': 337, Earthquake: 89, Tackle: 33, Metronome: 118, Thunderbolt: 85, 'Focus Punch': 264, Struggle: 165, Outrage: 200,
  'Swords Dance': 14, Toxic: 92, 'Magic Coat': 277, Explosion: 153, 'Bug Bite': 450, Pluck: 365, Recycle: 278, 'Natural Gift': 363, 'Knock Off': 282,
  Fling: 374, 'U-turn': 369, 'Double Kick': 24, Pursuit: 228, Encore: 227, Imprison: 286, 'Sleep Talk': 214, 'Baton Pass': 226, 'Rain Dance': 240,
  'Sunny Day': 241, Hail: 258, Defog: 432,
} as const;
const ABILITY = {
  Levitate: 26, 'Rough Skin': 24, 'Water Absorb': 11, Static: 9, Drizzle: 2, Limber: 7, Intimidate: 22, 'Clear Body': 29, Trace: 36, Pressure: 46,
  'Hyper Cutter': 52, Forecast: 59, Download: 88, Frisk: 119, 'Speed Boost': 3, 'Motor Drive': 78, Steadfast: 80, 'Snow Warning': 117,
} as const;
const ITEM = {
  'Full Restore': 23, 'Sitrus Berry': 158, 'Lum Berry': 157, 'Quick Claw': 217, Leftovers: 234, 'Focus Band': 230, 'Focus Sash': 275, 'Choice Scarf': 287,
} as const;

/** Showdown names to IDs; an unknown name throws, so a case catches a lookup it didn't expect. */
const lookup = (table: Readonly<Record<string, number>>, kind: string) => (name: string): number => {
  const id = table[name];
  if (id === undefined) throw new Error(`no ${kind} ID for ${name}`);
  return id;
};
const ids: ProtocolIds = { move: lookup(MOVE, 'move'), ability: lookup(ABILITY, 'ability'), item: lookup(ITEM, 'item') };

/** One step from `start`. Inputs and outputs are frozen, so every case also checks that rememberStep is pure. */
const step = (start: AiMemoryData, log: string[], phase?: string): AiMemoryData =>
  deepFreeze(rememberStep(deepFreeze(start), deepFreeze(log), ids, phase === undefined ? {} : { phase }));

const Z = [0, 0, 0, 0];
const one = (move: number): number[] => [move, 0, 0, 0];
/** The memory with the player's slot of the knowledge lifted out, for one toMatchObject per case. */
const flat = ({ knowledge, ...rest }: AiMemoryData) => ({
  ...rest, moves: knowledge.battlerMoves[0], ability: knowledge.battlerAbilities[0], item: knowledge.battlerHeldItems[0],
});
type Case = [name: string, log: string[], want: Record<string, unknown>, start?: AiMemoryData, phase?: string];
/** One test per case: the step from the case's start (or `start`) gives a memory that matches `want`. */
const table = (start: AiMemoryData, cases: Case[]) => it.each(cases)('%s', (_name, log, want, from = start, phase) => {
  expect(flat(step(from, log, phase))).toMatchObject(want);
});

const SPARK = '|move|p1a: Luxray|Spark|p2a: Garchomp';
const DRAGON_CLAW = '|move|p2a: Garchomp|Dragon Claw|p1a: Luxray';
const EARTHQUAKE = '|move|p2a: Garchomp|Earthquake|p1a: Luxray';
const SWORDS_DANCE = '|move|p1a: Luxray|Swords Dance|p1a: Luxray';
const U_TURN = '|move|p2a: Garchomp|U-turn|p1a: Luxray';
const PLAYER_U_TURN = ['|move|p1a: Luxray|U-turn|p2a: Garchomp', '|-damage|p2a: Garchomp|150/183'];
/** Showdown runs a Pursuit at a switching Pokémon as `[from] Pursuit`; a plain one has no tag. */
const PURSUIT_AT_SWITCH = '|move|p1a: Luxray|Pursuit|p2a: Garchomp|[from] Pursuit';
const FULL_RESTORE = '|-activate|p2a: Garchomp|item: Full Restore|[trainer]';
const GENGAR_IN = '|switch|p1a: Gengar|Gengar, L50, M|135/135';
const GYARADOS_IN = '|switch|p2a: Gyarados|Gyarados, L50, M|170/170';
const KYOGRE_IN = '|switch|p1a: Kyogre|Kyogre, L50|200/200';
const GARCHOMP_FAINTS = '|faint|p2a: Garchomp';
/** The ways the player's battler leaves, and the AI's. */
const PLAYER_OUT = [GENGAR_IN, '|drag|p1a: Gengar|Gengar, L50, M|135/135', '|faint|p1a: Luxray'];
const AI_OUT = [GYARADOS_IN, '|drag|p2a: Gyarados|Gyarados, L50, M|170/170', GARCHOMP_FAINTS];
const METRONOME = ['|move|p1a: Luxray|Metronome|p1a: Luxray', '|move|p1a: Luxray|Thunderbolt|p2a: Garchomp|[from]move: Metronome'];
const DRIZZLE = '|-weather|RainDance|[from] ability: Drizzle|[of] p1a: Kyogre';
const RAIN_DANCE = ['|move|p2a: Garchomp|Rain Dance|p2a: Garchomp', '|-weather|RainDance'];
const DEFOG = '|move|p1a: Luxray|Defog|p2a: Garchomp';
const SKILL_SWAP = '|-activate|p1a: Luxray|move: Skill Swap|||[of] p2a: Garchomp';
const TRACE = '|-ability|p2a: Garchomp|Levitate|Trace|[from] ability: Trace|[of] p1a: Luxray';
/** Every change of the AI battler's ability but a Trace. */
const AI_ABILITY_CHANGES = [
  SKILL_SWAP, '|-ability|p2a: Garchomp|Static|Levitate|[from] move: Role Play|[of] p1a: Luxray',
  '|-ability|p2a: Garchomp|Insomnia|Levitate|[from] move: Worry Seed', '|-transform|p2a: Garchomp|p1a: Luxray',
  '|-formechange|p2a: Garchomp|Castform-Rainy|[msg]|[from] ability: Static',
];

const EMPTY = deepFreeze(initialMemoryData(null));
const RAIN = deepFreeze(initialMemoryData('rain'));
const HAIL = deepFreeze(initialMemoryData('hail'));
/**
 * After turn 1: the player's Luxray used Surf, then the AI's Garchomp Dragon Claw. The step ended at turn 2's choice,
 * where Fight runs the move menu: model.ts sets that fact.
 */
const T1: AiMemoryData = {
  ...step(EMPTY, ['|', '|move|p1a: Luxray|Surf|p2a: Garchomp', '|-damage|p2a: Garchomp|150/183', DRAGON_CLAW, '|-damage|p1a: Luxray|90/155', '|upkeep', '|turn|2']),
  turnFight: 'menu',
};
const LATER: AiMemoryData = { ...T1, turnFight: null }; // a later step of the turn: no record to make
const UNKNOWN: AiMemoryData = { ...T1, turnFight: 'unknown' };
const hitBy = (move: number) => ({ move, battler: 0 });
const SPARK_HIT = hitBy(MOVE.Spark);
const HIT: AiMemoryData = { ...T1, lastHitBy: SPARK_HIT };
const KNOWING: AiMemoryData = {
  ...T1, knowledge: { battlerMoves: [[MOVE.Surf, MOVE.Spark, 0, 0], Z, Z, Z], battlerAbilities: one(ABILITY.Levitate), battlerHeldItems: one(ITEM.Leftovers) },
};

describe('recordLastMove', () => {
  it.each([
    ['fills the first empty slot', [MOVE.Spark, 0, 0, 0], MOVE.Surf, [MOVE.Spark, MOVE.Surf, 0, 0]],
    ['fills an empty list', Z, MOVE.Surf, one(MOVE.Surf)],
    ['leaves a move it already knows', [MOVE.Spark, MOVE.Surf, 0, 0], MOVE.Surf, [MOVE.Spark, MOVE.Surf, 0, 0]],
    ['records nothing for movePrevByBattler 0', [MOVE.Spark, 0, 0, 0], 0, [MOVE.Spark, 0, 0, 0]],
    ['records nothing when all four slots are full', [MOVE.Spark, MOVE.Tackle, MOVE.Toxic, MOVE.Pluck], MOVE.Surf, [MOVE.Spark, MOVE.Tackle, MOVE.Toxic, MOVE.Pluck]],
  ])('%s, purely', (_name, known, prev, want) => {
    const k = deepFreeze({ ...emptyKnowledge(), battlerMoves: [[...known], Z, Z, Z] });
    const out = recordLastMove(k, deepFreeze(fixtureView({ movePrevByBattler: [prev, MOVE.Tackle, 0, 0] })), 0);
    expect(out).toEqual({ ...emptyKnowledge(), battlerMoves: [want, Z, Z, Z] });
  });
});

describe('memoryKey', () => {
  /** `value` with every object's keys put in `order`'s order. */
  const rekey = (value: unknown, order: (keys: string[]) => string[]): unknown => {
    if (Array.isArray(value)) return value.map((child) => rekey(child, order));
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(order(Object.keys(record)).map((key) => [key, rekey(record[key], order)]));
  };

  it('is canonical: any key order keys the same, the key round-trips, and every field counts', () => {
    const a: AiMemoryData = {
      knowledge: { battlerMoves: [[1, 0, 0, 0], Z, Z, Z], battlerAbilities: [26, 0, 0, 0], battlerHeldItems: [234, 0, 0, 0] },
      lastMoveBy: [57, 337], lastHitBy: { move: 57, battler: 0 }, recycleOverride: [null, 158], switchAction: [],
      aiKept: ['mons.1.ability'], turnFight: 'menu', playerMovesUnknown: false, imprisonedMark: [true, false], permWeather: 'rain',
      fog: 'standing',
    };
    expect(memoryKey(rekey(a, (keys) => keys.reverse()) as AiMemoryData)).toBe(memoryKey(a));
    expect(JSON.parse(memoryKey(a))).toEqual(a);
    const changes: Partial<AiMemoryData>[] = [
      { lastHitBy: null }, { recycleOverride: [null, 'unknown'] }, { imprisonedMark: [false, false] }, { permWeather: null }, { fog: 'cleared' },
    ];
    for (const change of changes) expect(memoryKey({ ...a, ...change })).not.toBe(memoryKey(a));
  });

  it('is the JSON of a key-sorted copy whose known moves are sorted, zeros last', () => {
    // Every reader scans all four slots, and recordLastMove gives the same set whatever the order (trainer_ai.c:1668, 2705).
    const sortedCopy = (m: AiMemoryData): string => JSON.stringify(rekey({
      ...m, knowledge: { ...m.knowledge, battlerMoves: m.knowledge.battlerMoves.map((moves) => {
        const known = moves.filter((move) => move !== 0).sort((x, y) => x - y);
        return [...known, ...Array<number>(moves.length - known.length).fill(0)];
      }) },
    }, (keys) => keys.sort()));
    const base = initialMemoryData('sand');
    // Integer-like keys the memory never has: the copy put array indexes first, in numeric order, then the rest as strings.
    const odd = {
      ...base, extra: { b: 1, 10: 2, a: 3, 2: 4, '01': 5, '-1': 6, 4294967294: 7, 4294967295: 8, nested: [{ 3: 0, z: 0, 1: 0 }] },
    } as unknown as AiMemoryData;
    const memories: AiMemoryData[] = [
      base, EMPTY, odd,
      { ...base, lastHitBy: { move: 57, battler: 0 }, recycleOverride: ['unknown', 158], switchAction: null, turnFight: 'forced' },
      { ...base, aiKept: ['mons.1.ability', 'mons.1.types'], switchAction: [369, 228], playerMovesUnknown: true, fog: 'unknown' },
      { ...base, knowledge: { ...base.knowledge, battlerMoves: [[89, 0, 57, 0], Z, Z, Z] } },
      // undefined in an array and in an object, which JSON.stringify writes its own way.
      { ...base, aiKept: [undefined as unknown as string], lastHitBy: { move: 1, battler: undefined as unknown as number } },
    ];
    for (const m of memories) expect(memoryKey(m)).toBe(sortedCopy(m));
    expect(memoryKey(odd)).toContain('"extra":{"2":4,"10":2,"4294967294":7,"-1":6,"01":5,"4294967295":8,"a":3,"b":1,');
  });

  it('starts empty, with the field note\'s weather as the _PERM weather (subscript_overworld_rain.s:11)', () => {
    expect(EMPTY).toEqual({
      knowledge: emptyKnowledge(), lastMoveBy: [0, 0], lastHitBy: null, recycleOverride: [null, null], switchAction: [],
      aiKept: [], turnFight: null, playerMovesUnknown: false, imprisonedMark: [false, false], permWeather: null, fog: 'standing',
    });
    expect(initialMemoryData('sand').permWeather).toBe('sand');
  });

  it.each([
    ["the AI's own ability and item: it keeps no knowledge of its own battler", EMPTY,
      ['|-ability|p2a: Garchomp|Intimidate|boost', '|-heal|p2a: Garchomp|183/183|[from] item: Leftovers']],
    ["the player's Quick Claw", LATER, ['|-activate|p1a: Luxray|item: Quick Claw']],
    ["the AI's Quick Claw", LATER, ['|-activate|p2a: Garchomp|item: Quick Claw']],
  ] as const)('%s leaves the key as it was', (_name, start, log) => {
    expect(memoryKey(step(start, [...log]))).toBe(memoryKey(start));
  });

  // The engine merges leaves on (state key, critBy, observation) and keeps the most probable leaf's log, so merged leaves
  // can differ in -damage amounts, crits (the AI reads none: rememberStep has no -crit case) and the order of like events.
  const kicks = (left: number[], crit = false) => [
    '|move|p2a: Garchomp|Double Kick|p1a: Luxray', `|-damage|p1a: Luxray|${left[0]}/155`, ...(crit ? ['|-crit|p1a: Luxray'] : []),
    `|-damage|p1a: Luxray|${left[1]}/155`, '|-hitcount|p1a: Luxray|2',
  ];
  const sparkHits = (left: number, crit = false) => [SPARK, ...(crit ? ['|-crit|p2a: Garchomp'] : []), `|-damage|p2a: Garchomp|${left}/183`];
  const turn = (hits: number[], hp: number) => [...kicks(hits), ...sparkHits(hp), `|-damage|p2a: Garchomp|${hp - 10}/183|[from] ability: Rough Skin|[of] p1a: Luxray`];
  const uTurn = (left: number) => [U_TURN, `|-damage|p1a: Luxray|${left}/155`];
  const imprison = (left: number) => [...sparkHits(left), '|move|p2a: Garchomp|Imprison|p2a: Garchomp', '|-fail|p2a: Garchomp'];
  const swapped = (pair: string[]): [string[], string[]] => [[SPARK, DRAGON_CLAW, ...pair], [SPARK, DRAGON_CLAW, ...[...pair].reverse()]];
  it.each<[string, string[], string[], string?]>([
    ['-damage amounts, a multi-hit run and a Rough Skin included', turn([120, 90], 50), turn([118, 84], 47)],
    ['-damage amounts at a mid-turn switch, where the action\'s moves are kept', uTurn(100), uTurn(97), 'enemyMidTurnSwitch'],
    ['-damage amounts around an Imprison', imprison(120), imprison(117)],
    ['a critical hit', [...sparkHits(40, true), DRAGON_CLAW], [...sparkHits(110), DRAGON_CLAW]],
    ['a critical hit inside a multi-hit run', kicks([120, 60], true), kicks([120, 90])],
    ['the order of residual damage', ...swapped(['|-damage|p1a: Luxray|80/155 psn|[from] psn', '|-damage|p2a: Garchomp|100/183 tox|[from] psn'])],
    ['the order of Leftovers heals', ...swapped(['|-heal|p1a: Luxray|90/155|[from] item: Leftovers', '|-heal|p2a: Garchomp|110/183|[from] item: Leftovers'])],
  ])('keys the same for logs that differ only in %s', (_name, a, b, phase = 'turnChoice') => {
    expect(memoryKey(step(T1, a, phase))).toBe(memoryKey(step(T1, b, phase)));
  });
});

describe('rememberStep: the move TrainerAI_Main records, the player\'s last move at the turn choice', () => {
  const FIRST = step(T1, PLAYER_U_TURN, 'playerMidTurnSwitch');
  const surf = { moves: one(MOVE.Surf) };
  const none = { moves: Z };
  table(T1, [
    ['turn 1 records nothing, and the AI\'s own move clears what hit it', [], { moves: Z, lastMoveBy: [MOVE.Surf, MOVE['Dragon Claw']], lastHitBy: null }, LATER],
    ['the AI fought', [EARTHQUAKE, '|-damage|p1a: Luxray|40/155', SPARK, '|turn|3'], surf],
    ['the AI switched: no Fight', [GYARADOS_IN, '|move|p1a: Luxray|Spark|p2a: Gyarados', '|turn|3'], none],
    ['a bag item is no Fight', [FULL_RESTORE], none],
    ['the AI chose a move but was paralysed', ['|cant|p2a: Garchomp|par', SPARK], surf],
    ['the AI hit itself in confusion', ['|-activate|p2a: Garchomp|confusion', '|-damage|p2a: Garchomp|130/183|[from] confusion'], surf],
    ['the AI fainted before acting: it ran at the command selection', [SPARK, '|-damage|p2a: Garchomp|0 fnt', GARCHOMP_FAINTS], surf],
    ['a Pursuit at the switching AI shows the switch, though it knocks it out', [PURSUIT_AT_SWITCH, '|-damage|p2a: Garchomp|0 fnt', GARCHOMP_FAINTS], none],
    ['a plain Pursuit that knocks it out', ['|move|p1a: Luxray|Pursuit|p2a: Garchomp', GARCHOMP_FAINTS], surf],
    ['a Pursuit after the AI\'s own U-turn is part of its Fight', [U_TURN, PURSUIT_AT_SWITCH], surf],
    ['recorded before the step\'s events, so a later player switch clears it', [EARTHQUAKE, GENGAR_IN], none],
    // A lock, Struggle or an Encore skips the move menu (battle_controller_player.c:334, 433, 443), whatever the lines.
    ...[
      '|move|p2a: Garchomp|Outrage|p1a: Luxray|[from]lockedmove', '|cant|p2a: Garchomp|recharge', '|move|p2a: Garchomp|Struggle|p1a: Luxray',
      DRAGON_CLAW, '|cant|p2a: Garchomp|par',
    ].map((line): Case => [`a forced turn records nothing: ${line}`, [line], none, { ...T1, turnFight: 'forced' }]),
    // A turn of several steps records once, at its first, with Surf: the player's move before the turn, not its U-turn.
    ['the first step of a turn records', PLAYER_U_TURN, { ...surf, turnFight: null }, T1, 'playerMidTurnSwitch'],
    ['a later step keeps the record', [DRAGON_CLAW], surf, FIRST],
    ['a later step records nothing again', [GENGAR_IN, '|move|p2a: Garchomp|Dragon Claw|p1a: Gengar'], none, FIRST],
    ['an unknown fact leaves a record that would change the moves unsettled', [DRAGON_CLAW], { ...none, playerMovesUnknown: true }, UNKNOWN],
    ['an unknown fact settles a record that changes nothing', [DRAGON_CLAW], { playerMovesUnknown: false },
      { ...UNKNOWN, knowledge: { ...UNKNOWN.knowledge, battlerMoves: [one(MOVE.Surf), Z, Z, Z] } }],
    ['an unknown fact settles a switch: no Fight', [GYARADOS_IN], { playerMovesUnknown: false }, UNKNOWN],
    ['the player\'s switch-in settles an unsettled record', [GENGAR_IN], { playerMovesUnknown: false }, step(UNKNOWN, [DRAGON_CLAW])],
  ]);
});

describe('rememberStep: the last move each battler used and the move that last hit the AI', () => {
  const afterDragonClaw = (lastMoveBy0: number) => ({ lastMoveBy: [lastMoveBy0, MOVE['Dragon Claw']] });
  table(T1, [
    ['a missed move still counts', [`${SPARK}|[miss]`, '|-miss|p1a: Luxray|p2a: Garchomp'], { lastMoveBy: [MOVE.Spark, 0] }, EMPTY],
    ...[['|cant|p1a: Luxray|par'], ['|cant|p1a: Luxray|slp'], ['|-activate|p1a: Luxray|confusion', '|-damage|p1a: Luxray|80/155|[from] confusion'],
      ['|move|p1a: Luxray|Tackle|[notarget]']].map((log): Case => [`a Pokémon that can't move resets it: ${log[0]}`, log, afterDragonClaw(0)]),
    ['a called move is the caller\'s last move and hits as itself', METRONOME, { lastMoveBy: [MOVE.Metronome, 0], lastHitBy: hitBy(MOVE.Thunderbolt) }, EMPTY],
    ['a lost Focus Punch counts', ['|cant|p1a: Luxray|Focus Punch|Focus Punch'], { lastMoveBy: [MOVE['Focus Punch'], 0], lastHitBy: hitBy(MOVE['Focus Punch']) }, EMPTY],
    ['a |cant| about another Pokémon\'s move leaves its own Pokémon alone', ['|move|p1a: Luxray|Explosion|p2a: Garchomp',
      '|cant|p2a: Garchomp|ability: Damp|Explosion|[of] p1a: Luxray'], { ...afterDragonClaw(MOVE.Explosion), moves: Z }, LATER],
    ['the player\'s move after the AI\'s hits it, missed or not', [EARTHQUAKE, `${SPARK}|[miss]`], { lastHitBy: SPARK_HIT }],
    ['the AI\'s own action clears it', ['|cant|p2a: Garchomp|flinch'], { lastHitBy: null }, HIT],
    ['a player move aimed at itself is no hit', [SWORDS_DANCE], { lastHitBy: SPARK_HIT }, HIT],
    ['a player attempt that fails before its move clears it', ['|cant|p1a: Luxray|par'], { lastHitBy: null }, HIT],
    ['a move the AI\'s Magic Coat bounced is no hit', ['|move|p2a: Garchomp|Magic Coat|p2a: Garchomp', '|move|p1a: Luxray|Toxic|p2a: Garchomp',
      '|move|p2a: Garchomp|Toxic|p1a: Luxray|[from]move: Magic Coat'], { lastHitBy: null, lastMoveBy: [MOVE.Toxic, MOVE['Magic Coat']] }],
    // The AI's bag item clears it, as its action's MoveEnd does (battle_controller_player.c:4389).
    ['the AI\'s bag item clears it', [FULL_RESTORE, '|-heal|p2a: Garchomp|183/183|[from] item: Full Restore', SWORDS_DANCE], { lastHitBy: null }, HIT],
    ['a player move after the bag item hits it again', [FULL_RESTORE, SPARK], { lastHitBy: SPARK_HIT }, HIT],
    ...PLAYER_OUT.map((line): Case => [`the player's battler leaving clears all the AI knows of it: ${line}`, [line],
      { moves: Z, ability: 0, item: 0, ...afterDragonClaw(0) }, KNOWING]),
    ['an AI switch clears its last move and what last hit it', [GYARADOS_IN], { lastMoveBy: [MOVE.Surf, 0], lastHitBy: null, moves: Z }, HIT],
  ]);
});

// TryPursuit runs the pursuer's Pursuit inside the switcher's action and sets movePrevByBattler[pursuer]
// (battle_script.c:6930); the script path never reaches UpdateFlagsWhenHit (battle_controller_player.c:4477), so the
// hit sets no moveHit, and the ClearFlags (:4389) that ends the action is the switcher's.
describe('rememberStep: a Pursuit at a switching Pokémon is the pursuer\'s own move', () => {
  const pursued = [PURSUIT_AT_SWITCH, '|-damage|p2a: Garchomp|100/183', GYARADOS_IN];
  table(T1, [
    ['the player\'s Pursuit at a switching AI is the player\'s last move; the switch runs no TrainerAI_Main', pursued, { lastMoveBy: [MOVE.Pursuit, 0], moves: Z }],
    ['the next TrainerAI_Main records it', ['|move|p2a: Gyarados|Surf|p1a: Luxray'], { moves: one(MOVE.Pursuit) }, { ...step(T1, pursued), turnFight: 'menu' }],
    ['at the AI\'s U-turn it runs inside the AI\'s action: kept in switchAction, and it sets no moveHit',
      [U_TURN, '|-damage|p1a: Luxray|100/155', PURSUIT_AT_SWITCH, '|-damage|p2a: Garchomp|90/183'],
      { switchAction: [MOVE['U-turn'], MOVE.Pursuit], lastMoveBy: [MOVE.Pursuit, MOVE['U-turn']], lastHitBy: null }, T1, 'enemyMidTurnSwitch'],
    // The AI's skipped action runs MoveEnd with the switcher as a stale attacker (battle_controller_player.c:893).
    ['the AI\'s Pursuit at a switching player is the AI\'s last move, and the AI\'s moveHit stays',
      ['|move|p2a: Garchomp|Pursuit|p1a: Luxray|[from] Pursuit', '|-damage|p1a: Luxray|60/155', GENGAR_IN], { lastMoveBy: [0, MOVE.Pursuit], lastHitBy: SPARK_HIT }, HIT],
  ]);
});

// Only a message whose ability or item tag names a battler records it (BattleMessage_AbilityTag, battle_script.c:11798–11806;
// BattleMessage_ItemTag, :11728–11745), and so do the commands that set an ability (:3074, :3403).
describe('rememberStep: abilities and items the AI learns', () => {
  const learns = (name: string, log: string[], ability: number): Case => [name, log, { ability }];
  table(EMPTY, [
    learns('an ability reveal', ['|-ability|p1a: Gengar|Levitate'], ABILITY.Levitate),
    learns('a [from] ability tag names its [of] owner: Rough Skin', ['|-damage|p2a: Garchomp|160/183|[from] ability: Rough Skin|[of] p1a: Luxray'], ABILITY['Rough Skin']),
    learns('a [from] ability tag names its [of] owner: Static', ['|-status|p2a: Garchomp|par|[from] ability: Static|[of] p1a: Luxray'], ABILITY.Static),
    learns('a heal names its own Pokémon\'s ability', ['|-heal|p1a: Luxray|155/155|[from] ability: Water Absorb|[of] p2a: Garchomp'], ABILITY['Water Absorb']),
    learns('the AI\'s Trace tags its target\'s ability', ['|-ability|p2a: Gardevoir|Rough Skin|Trace|[from] ability: Trace|[of] p1a: Garchomp'], ABILITY['Rough Skin']),
    learns('the player\'s Trace sets its new ability', ['|-ability|p1a: Gardevoir|Static|Trace|[from] ability: Trace|[of] p2a: Raichu'], ABILITY.Static),
    // A stat change's message is buffered (battle_script.c:2853–2854, 2955–2961), never through BattleMessage_AbilityTag.
    learns('Intimidate tells nothing', ['|-ability|p1a: Gyarados|Intimidate|boost', '|-unboost|p2a: Garchomp|atk|1'], 0),
    learns('Download tells nothing', ['|-ability|p1a: Porygon-Z|Download|boost', '|-boost|p1a: Porygon-Z|spa|1'], 0),
    learns('Speed Boost tells nothing', ['|-ability|p1a: Ninjask|Speed Boost|boost', '|-boost|p1a: Ninjask|spe|1'], 0),
    learns('Steadfast tells nothing', ['|-ability|p1a: Lucario|Steadfast|boost', '|-boost|p1a: Lucario|spe|1'], 0),
    learns('Motor Drive prints its own tagged message', ['|-ability|p1a: Electivire|Motor Drive|boost', '|-boost|p1a: Electivire|spe|1'], ABILITY['Motor Drive']),
    learns('a stat drop Clear Body blocks tells nothing',
      ['|-ability|p2a: Gyarados|Intimidate|boost', '|-fail|p1a: Metagross|unboost|[from] ability: Clear Body|[of] p1a: Metagross'], 0),
    learns('a stat drop Hyper Cutter blocks tells nothing', ['|-fail|p1a: Kingler|unboost|Attack|[from] ability: Hyper Cutter|[of] p1a: Kingler'], 0),
    // Frisk tags BTLSCR_MSG_TEMP, the found item, which records no battler (battle_script.c:11745–11747).
    ['the AI\'s Frisk tells nothing', ['|-item||Choice Scarf|[from] ability: Frisk|[of] p2a: Banette|[identify]'], { item: 0 }],
    ['the AI\'s Frisk naming the holder tells nothing', ['|-item|p1a: Garchomp|Choice Scarf|[from] ability: Frisk|[of] p2a: Banette'], { item: 0 }],
    learns('the player\'s Frisk tells nothing', ['|-item||Sitrus Berry|[from] ability: Frisk|[of] p1a: Banette'], 0),
    learns('Forecast\'s form change prints the nickname alone', ['|-formechange|p1a: Castform|Castform-Rainy|[msg]|[from] ability: Forecast'], 0),
    learns('a status cure tags msgAbilityTemp (battle_lib.c:4442–4445)', ['|-activate|p1a: Persian|ability: Limber', '|-curestatus|p1a: Persian|par|[msg]'], 0),
    learns('Pressure tags BTLSCR_MSG_BATTLER_TEMP', ['|-ability|p1a: Dusknoir|Pressure'], ABILITY.Pressure),
    ['a Leftovers heal reveals the item', ['|-heal|p1a: Luxray|100/155|[from] item: Leftovers'], { item: ITEM.Leftovers }],
    ['Trick\'s message tags the item', ['|-item|p1a: Luxray|Sitrus Berry|[from] move: Trick'], { item: ITEM['Sitrus Berry'] }],
    ['an item named by -activate is revealed', ['|-activate|p1a: Luxray|item: Focus Band'], { item: ITEM['Focus Band'] }],
    // battle_lib.c:1822: once the held item is gone the AI forgets it, though the berry is named as it heals.
    ['a berry eaten is forgotten', ['|-enditem|p1a: Luxray|Sitrus Berry|[eat]', '|-heal|p1a: Luxray|120/155|[from] item: Sitrus Berry'], { item: 0 },
      step(EMPTY, ['|-item|p1a: Luxray|Sitrus Berry|[from] move: Trick'])],
  ]);
});

// A weather ability's switch-in runs its subscript, and so the message that reveals it, only while its own _PERM bit is
// clear (battle_lib.c:3746–3782). The memory keeps the cartridge's _PERM weather from the field note on.
describe('rememberStep: the _PERM weather a weather ability finds, and the note\'s fog', () => {
  const HAIL_MOVE = '|move|p2a: Garchomp|Hail|p2a: Garchomp';
  const hidden = { ability: 0, permWeather: 'rain' };
  const revealed = { ability: ABILITY.Drizzle };
  table(EMPTY, [
    ['a weather ability into its own _PERM weather reveals nothing, mid-battle too', [KYOGRE_IN, DRIZZLE], hidden, RAIN],
    ['one into another weather reveals itself and sets its own (subscript_drizzle.s:11–12)', [DRIZZLE], { ...revealed, permWeather: 'rain' }, initialMemoryData('sun')],
    ['one with no note weather reveals itself', [DRIZZLE], revealed],
    // effect_script_0136.s:5 fails while either RAINING bit is set (Sunny Day, Sandstorm alike; the engine logs the move);
    // else it clears every weather bit and sets a _TEMP one (:8–9, effect_script_0137.s:5, 8–9).
    ['a weather move into its own _PERM weather fails', [DRIZZLE], hidden, step(RAIN, RAIN_DANCE)],
    ['with no _PERM weather a weather move sets a _TEMP bit', [DRIZZLE], revealed, step(EMPTY, RAIN_DANCE)],
    ['a weather move into another weather clears the _PERM bit', [DRIZZLE], revealed, step(RAIN, ['|move|p2a: Garchomp|Sunny Day|p2a: Garchomp', '|-weather|SunnyDay'])],
    // The turn end counts down a _TEMP weather alone, and its end clears the _TEMP bit alone (subscript_raining_end.s:5).
    ['a turn end and a weather\'s end leave a _PERM weather', [DRIZZLE], hidden, step(RAIN, [...RAIN_DANCE, '|-weather|RainDance|[upkeep]', '|-weather|none'])],
    ['a plain weather line at battle start keeps the note\'s', [DRIZZLE], hidden, step(RAIN, [KYOGRE_IN, '|-weather|RainDance'])],
    ['a plain hail line keeps the note\'s hail', ['|-weather|Hail'], { permWeather: 'hail' }, HAIL],
    // Hail tests only HAILING_TEMP (effect_script_0164.s:5): the move's line turns a _PERM hail into a _TEMP one.
    ['Hail under the note\'s hail clears its _PERM bit', ['|-weather|Hail|[from] ability: Snow Warning|[of] p1a: Abomasnow'],
      { ability: ABILITY['Snow Warning'], permWeather: 'hail' }, step(HAIL, [HAIL_MOVE, '|-weather|Hail'])],
    ['Hail that the engine fails under its own hail still clears it', [HAIL_MOVE, '|-fail|p2a: Garchomp'], { permWeather: null }, HAIL],
    ['a called Hail runs the same script (battle_script.c:2111–2130)', ['|move|p2a: Garchomp|Metronome|p2a: Garchomp',
      '|move|p2a: Garchomp|Hail|p2a: Garchomp|[from]move: Metronome', '|-fail|p2a: Garchomp'], { permWeather: null }, HAIL],
    // The note's deep fog is in the weather mask: a weather or a Defog clears it (subscript_defog.s:64–65).
    ['the fog stands through a turn with no weather', ['|move|p2a: Garchomp|Surf|p1a: Luxray', '|-weather|RainDance|[upkeep]', '|-weather|none'], { fog: 'standing' }],
    ['a weather ability clears the fog (subscript_drizzle.s:11)', [DRIZZLE], { fog: 'cleared' }],
    ['a weather move clears the fog (effect_script_0136.s:8)', RAIN_DANCE, { fog: 'cleared' }],
    ['the player\'s weather move clears the fog', ['|move|p1a: Luxray|Sunny Day|p1a: Luxray', '|-weather|SunnyDay'], { fog: 'cleared' }],
    ['Hail clears it by its own line, where the engine logs no weather (effect_script_0164.s:8)', [HAIL_MOVE], { fog: 'cleared' }],
    ['Defog makes a standing fog unknown', [DEFOG], { fog: 'unknown' }],
    ['a weather after a Defog clears it', RAIN_DANCE, { fog: 'cleared' }, step(EMPTY, [DEFOG])],
    ['a cleared fog stays cleared', [DEFOG], { fog: 'cleared' }, { ...EMPTY, fog: 'cleared' }],
  ]);
});

// The cartridge's recycleItem follows Showdown's lastItem except where BtlCmd_RemoveItem empties a defender's slot
// (battle_script.c:8978): only Bug Bite and Pluck (subscript_pluck.s:10) record a berry Showdown's takeItem doesn't.
describe('rememberStep: the berry Bug Bite or Pluck eats', () => {
  const PLUCKED = step(EMPTY, [
    '|move|p1a: Luxray|Bug Bite|p2a: Garchomp', '|-damage|p2a: Garchomp|170/183',
    '|-enditem|p2a: Garchomp|Sitrus Berry|[from] stealeat|[move] Bug Bite|[of] p1a: Luxray',
  ]);
  const kept = { recycleOverride: [null, ITEM['Sitrus Berry']] };
  const ended = { recycleOverride: [null, null] };
  const recycle = (move: string) => `|move|p2a: Garchomp|${move}|p2a: Garchomp`;
  it('is recorded in the victim\'s slot', () => expect(PLUCKED.recycleOverride).toEqual(kept.recycleOverride));
  table(PLUCKED, [
    ['a Pluck on the player is recorded, and its berry forgotten (battle_lib.c:1822)', ['|move|p2a: Garchomp|Pluck|p1a: Luxray',
      '|-enditem|p1a: Luxray|Lum Berry|[from] stealeat|[move] Pluck|[of] p2a: Garchomp'], { recycleOverride: [ITEM['Lum Berry'], null], item: 0 }, EMPTY],
    ['it stays with the slot through a switch and a faint', [GYARADOS_IN, '|faint|p2a: Gyarados'], kept],
    ...['|-enditem|p2a: Garchomp|Lum Berry|[eat]', '|-enditem|p2a: Garchomp|Focus Sash', '|-enditem|p2a: Garchomp|Lum Berry|[from] move: Fling']
      .map((line): Case => [`it ends when the slot uses up its own item: ${line}`, [line], ended]),
    ...['|-enditem|p2a: Garchomp|Leftovers|[from] move: Knock Off|[of] p1a: Luxray', '|-enditem|p2a: Garchomp|Leftovers|[silent]|[from] move: Thief|[of] p1a: Luxray',
      '|-item|p2a: Garchomp|Leftovers|[from] move: Trick'].map((line): Case => [`it is kept when another move takes the item: ${line}`, [line], kept]),
    // The cartridge's Recycle gives back the berry (battle_script.c:9005–9007); Natural Gift's record the log can't show.
    ...['Recycle', 'Natural Gift'].map((move): Case => [`a ${move} in that slot turns it unknown`, [recycle(move)], { recycleOverride: [null, 'unknown'] }]),
    ['an unknown one ends when the slot uses up an item', ['|-enditem|p2a: Garchomp|Lum Berry|[eat]'], ended, step(PLUCKED, [recycle('Recycle')])],
    ['a Recycle in the other slot leaves it', ['|move|p1a: Luxray|Recycle|p1a: Luxray'], kept],
    ['a Recycle with no Bug Bite before notes nothing', [recycle('Recycle')], ended, EMPTY],
  ]);
});

describe('rememberStep: the AI\'s switching action, and what its BattleMon keeps through a faint', () => {
  const uTurn = [SPARK, '|-damage|p2a: Garchomp|120/183', U_TURN, '|-damage|p1a: Luxray|100/155'];
  const ALL_FIELDS = ['ability', 'attack', 'defense', 'form', 'moves', 'spAttack', 'spDefense', 'species', 'speed', 'types'];
  const swapped = step(T1, [SKILL_SWAP]);
  const kept = (...fields: string[]) => ({ aiKept: fields.map((field) => `mons.1.${field}`) });
  table(T1, [
    ['a step that ends at the AI\'s mid-turn switch keeps that action\'s moves', uTurn, { switchAction: [MOVE['U-turn']] }, T1, 'enemyMidTurnSwitch'],
    ['any other step keeps none', uTurn, { switchAction: [] }],
    ['a turn choice keeps none', uTurn, { switchAction: [] }, T1, 'turnChoice'],
    ['a called U-turn runs in its caller\'s action', [SPARK, '|move|p2a: Garchomp|Metronome|p2a: Garchomp', `${U_TURN}|[from]move: Metronome`],
      { switchAction: [MOVE.Metronome, MOVE['U-turn']] }, T1, 'enemyMidTurnSwitch'],
    ['a step at the switch that shows no AI action keeps null, which the adapter refuses', [SPARK], { switchAction: null }, T1, 'enemyMidTurnSwitch'],
    // Changes since its switch-in (CleanupFaintedMon leaves them); a Trace is aiTraced instead (below).
    ['an announcement is no change', ['|-ability|p2a: Garchomp|Levitate'], kept()],
    ['a Trace is no field to list', [TRACE], kept()],
    ['the player\'s own changes are not the AI battler\'s', ['|-ability|p1a: Luxray|Levitate|[from] ability: Trace|[of] p2a: Garchomp'], kept()],
    ...AI_ABILITY_CHANGES.slice(0, 3).map((line): Case => [`an ability change: ${line}`, [line], kept('ability')]),
    ['a type change', ['|-start|p2a: Garchomp|typechange|Water|[from] ability: Static'], kept('types')],
    ['Power Trick', ['|-start|p2a: Garchomp|Power Trick'], kept('attack', 'defense')],
    // Not the weight: its path is the guarded PATHS.weight, which no stage-2 read of the attacker reaches.
    ['Transform', [AI_ABILITY_CHANGES[3]!], kept(...ALL_FIELDS)],
    ['a form change', [AI_ABILITY_CHANGES[4]!], { aiKept: expect.arrayContaining(['mons.1.types']) }],
    ['the faint keeps them', [GARCHOMP_FAINTS], kept('ability'), swapped],
    ['the next switch-in clears them', [GYARADOS_IN], kept(), step(swapped, [GARCHOMP_FAINTS])],
    ['sorted and unique', ['|-start|p2a: Garchomp|typechange|Water', '|-ability|p2a: Garchomp|Static|[from] move: Role Play'], kept('ability', 'types'), swapped],
  ]);

  it('keeps the ability a Trace gave the AI\'s battler through a faint, until another change or a new BattleMon (aiTraced)', () => {
    // subscript_trace.s:6–7 copies the traced ability into the tracer's BattleMon; CleanupFaintedMon leaves it
    // (battle_lib.c:2156–2210). Showdown's Gen 4 Trace takes the same foe's, and its line names it.
    const traced = step(T1, [TRACE]);
    const fainted = step(traced, [GARCHOMP_FAINTS]);
    for (const m of [traced, fainted, step(traced, ['|-ability|p2a: Garchomp|Levitate'])]) expect([m.aiTraced, m.aiKept]).toEqual([ABILITY.Levitate, []]);
    expect([step(fainted, [GYARADOS_IN]).aiTraced, step(traced, [AI_OUT[1]!]).aiTraced]).toEqual([undefined, undefined]);
    for (const line of AI_ABILITY_CHANGES) {
      const changed = step(traced, [line]);
      expect([line, changed.aiTraced, changed.aiKept.includes('mons.1.ability')]).toEqual([line, undefined, true]);
    }
    // A Trace after such a change sets it again; the other kept fields stay listed.
    const retraced = step(traced, ['|-start|p2a: Garchomp|typechange|Water', AI_ABILITY_CHANGES[3]!, TRACE]);
    expect([retraced.aiTraced, retraced.aiKept.includes('mons.1.ability'), retraced.aiKept.includes('mons.1.types')]).toEqual([ABILITY.Levitate, false, true]);
    // Absent, not null, when there is none (the player's Trace is not the AI battler's): such a memory keys as before.
    expect(step(T1, ['|-ability|p1a: Luxray|Levitate|Trace|[from] ability: Trace|[of] p2a: Garchomp'])).not.toHaveProperty('aiTraced');
    expect(memoryKey(T1)).not.toContain('aiTraced');
    expect(JSON.parse(memoryKey(traced)).aiTraced).toBe(ABILITY.Levitate);
  });
});

// BtlCmd_TryImprison sets MOVE_EFFECT_IMPRISONED on the user's foe before it checks that Imprison works
// (battle_script.c:6686–6692), once the move is past the before-move checks (a `|move|` line, not `|cant|`). Only a new
// BattleMon clears the mark: a switch-in (battle_lib.c:2071; Baton Pass's mask lacks the bit, :2076) or a faint (:2166).
describe('rememberStep: the foe\'s Imprison mark (MOVE_EFFECT_IMPRISONED)', () => {
  const MARKED = step(T1, ['|move|p2a: Garchomp|Imprison|p2a: Garchomp', '|-fail|p2a: Garchomp']); // Luxray is marked
  const faintedFirst = [
    '|move|p2a: Garchomp|Explosion|p1a: Luxray', '|-damage|p1a: Luxray|20/155', GARCHOMP_FAINTS, '|move|p1a: Luxray|Imprison|p1a: Luxray', '|-fail|p1a: Luxray',
  ];
  const mark = (name: string, log: string[], imprisonedMark: boolean[], start = T1, phase?: string): Case => [name, log, { imprisonedMark }, start, phase];
  const [AI, PLAYER, NONE] = [[true, false], [false, true], [false, false]];
  table(T1, [
    mark('a failed Imprison marks the foe', ['|move|p2a: Garchomp|Imprison|p2a: Garchomp', '|-fail|p2a: Garchomp'], AI),
    mark('the player\'s failed Imprison marks the AI', ['|move|p1a: Luxray|Imprison|p1a: Luxray', '|-fail|p1a: Luxray'], PLAYER),
    mark('a working Imprison marks the foe, not the user', ['|move|p1a: Luxray|Imprison|p1a: Luxray', '|-start|p1a: Luxray|move: Imprison'], PLAYER),
    mark('the AI\'s working Imprison marks the player', ['|move|p2a: Garchomp|Imprison|p2a: Garchomp', '|-start|p2a: Garchomp|move: Imprison'], AI),
    ...PLAYER_OUT.map((line) => mark(`the marked Pokémon leaving clears it: ${line}`, [line], NONE, MARKED)),
    ...AI_OUT.map((line) => mark(`the imprisoner leaving keeps it: ${line}`, [line], AI, MARKED)),
    mark('a mid-turn switch step keeps it until the switch-in', PLAYER_U_TURN, AI, MARKED, 'playerMidTurnSwitch'),
    mark('the mid-turn switch-in clears it', [GENGAR_IN], NONE, step(MARKED, PLAYER_U_TURN, 'playerMidTurnSwitch')),
    ...[['|cant|p2a: Garchomp|slp'], ['|cant|p2a: Garchomp|par'], ['|cant|p2a: Garchomp|flinch'], ['|cant|p2a: Garchomp|move: Imprison|Imprison'],
      ['|cant|p2a: Garchomp|move: Taunt|Imprison'], ['|-activate|p2a: Garchomp|confusion', '|-damage|p2a: Garchomp|130/183|[from] confusion'],
      ['|move|p2a: Garchomp|Imprison|[notarget]']].map((log) => mark(`an Imprison that never ran marks nothing: ${log[0]}`, log, NONE)),
    mark('a Metronome-called Imprison marks: GoToMoveScript runs its script', ['|move|p2a: Garchomp|Metronome|p2a: Garchomp',
      '|move|p2a: Garchomp|Imprison|p2a: Garchomp|[from]move: Metronome', '|-fail|p2a: Garchomp'], AI),
    mark('a Sleep Talk-called Imprison marks', ['|move|p1a: Luxray|Sleep Talk|p1a: Luxray', '|move|p1a: Luxray|Imprison|p1a: Luxray|[from]move: Sleep Talk',
      '|-start|p1a: Luxray|move: Imprison'], PLAYER),
    mark('Baton Pass doesn\'t pass the mark (moves.h:46–48)', ['|move|p1a: Luxray|Baton Pass|p1a: Luxray', GENGAR_IN], NONE, MARKED),
    mark('the imprisoner\'s Baton Pass leaves the foe marked', ['|move|p2a: Garchomp|Baton Pass|p2a: Garchomp', GYARADOS_IN], AI, MARKED),
    // The player's RANGE_USER Imprison still runs after the AI fainted (battle_lib.c:1665–1669) and marks the fainted one.
    mark('a mark set on a fainted Pokémon', faintedFirst, PLAYER, T1, 'enemyReplacement'),
    mark('a mark on a fainted Pokémon lasts until the replacement comes in', [GYARADOS_IN], NONE, step(T1, faintedFirst, 'enemyReplacement')),
    mark('later steps keep the mark', [SPARK, DRAGON_CLAW], AI, MARKED),
  ]);
});
