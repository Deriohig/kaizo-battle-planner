// The corpus for facts.test.ts and peekSeed*.test.ts: eight base inputs and Mimic's, twelve broader ones and two
// Transformed starts, walked over the fixture dex with Mimic and a Monferno learnset (a scripted knock-out teaches it a
// move). Each step's outcomes go to a callback right after their `expandTurn`, while `peek` still holds them unread.

import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { buildMoves, type KaizoMove } from '../../../src/battle/moves.js';
import type { LoadedData } from '../../../src/battle/types.js';
import { createBattle, expandTurn, legalChoices, restore, snapshot } from '../../../src/engine/index.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import { BAG, emberTurn, FIXTURE_MOVES, fixtureData, ID, ITEM, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';
import { type Corpus, emptyCorpus, walk } from './walk.js';

/** Mimic (the hack's ROM record and docs row): never misses, 10 PP. */
export const MIMIC = 102;
/** Monferno's total EXP at level 31 (medium slow). */
const MONFERNO_31_EXP = 24294;

/** The fixture data with Mimic, Slash for Monferno at 31 (invented), and Magikarp's base EXP 152 (684 at level 21). */
export function peekSeedDex(): { data: LoadedData; moves: Map<number, KaizoMove> } {
  const data = fixtureData();
  data.rom.moves[MIMIC] = {
    id: MIMIC, effect: 82, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 2,
  };
  data.docs.moves.push({
    id: MIMIC, name: 'Mimic', effectText: 'Copies user-selected move', category: 'status', power: 0, type: '', accuracy: 0, pp: 10,
    effectChance: 0, targets: '', priority: 0, contact: false,
  });
  data.names = buildNameIndex(data.docs);
  data.rom.learnsets[ID.monferno] = [{ move: ID.slash, level: 31 }];
  data.rom.species[ID.magikarp]!.baseExp = 152;
  return { data, moves: buildMoves(data) };
}

/** `playerMon` with moves that may include Mimic, which the fixture's move table (its PP) lacks. */
export function playerWith(species: number, level: number, moves: number[]): PlayerMon {
  return {
    ...playerMon(species, level, [ID.tackle]), moves: [...moves], pp: moves.map((id) => (id === MIMIC ? 10 : FIXTURE_MOVES.get(id)!.pp)),
    ppUps: moves.map(() => 0),
  };
}

const SIX = [ID.monferno, ID.zigzagoon, ID.bidoof, ID.castform, ID.deoxys, ID.pikachu];
const FOUR = [ID.tackle, ID.ember, ID.waterBall, ID.furyAttack];
export const sixes = (): BattleInput => ({
  player: SIX.map((species) => playerMon(species, 30, FOUR)),
  trainer: resolvedTrainer(BAG.none, SIX.map((species) => resolvedMon(species, 30, FOUR))), field: {},
});
export const pivots = (): BattleInput => ({
  player: [
    playerMon(ID.monferno, 40, [ID.uTurn, ID.batonPass, ID.ember]), playerMon(ID.bidoof, 40, [ID.uTurn, ID.tackle]),
    playerMon(ID.pikachu, 40, [ID.tackle, ID.thunder]),
  ],
  trainer: resolvedTrainer(BAG.potions, [
    resolvedMon(ID.zigzagoon, 36, [ID.uTurn, ID.tackle]), resolvedMon(ID.castform, 36, [ID.uTurn, ID.tackle, ID.roar]),
    resolvedMon(ID.deoxys, 30, [ID.tackle]),
  ]), field: {},
});
const uTurns = (): BattleInput => ({
  player: [playerMon(ID.monferno, 40, [ID.uTurn]), playerMon(ID.bidoof, 40, [ID.tackle])],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 40, [ID.uTurn]), resolvedMon(ID.castform, 36, [ID.tackle])]), field: {},
});
export const knockouts = (): BattleInput => ({
  player: [playerMon(ID.pikachu, 8, [ID.tackle]), playerMon(ID.bidoof, 60, [ID.doubleEdge, ID.tackle])],
  trainer: resolvedTrainer(BAG.mixedHp, [
    resolvedMon(ID.machop, 55, [ID.hammerArm, ID.tackle]), resolvedMon(ID.zigzagoon, 20, [ID.tackle, ID.growl]),
  ]), field: {},
});
export const locks = (): BattleInput => ({
  player: [
    playerMon(ID.monferno, 35, [ID.outrage, ID.encore, ID.disable, ID.meanLook], { item: ITEM.quickClaw }),
    playerMon(ID.bidoof, 35, [ID.roar, ID.explosion, ID.tackle, ID.whirlwind]),
  ],
  trainer: resolvedTrainer(BAG.battleItems, [
    resolvedMon(ID.zigzagoon, 33, [ID.outrage, ID.encore, ID.roar, ID.tackle], { item: ITEM.quickClaw }),
    resolvedMon(ID.deoxys, 30, [ID.explosion, ID.disable, ID.meanLook, ID.tackle]),
  ]), field: {},
});
const sleepers = (): BattleInput => ({
  player: [
    playerMon(ID.monferno, 30, [ID.spore, ID.rest, ID.sleepTalk, ID.poisonPowder]),
    playerMon(ID.bidoof, 30, [ID.tackle, ID.sleepTalk], { status: { kind: 'sleep', turns: 3 } }),
  ],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 30, [ID.spore, ID.poisonPowder, ID.rest, ID.tackle])]), field: {},
  carry: {
    mons: [
      { hp: 60, pp: [15, 3, 20, 35], status: { kind: 'none' }, item: 0 },
      { hp: 40, pp: [35, 20], status: { kind: 'sleepUndrawn', attempts: 1 }, item: 0 },
    ],
  },
});
const restoring = (): BattleInput => ({
  player: [playerMon(ID.monferno, 25, [ID.ember, ID.tackle, ID.uTurn]), playerMon(ID.bidoof, 25, [ID.tackle])],
  trainer: resolvedTrainer(BAG.fullRestore, [resolvedMon(ID.zigzagoon, 28, [ID.tackle, ID.growl]), resolvedMon(ID.castform, 26, [ID.tackle])]),
  field: {},
});
/** Mimic on both sides, each with moves the other lacks to copy (Mimic fails on a move its user knows). */
const mimics = (): BattleInput => ({
  player: [playerWith(ID.monferno, 30, [MIMIC, ID.tackle, ID.ember]), playerMon(ID.bidoof, 30, [ID.tackle])],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 30, [ID.growl, MIMIC]), resolvedMon(ID.castform, 28, [ID.tackle])]), field: {},
});

/** The eight base inputs with their step counts (facts.test.ts walks these), then Mimic's. */
export const BASE_WALKS: readonly [() => BattleInput, number][] = [
  [emberTurn, 6], [sixes, 3], [pivots, 8], [uTurns, 6], [knockouts, 8], [locks, 8], [restoring, 6], [sleepers, 8], [mimics, 6],
];

/** Broader inputs: more volatiles, conditions, weather and items. */
function broad(): [() => BattleInput, number][] {
  const two = (a: number[], b: number[], c: number[], d: number[], items: { p?: number; t?: number } = {}, bag: number = BAG.none) => (): BattleInput => ({
    player: [
      playerMon(ID.monferno, 34, a, items.p === undefined ? {} : { item: items.p }), playerMon(ID.bidoof, 34, b),
      playerMon(ID.pikachu, 30, [ID.tackle, ID.thunderWave]),
    ],
    trainer: resolvedTrainer(bag, [
      resolvedMon(ID.zigzagoon, 33, c, items.t === undefined ? {} : { item: items.t }), resolvedMon(ID.castform, 32, d),
      resolvedMon(ID.machop, 30, [ID.tackle, ID.lowKick]),
    ]),
    field: {},
  });
  return [
    [two([ID.leechSeed, ID.attract, ID.substitute, ID.confuseRay], [ID.yawn, ID.tackle], [ID.leechSeed, ID.attract, ID.substitute, ID.swagger], [ID.confuseRay, ID.tackle]), 8],
    [two([ID.futureSight, ID.wish, ID.protect, ID.perishSong], [ID.detect, ID.endure, ID.tackle], [ID.futureSight, ID.wish, ID.protect, ID.tackle], [ID.perishSong, ID.protect]), 8],
    [two([ID.rainDance, ID.sandstorm, ID.hail, ID.sunnyDay], [ID.weatherBall, ID.tackle], [ID.sunnyDay, ID.hail, ID.tackle, ID.rainDance], [ID.weatherBall, ID.sandstorm]), 8],
    [two([ID.trickRoom, ID.gravity, ID.tailwind, ID.safeguard], [ID.reflect, ID.lightScreen, ID.mist, ID.tackle], [ID.trickRoom, ID.tailwind, ID.reflect, ID.tackle], [ID.lightScreen, ID.gravity, ID.haze]), 8],
    [two([ID.pursuit, ID.uTurn, ID.batonPass, ID.fakeOut], [ID.pursuit, ID.uTurn], [ID.uTurn, ID.pursuit, ID.batonPass, ID.fakeOut], [ID.pursuit, ID.uTurn, ID.tackle]), 10],
    [two([ID.bide, ID.uproar, ID.wrap, ID.rage], [ID.iceBall, ID.skyAttack], [ID.bide, ID.uproar, ID.wrap, ID.focusPunch], [ID.iceBall, ID.tackle]), 8],
    [two([ID.stealthRock, ID.spikes, ID.toxicSpikes, ID.roar], [ID.whirlwind, ID.tackle, ID.defog], [ID.stealthRock, ID.spikes, ID.toxicSpikes, ID.whirlwind], [ID.roar, ID.tackle]), 8],
    [two([ID.imprison, ID.taunt, ID.torment, ID.disable], [ID.encore, ID.tackle], [ID.imprison, ID.taunt, ID.torment, ID.encore], [ID.disable, ID.tackle, ID.growl]), 8],
    [two([ID.knockOff, ID.thief, ID.bugBite, ID.tackle], [ID.tackle], [ID.knockOff, ID.thief, ID.bugBite, ID.tackle], [ID.tackle], { p: ITEM.sitrusBerry, t: ITEM.leftovers }, BAG.potions), 8],
    [two([ID.tackle, ID.ember, ID.outrage, ID.uTurn], [ID.tackle], [ID.tackle, ID.metronome, ID.sleepTalk, ID.rest], [ID.tackle], { p: ITEM.choiceScarf, t: ITEM.whiteHerb }, BAG.fullRestore), 8],
    [two([ID.destinyBond, ID.memento, ID.painSplit, ID.curse], [ID.explosion, ID.tackle], [ID.destinyBond, ID.selfdestruct, ID.counter, ID.mirrorCoat], [ID.metalBurst, ID.tackle]), 8],
    [two([ID.roost, ID.synthesis, ID.psychUp, ID.acupressure], [ID.assist, ID.lastResort, ID.tackle], [ID.roost, ID.bellyDrum, ID.minimize, ID.focusEnergy], [ID.lunarDance, ID.tackle]), 8],
  ];
}

/** The scripted knock-out: Monferno one EXP short of 31 knocks out a level 21 Magikarp, levels up and learns Slash. */
export const levelUpLearn = (): BattleInput => ({
  player: [playerMon(ID.monferno, 30, [ID.plainHit], { exp: MONFERNO_31_EXP - 1 })],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.magikarp, 21, [ID.growl]), resolvedMon(ID.zigzagoon, 21, [ID.growl])]), field: {},
});

/**
 * Walks the corpus into a new `Corpus`, calling `onStep` with each step's outcomes right after their `expandTurn`: the
 * base walks with `seeds`, the broad ones (`broad`) with seed 1, two Transformed starts, a scripted Mimic on each side,
 * and the scripted level-up knock-out.
 */
export function walkCorpus(onStep: (outcomes: readonly Outcome[]) => void, opts: { seeds?: readonly number[]; broad?: boolean } = {}): Corpus {
  const corpus = emptyCorpus();
  for (const [input, steps] of BASE_WALKS) for (const seed of opts.seeds ?? [1, 2]) walk(corpus, input(), steps, seed, 1_500, onStep);
  if (opts.broad !== false) for (const [input, steps] of broad()) walk(corpus, input(), steps, 1, 1_500, onStep);
  // Transformed battlers: Showdown's own transformInto on a restored state (as levelUp.test.ts does), then steps from it.
  for (const input of [pivots, locks]) {
    const battle = restore(createBattle(input()));
    if (!battle.p1.active[0]!.transformInto(battle.p2.active[0]!)) throw new Error('The transform failed');
    let state: EngineState = snapshot(battle);
    for (let step = 0; step < 4 && state.phase.kind === 'turnChoice'; step++) {
      const [p1, p2] = [legalChoices(state, 'p1'), legalChoices(state, 'p2')];
      const choices: { p1: Choice; p2: Choice } = { p1: p1[step % p1.length]!, p2: p2[(step + 1) % p2.length]! };
      const outcomes = expandTurn(state, choices, { maxLeaves: 1_500 });
      onStep(outcomes);
      addOutcomes(corpus, outcomes);
      state = (outcomes.find((outcome) => outcome.state.phase.kind === 'turnChoice') ?? outcomes[0]!).state;
    }
  }
  // Mimic copies on both sides: Tackle against Growl, then Mimic against Growl (Monferno copies Growl), then the copy
  // against Mimic (Zigzagoon copies Tackle), each step followed by a turn choice.
  const move = (slot: number): Choice => ({ kind: 'move', slot });
  let mimic: EngineState = createBattle(mimics());
  for (const choices of [{ p1: move(1), p2: move(0) }, { p1: move(0), p2: move(0) }, { p1: move(0), p2: move(1) }, { p1: move(1), p2: move(0) }]) {
    const outcomes = expandTurn(mimic, choices, { maxLeaves: 1_500 });
    onStep(outcomes);
    addOutcomes(corpus, outcomes);
    const next = outcomes.find((outcome) => outcome.state.phase.kind === 'turnChoice');
    if (next === undefined) break;
    mimic = next.state;
  }
  const knockout = expandTurn(createBattle(levelUpLearn()), { p1: move(0), p2: move(0) });
  onStep(knockout);
  addOutcomes(corpus, knockout);
  return corpus;
}

function addOutcomes(corpus: Corpus, outcomes: readonly Outcome[]): void {
  for (const outcome of outcomes) {
    corpus.outcomes.push(outcome);
    corpus.states.push(outcome.state);
    corpus.phases.add(outcome.state.phase.kind);
  }
}
