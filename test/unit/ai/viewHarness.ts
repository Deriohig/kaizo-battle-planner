// Shared setup for the AI read tests: the fixture battle and ROM data, edits to a battle, and what a build throws.
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import { buildMoves } from '../../../src/battle/moves.js';
import type { LoadedData } from '../../../src/battle/types.js';
import type { BattleInput, Choice, EngineState } from '../../../src/contracts/engine.js';
import { createBattle, expandTurn, installKaizoDex, restore, snapshot } from '../../../src/engine/index.js';
import { BAG, fixtureData, ID, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';
import { fixtureDeps, FX } from './fixtures.js';

export const data = fixtureData();
export const installDex = (): void => installKaizoDex(data, buildMoves(data));

/** Pokédex weights: 1 for every species but none (a hole) for `missing`. */
function weights(...missing: number[]): number[] {
  const table = Array<number>(494).fill(1);
  for (const species of missing) delete table[species];
  return table;
}
const deps = fixtureDeps();
export const ai: AiRomData = {
  scriptWords: Array.from(deps.script.words), flagEntries: [...deps.script.flagEntries], scriptSha256: deps.script.sha256,
  items: deps.items, typeChart: deps.typeChart, weights: weights(), formWeights: weights(),
};
/** `ai` without a Pokédex weight for `species`. */
export const weightless = (species: number): AiRomData => ({ ...ai, weights: weights(species), formWeights: weights(species) });
/** `data` without a Personal row for `species` (form 0). */
export function rowless(species: number): LoadedData {
  const rows = [...data.rom.species];
  delete rows[species];
  return { ...data, rom: { ...data.rom, species: rows } };
}

export const move = (slot: number): Choice => ({ kind: 'move', slot });

/** The player's Monferno (L30; Leftovers) against the trainer's Zigzagoon (L20; Sitrus Berry) and Bidoof (L25), with a bag of Potions. */
export function battleInput(): BattleInput {
  return {
    player: [playerMon(ID.monferno, 30, [ID.ember, ID.tackle], { item: FX.item.LEFTOVERS })],
    trainer: resolvedTrainer(BAG.potions, [
      resolvedMon(ID.zigzagoon, 20, [ID.tackle, ID.growl], { item: FX.item.SITRUS_BERRY }), resolvedMon(ID.bidoof, 25, [ID.waterBall]),
    ]),
    field: {},
  };
}

/** `state` with `change` made to its battle (restored, changed, snapshotted). */
export function changedFrom(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
/** The battle start with `change` made to its battle. */
export const changed = (change: (battle: Battle) => void): EngineState => changedFrom(createBattle(battleInput()), change);

/** The AI's mid-turn switch, where its faster U-turn (Zigzagoon at L60) left Monferno's first move queued. */
export function uTurnSwitch(playerMoves: number[] = [ID.ember, ID.tackle]): EngineState {
  const start = createBattle({
    ...battleInput(),
    player: [playerMon(ID.monferno, 30, playerMoves, { item: FX.item.LEFTOVERS })],
    trainer: resolvedTrainer(BAG.potions, [resolvedMon(ID.zigzagoon, 60, [ID.uTurn], { item: 0 }), resolvedMon(ID.bidoof, 25, [ID.waterBall])]),
  });
  const switching = expandTurn(start, { p1: move(0), p2: move(0) }).find((outcome) => outcome.state.phase.kind === 'enemyMidTurnSwitch');
  if (switching === undefined) throw new Error('no outcome reaches the AI\'s mid-turn switch');
  return switching.state;
}

/** What `run` throws (the object itself), or null. */
export function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}
/** What `run` throws, as `<class>[ <code>]: <message>`, or 'no throw'. */
export function thrown(run: () => unknown): string {
  const error = thrownBy(run);
  if (error === null) return 'no throw';
  const code = (error as { code?: unknown } | undefined)?.code;
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  return `${kind}${typeof code === 'string' ? ` ${code}` : ''}: ${error instanceof Error ? error.message : String(error)}`;
}
export const badView = (message: string): string => `AiError BAD_VIEW: ${message}`;

/** `value` frozen all the way down, so a test of a pure function fails at any write to its input. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

type Change = (b: Battle) => void;
const volatile = (pokemon: Pokemon, id: string, fields: object): void => { (pokemon.volatiles as Record<string, unknown>)[id] = { id, ...fields }; };
const lastMove = (pokemon: Pokemon, id: string): void => { (pokemon as { lastMove: unknown }).lastMove = { id }; };
/** Integrity faults made by hand on a battle: IDs with no ROM ID or cartridge encoding, and records a battle should have. */
export const FAULT = {
  enemyStatus: (b) => { b.p2.active[0]!.status = 'xyz' as ID; },
  playerStatus: (b) => { b.p1.active[0]!.status = 'xyz' as ID; },
  enemyAbility: (b) => { b.p2.active[0]!.ability = 'nonsense' as ID; },
  playerAbility: (b) => { b.p1.active[0]!.ability = 'nonsense' as ID; },
  enemyItem: (b) => { b.p2.active[0]!.item = 'nonsense' as ID; },
  playerItem: (b) => { b.p1.active[0]!.item = 'nonsense' as ID; },
  enemyTypes: (b) => { b.p2.active[0]!.types = ['Nonsense']; },
  playerTypes: (b) => { b.p1.active[0]!.types = ['Nonsense']; },
  enemyMoveSlot: (b) => { (b.p2.active[0]!.moveSlots[0] as { id: string }).id = 'nonsense'; },
  benchStatus: (b) => { b.p2.pokemon[1]!.status = 'abc' as ID; },
  leadPartyAbility: (b) => { b.p2.pokemon[0]!.baseAbility = 'nonsense' as ID; },
  weather: (b) => { b.field.weather = 'desolateland' as ID; },
  playerLastItem: (b) => { b.p1.active[0]!.lastItem = 'nonsense' as ID; },
  enemyLastItem: (b) => { b.p2.active[0]!.lastItem = 'nonsense' as ID; },
  noTrainer: (b) => { delete b.formatData['kaizoTrainer']; },
  noNote: (b) => { delete b.formatData['kaizoField']; },
  noBag: (b) => { delete b.formatData['kaizoTrainerBag']; },
  leechSeedFromNoSide: (b) => volatile(b.p2.active[0]!, 'leechseed', { sourceSlot: 'p3a' }),
  /** A live Protect chain whose last move has no ROM ID: the battler's moveProtect and protectChainKnown fault. */
  playerProtecting: (b) => { volatile(b.p1.active[0]!, 'stall', { counter: 2 }); lastMove(b.p1.active[0]!, 'aaa'); },
  /** The AI's battler after a bag item, no chain alive, its last move with no ROM ID: protectChainKnown alone faults. */
  enemyChain: (b) => { lastMove(b.p2.active[0]!, 'zzz'); b.formatData['kaizoTrainerBag'].items[0] = 0; },
  playerDisabled: (b) => volatile(b.p1.active[0]!, 'disable', { move: 'nonsense' }),
  enemyDisabled: (b) => volatile(b.p2.active[0]!, 'disable', { move: 'nonsense' }),
  /** A set not in its side's team: the restore itself fails. */
  foreignSet: (b) => { (b.p2.active[0] as { set: unknown }).set = { ...b.p2.active[0]!.set }; },
} satisfies Record<string, Change>;
/** At the AI's U-turn switch: the player's queued move broken (null), which the read of the queue meets. */
export const breakQueue: Change = (b) => { for (const a of b.queue.list) if (a.choice === 'move' && a.pokemon.side === b.p1) (a as { move: unknown }).move = null; };
/** All of `changes` in turn. */
export const both = (...changes: Change[]): Change => (b) => { for (const change of changes) change(b); };
