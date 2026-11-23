// viewFromRead (src/ai/read/compose.ts) needs nothing of a read but its contract fields, and meets a fault its source
// registered where the view's one-pass build met it, before or after its own throws (a missing weight or Personal row).
import { beforeAll, describe, expect, it } from 'vitest';
import { MON_CONDITION_FREEZE, MON_CONDITION_PARALYSIS } from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import { type AiMemoryData, initialMemoryData } from '../../../src/ai/memory.js';
import { type ReadFaultKey, registerReadFaults, rethrowReadFault, viewFromRead } from '../../../src/ai/read/compose.js';
import { showdownAiSource } from '../../../src/ai/read/showdown.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import type { LoadedData } from '../../../src/battle/types.js';
import type { AiBattleRead, AiReadMon } from '../../../src/contracts/aiRead.js';
import type { EngineState } from '../../../src/contracts/engine.js';
import { createBattle, expandTurn } from '../../../src/engine/index.js';
import { ABILITY, ID } from '../engine/fixtures.js';
import {
  ai, badView, battleInput, both, breakQueue, changed, changedFrom, data, FAULT, installDex, move, rowless, thrown, thrownBy, uTurnSwitch, weightless,
} from './viewHarness.js';

beforeAll(installDex);

const memory = (changes: Partial<AiMemoryData> = {}): AiMemoryData => ({ ...initialMemoryData(null), ...changes });
const OVERRIDE = memory({ recycleOverride: [ID.tackle, null] });
const composed = (state: EngineState, rom: AiRomData = ai, loaded: LoadedData = data, md: AiMemoryData = memory()): string =>
  thrown(() => viewFromRead(showdownAiSource.read(state), state.phase.kind, loaded, rom, md));
const noWeight = (species: number): string => badView(`the ROM's Pokédex has no weight for species ${species}`);
const noRow = (species: number): string => badView(`no Personal row for species ${species} form 0`);
const badStatus = (status: string): string => badView(`Showdown status "${status}" has no cartridge encoding`);
const noMove = (id: string): string => badView(`Showdown move "${id}" has no ROM ID`);
const NO_ABILITY = badView('Showdown ability "nonsense" has no ROM ID');
const NO_ITEM = badView('Showdown item "nonsense" has no ROM ID');
const NO_WEATHER = badView('Showdown weather "desolateland" has no Gen 4 encoding');

describe('viewFromRead: a read is all it needs', () => {
  it('composes the same view, in the same key order, from a plain copy of the read (a native read)', () => {
    const start = createBattle(battleInput());
    for (const state of [start, ...expandTurn(start, { p1: move(0), p2: move(0) }).map((outcome) => outcome.state)]) {
      const read = showdownAiSource.read(state);
      const copy = structuredClone(read) as AiBattleRead;
      for (const md of [memory(), memory({ imprisonedMark: [true, false], lastMoveBy: [ID.ember, ID.tackle], recycleOverride: [ID.tackle, null] })]) {
        const want = viewFromRead(read, state.phase.kind, data, ai, md);
        const got = viewFromRead(copy, state.phase.kind, data, ai, md);
        expect(got).toStrictEqual(want);
        expect(JSON.stringify(got)).toBe(JSON.stringify(want));
      }
    }
  });

  it('builds the memory-free part once per read and (data, ai), and gives each view its own memory fields', () => {
    const read = showdownAiSource.read(createBattle(battleInput()));
    const plain = viewFromRead(read, 'turnChoice', data, ai, memory());
    const marked = viewFromRead(read, 'turnChoice', data, ai, memory({ imprisonedMark: [false, true], lastMoveBy: [ID.ember, 0] }));
    expect([marked.parties === plain.parties, marked.mons[0] === plain.mons[0], marked.mons[1] === plain.mons[1]]).toEqual([true, true, false]);
    expect([marked.movePrevByBattler === plain.movePrevByBattler, plain.movePrevByBattler[0]]).toEqual([false, 0]);
    // Another ai: its own base, then the first ai's built anew (one pair per read).
    expect(viewFromRead(read, 'turnChoice', data, weightless(ID.castform), memory()).parties).not.toBe(plain.parties);
    const back = viewFromRead(read, 'turnChoice', data, ai, memory());
    expect(back.parties).not.toBe(plain.parties);
    expect(back).toStrictEqual(plain);
  });
});

const { enemyStatus, playerStatus, enemyAbility, benchStatus, leadPartyAbility, weather, playerLastItem, enemyChain, playerDisabled, enemyDisabled } = FAULT;
const NO_MONFERNO = weightless(ID.monferno);
const NO_ZIGZAGOON = weightless(ID.zigzagoon);

// The one-pass order: mons[0]'s weight, effects and status; mons[1]'s ability, moves, types, item, weight, effects and
// status; each party member's Personal row, then its fields; the field mask; the lastItems where the memory has no
// override; protectChainKnown last. The bag and the field note throw eagerly, before the player's battler.
it.each<[name: string, change: (b: Battle) => void, want: string, rom?: AiRomData, loaded?: LoadedData, md?: AiMemoryData]>([
  ['the AI battler\'s status', enemyStatus, badStatus('xyz')],
  ['the AI battler\'s status after the player\'s weight', enemyStatus, noWeight(ID.monferno), NO_MONFERNO],
  ['the AI battler\'s status after its own weight', enemyStatus, noWeight(ID.zigzagoon), NO_ZIGZAGOON],
  ['the player battler\'s status before the AI\'s weight', playerStatus, badStatus('xyz'), NO_ZIGZAGOON],
  ['the player battler\'s status after its own weight', playerStatus, noWeight(ID.monferno), NO_MONFERNO],
  ['the AI battler\'s ability after the player\'s weight', enemyAbility, noWeight(ID.monferno), NO_MONFERNO],
  ['the AI battler\'s ability before its own weight', enemyAbility, NO_ABILITY, NO_ZIGZAGOON],
  ['a bench status', benchStatus, badStatus('abc')],
  ['a bench status after the weights', benchStatus, noWeight(ID.zigzagoon), NO_ZIGZAGOON],
  ['a bench status after its own Personal row', benchStatus, noRow(ID.bidoof), ai, rowless(ID.bidoof)],
  ['the AI lead\'s party fields before the next member\'s row', leadPartyAbility, NO_ABILITY, ai, rowless(ID.bidoof)],
  ['the AI lead\'s party fields after its own row', leadPartyAbility, noRow(ID.zigzagoon), ai, rowless(ID.zigzagoon)],
  ['the field mask after the parties', both(weather, benchStatus), badStatus('abc')],
  ['the field mask', weather, NO_WEATHER],
  ['a lastItem', playerLastItem, NO_ITEM],
  ['a lastItem the memory overrides', playerLastItem, 'no throw', ai, data, OVERRIDE],
  ['a lastItem after the weights', playerLastItem, noWeight(ID.zigzagoon), NO_ZIGZAGOON],
  ['the field mask before an overridden lastItem', both(playerLastItem, weather), NO_WEATHER, ai, data, OVERRIDE],
  ['no trainer: the view doesn\'t read it', FAULT.noTrainer, 'no throw'],
  ['moveProtect in the base, before a lastItem', both(FAULT.playerProtecting, playerLastItem), noMove('aaa')],
  ['protectChainKnown alone', enemyChain, noMove('zzz')],
  ['protectChainKnown after a lastItem', both(enemyChain, playerLastItem), NO_ITEM],
  ['protectChainKnown where the memory overrides the lastItem', both(enemyChain, playerLastItem), noMove('zzz'), ai, data, OVERRIDE],
  ['the player battler\'s effects', playerDisabled, noMove('nonsense')],
  ['the player battler\'s effects after its own weight', playerDisabled, noWeight(ID.monferno), NO_MONFERNO],
  ['the player battler\'s effects before the AI\'s weight', playerDisabled, noMove('nonsense'), NO_ZIGZAGOON],
  ['the AI battler\'s effects', enemyDisabled, noMove('nonsense')],
  ['the AI battler\'s effects after its own weight', enemyDisabled, noWeight(ID.zigzagoon), NO_ZIGZAGOON],
  ...([
    ['move slot', FAULT.enemyMoveSlot, noMove('nonsense')], ['types', FAULT.enemyTypes, badView('Showdown type "Nonsense" has no ROM ID')],
    ['item', FAULT.enemyItem, NO_ITEM],
  ] as const).flatMap(([what, change, error]): [string, (b: Battle) => void, string, AiRomData][] => [
    [`the AI battler's ${what}`, change, error, ai], [`the AI battler's ${what} before its weight`, change, error, NO_ZIGZAGOON],
    [`the AI battler's ${what} after the player's weight`, change, noWeight(ID.monferno), NO_MONFERNO],
  ]),
  ['the bag before the field note', both(FAULT.noBag, FAULT.noNote), 'Error: This battle has no trainer bag: createBattle gives a battle one'],
  ['the field note before the player battler', both(FAULT.playerItem, FAULT.noNote),
    badView('the state has no field-note record: The state holds no field record (not made by createBattle)')],
])('viewFromRead meets %s where the one-pass build did', (_name, change, want, rom = ai, loaded = data, md = memory()) => {
  expect(composed(changed(change), rom, loaded, md)).toBe(want);
});

describe('viewFromRead: faults it meets by hand', () => {
  it('meets a battler\'s moveProtect, not its protectChainKnown, though both fault alike', () => {
    const read = showdownAiSource.read(changed(FAULT.playerProtecting));
    const moveProtect = thrownBy(() => rethrowReadFault(read, 'mons.0.moveProtect'));
    const chain = thrownBy(() => rethrowReadFault(read, 'protectChainKnown'));
    expect([moveProtect instanceof AiError, chain instanceof AiError, chain === moveProtect]).toEqual([true, true, false]);
    expect(thrownBy(() => viewFromRead(read, 'turnChoice', data, ai, memory()))).toBe(moveProtect);
  });

  it('meets partyIndex at selectedPartySlot, after the parties, before the field mask, only while the side has a Pokémon left', () => {
    // A foreign set fails the restore itself (readFaultOrder.test.ts), so the fault is registered by hand on a copy of a read.
    const read = showdownAiSource.read(createBattle(battleInput()));
    const fault = new AiError('BAD_VIEW', 'Zigzagoon has no set in its side\'s team');
    const faulted = (changes: Partial<AiBattleRead>, ...faults: [ReadFaultKey, unknown][]): AiBattleRead => {
      const copy = { ...(structuredClone(read) as AiBattleRead), ...changes };
      registerReadFaults(copy, new Map<ReadFaultKey, unknown>([['mons.1.partyIndex', fault], ...faults]));
      return copy;
    };
    const view = (r: AiBattleRead): unknown => thrownBy(() => viewFromRead(r, 'turnChoice', data, ai, memory()));
    const earlier = new AiError('BAD_VIEW', 'Showdown status "abc" has no cartridge encoding');
    expect(view(faulted({}))).toBe(fault);
    expect(view(faulted({}, ['fieldConditionsMask', new AiError('BAD_VIEW', 'Showdown weather "desolateland" has no Gen 4 encoding')]))).toBe(fault);
    expect(view(faulted({}, ['parties.1.1.fields', earlier]))).toBe(earlier);
    // The AI's side out of Pokémon: selectedPartySlot is 6 there, and partyIndex is never read.
    const fainted = faulted({ parties: [read.parties[0], read.parties[1].map((member) => ({ ...member, hp: 0 }))] });
    expect(view(fainted)).toBeNull();
    expect(viewFromRead(fainted, 'turnChoice', data, ai, memory()).selectedPartySlot).toEqual([0, 6, 0, 0]);
  });

  it("meets the queue's fault only at the AI's mid-turn switch whose action is a U-turn", () => {
    // The queued Ember's move broken (null): the read takes each queued move's num, so it faults here alone.
    const switching = uTurnSwitch();
    const read = showdownAiSource.read(changedFrom(switching, breakQueue));
    const uTurn = memory({ switchAction: [ID.uTurn] });
    expect(thrown(() => viewFromRead(read, 'enemyMidTurnSwitch', data, ai, uTurn))).toBe("TypeError: Cannot read properties of null (reading 'num')");
    // No step showed the AI's action (null): both gaps listed, the queue never read; nor for no action, or one with no U-turn.
    expect(viewFromRead(read, 'enemyMidTurnSwitch', data, ai, memory({ switchAction: null })).unknown).toEqual(['battleStatusMask.turn', 'powerMul']);
    for (const [phase, md] of [['enemyMidTurnSwitch', memory()], ['enemyMidTurnSwitch', memory({ switchAction: [ID.ember] })], ['turnChoice', uTurn]] as const) {
      expect(thrownBy(() => viewFromRead(read, phase, data, ai, md))).toBeNull();
    }
    // Unbroken, the queue gives the Ember: no Pursuit, so U-turn's switch is exact.
    expect(viewFromRead(showdownAiSource.read(switching), 'enemyMidTurnSwitch', data, ai, uTurn).unknown).toEqual([]);
  });
});

// The AI's faster U-turn leaves the player's move queued at the switch; each read queues Pursuit instead (the fixture's
// Pursuit and Rage both have BATTLE_EFFECT_HIT_BEFORE_SWITCH). Where every test the read settles passes, the engine should
// have run it: the view lists powerMul and the U-turn user's HP. Where one fails, TryPursuit doesn't run either.
describe("viewFromRead: a player's Pursuit still queued at the AI's U-turn switch (TryPursuit, battle_script.c:6898–6916)", () => {
  const [PURSUIT_SLOT, RAGE_SLOT] = [1, 2];
  let switchRead: AiBattleRead;
  beforeAll(() => {
    switchRead = showdownAiSource.read(uTurnSwitch([ID.ember, ID.pursuit, ID.rage, ID.tackle]));
    const { queuedPlayerMoves, mons: [{ moves, ppCur }] } = switchRead;
    expect([queuedPlayerMoves, moves, ppCur.every((pp) => pp > 0)]).toEqual([[ID.ember], [ID.ember, ID.pursuit, ID.rage, ID.tackle], true]);
  });
  type Change = (mon: AiReadMon) => void;
  const status = (value: number): Change => (mon) => { mon.status = value; };
  const noPp = (slot: number): Change => (mon) => { mon.ppCur[slot] = 0; };
  const encored = (encoredMove: number): Change => (mon) => { mon.effects.encoredMove = encoredMove; };
  const truant: Change = (mon) => { mon.ability = ABILITY.truant; };
  it.each<[string, Change[], boolean]>([
    ['refuses where every test passes', [], true],
    ['decides where the user is asleep (bs:6901–6902)', [status(3)], false], // MON_CONDITION_SLEEP's counter at 3
    ['decides where the user is frozen', [status(MON_CONDITION_FREEZE)], false],
    ['decides where the user fainted', [(mon) => { mon.curHP = 0; }], false],
    ['refuses a paralysed user: no TryPursuit test', [status(MON_CONDITION_PARALYSIS)], true],
    ['decides where the queued move\'s slot has no PP (bs:6913–6916)', [noPp(PURSUIT_SLOT)], false],
    ['refuses where the move is in no slot: the C reads past ppCur', [(mon) => { mon.moves[PURSUIT_SLOT] = ID.growl; }], true],
    ['refuses a Truant user: the read lacks moveEffectsData.truant (bs:6903)', [truant], true],
    ['decides a Truant user that fails another test', [truant, status(3)], false],
    // Under Encore (bs:6905–6910) TryPursuit takes the encored move in its slot; the read has no encoredMoveSlot.
    ['refuses a user encored into the Pursuit', [encored(ID.pursuit)], true],
    ['decides a user encored into the Pursuit with no PP', [encored(ID.pursuit), noPp(PURSUIT_SLOT)], false],
    ['refuses a user encored into Ember, in its slot or not', [encored(ID.ember)], true],
    ['decides a user encored into Ember whose Pursuit has no PP', [encored(ID.ember), noPp(PURSUIT_SLOT)], false],
    ['refuses a user encored into a move no longer among its moves', [encored(ID.waterBall)], true],
    ['decides that user whose Pursuit has no PP', [encored(ID.waterBall), noPp(PURSUIT_SLOT)], false],
    ['refuses a user encored into Rage, another Pursuit-effect move with PP', [encored(ID.rage), noPp(PURSUIT_SLOT)], true],
    ['decides a user encored into Rage with no PP either', [encored(ID.rage), noPp(PURSUIT_SLOT), noPp(RAGE_SLOT)], false],
  ])('%s', (_name, changes, refused) => {
    const read = structuredClone(switchRead) as AiBattleRead;
    read.queuedPlayerMoves = [ID.pursuit];
    for (const change of changes) change(read.mons[0]);
    const view = viewFromRead(read, 'enemyMidTurnSwitch', data, ai, memory({ switchAction: [ID.uTurn] }));
    expect([view.powerMul, view.unknown]).toEqual([10, refused ? ['powerMul', 'mons.1.curHP'] : []]);
  });
});
