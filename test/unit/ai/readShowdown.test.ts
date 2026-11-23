// The Showdown engine's AiBattleSource (src/ai/read/showdown.ts): a read is the contract's plain data, kept in an LRU by
// state object and dex install, and its faults are thrown or registered as the view's one-pass build met them.
import { beforeAll, describe, expect, it } from 'vitest';
import { AiError } from '../../../src/ai/errors.js';
import { readTrainer, rethrowReadFault } from '../../../src/ai/read/compose.js';
import {
  createShowdownAiSource, CUT_CAPACITY, peekBattle, READ_CAPACITY, showdownAiSource, showdownRead,
} from '../../../src/ai/read/showdown.js';
import type { AiBattleRead } from '../../../src/contracts/aiRead.js';
import { PEEK_LIMIT } from '../../../src/engine/facts.js';
import {
  battleField, battleStartLog, battleTrainer, createBattle, expandTurn, legalChoices, restore,
} from '../../../src/engine/index.js';
import { ID } from '../engine/fixtures.js';
import { badView, battleInput, both, changed, changedFrom, FAULT, installDex, move, thrown, thrownBy } from './viewHarness.js';
import { FX } from './fixtures.js';

beforeAll(installDex);

const NO_NOTE = badView('the state has no field-note record: The state holds no field record (not made by createBattle)');
const keys = (value: object): string[] => Object.keys(value).sort();
const sorted = (words: string): string[] => words.split(' ').sort();

describe('showdownAiSource.read: the contract\'s plain data', () => {
  it('has exactly the contract\'s fields, and survives a JSON round trip unchanged', () => {
    const start = createBattle(battleInput());
    for (const state of [start, ...expandTurn(start, { p1: move(0), p2: move(0) }).map((outcome) => outcome.state)]) {
      const read = showdownAiSource.read(state);
      expect(keys(read)).toEqual(sorted('battleType totalTurns mons parties fieldConditionsMask sideConditionsMask sideConditions '
        + 'monSpeedValues quickClawRolls bag queuedPlayerMoves request trainer fieldNote'));
      for (const mon of read.mons) {
        expect(keys(mon)).toEqual(sorted('partyIndex species form level gender types ability heldItem friendship ivs curHP maxHP attack '
          + 'defense spAttack spDefense speed statBoosts moves ppCur ppMax status statusVolatile moveEffectsMask effects roosting helpingHand '
          + 'transformed weightSpecies weightForm moveProtect protectChainKnown lastItem'));
        expect(keys(mon.effects)).toEqual(sorted('disabledMove disabledTurns encoredMove encoredTurns tauntedTurns embargoTurns perishSongTurns '
          + 'stockpileCount protectSuccessTurns fakeOutTurnNumber slowStartTurnNumber lastResortCount flashFire canUnburden healBlockTurns '
          + 'magnetRiseTurns choiceLockedMove'));
        expect(keys(mon.ivs)).toEqual(sorted('hp atk def spa spd spe'));
      }
      for (const member of read.parties.flat()) expect(keys(member)).toEqual(sorted('species form level hp maxHp status moves pp ppMax heldItem ability ivs'));
      expect(JSON.parse(JSON.stringify(read))).toStrictEqual(read);
    }
  });

  it('reads the battle: the battlers, the parties, the bag, the request, the trainer and the note', () => {
    const state = createBattle({ ...battleInput(), field: { weather: 'rain' } });
    const read = showdownAiSource.read(state);
    const battle = peekBattle(state);
    expect(read).toMatchObject({
      battleType: 1, totalTurns: 0, queuedPlayerMoves: [], quickClawRolls: [null, null], bag: [...battle.formatData['kaizoTrainerBag'].items],
      request: { slotIds: ['tackle', 'growl'], entries: [{ id: 'tackle' }, { id: 'growl' }] }, trainer: battleTrainer(state), fieldNote: battleField(state),
    });
    expect(read.mons.map((mon) => [mon.partyIndex, mon.species, mon.level, mon.curHP, mon.heldItem])).toEqual([
      [0, ID.monferno, 30, battle.p1.active[0]!.hp, FX.item.LEFTOVERS], [0, ID.zigzagoon, 20, battle.p2.active[0]!.hp, FX.item.SITRUS_BERRY],
    ]);
    expect(read.parties.map((party) => party.map((member) => member.species))).toEqual([[ID.monferno], [ID.zigzagoon, ID.bidoof]]);
    expect(showdownAiSource.legalChoices(state)).toEqual(legalChoices(state, 'p2'));
    expect(showdownAiSource.startLog(state)).toEqual(battleStartLog(state));
  });

  it('has no request where the battle does not wait on the trainer\'s turn choice', () => {
    const fainting = changed((battle) => { battle.p2.active[0]!.hp = 1; });
    const replacements = expandTurn(fainting, { p1: move(0), p2: move(0) }).filter((outcome) => outcome.state.phase.kind === 'enemyReplacement');
    expect(replacements.length).toBeGreaterThan(0);
    for (const { state } of replacements) expect(showdownAiSource.read(state)).toMatchObject({ request: null, mons: [{}, { curHP: 0 }] });
  });
});

describe('showdownAiSource.read: the cache', () => {
  it('keeps one read per state object, outlives the engine\'s eviction of the peek, and reads again under another dex install', () => {
    const state = createBattle(battleInput());
    const first = showdownAiSource.read(state);
    expect(showdownAiSource.read(state)).toBe(first);
    const twin = showdownAiSource.read({ ...state }); // another object of the state: its own read, equal
    expect([twin === first, twin]).toStrictEqual([false, first]);
    // The engine evicts the state's peek once PEEK_LIMIT other states were peeked since; the read stays.
    const peeked = peekBattle(state);
    for (let i = 0; i < PEEK_LIMIT; i++) peekBattle({ ...state });
    expect(peekBattle(state)).not.toBe(peeked);
    expect(showdownAiSource.read(state)).toBe(first);
    installDex();
    const reinstalled = showdownAiSource.read(state);
    expect([reinstalled === first, reinstalled]).toStrictEqual([false, first]);
    expect(showdownAiSource.read(state)).toBe(reinstalled);
  });

  it('keeps the READ_CAPACITY reads read last, a failed one alike: a hit makes a read the latest, an older one is built again', () => {
    // Every state the AI cuts it also peeks, so it keeps as many JSON cuts as the engine keeps peeks.
    expect([READ_CAPACITY, CUT_CAPACITY]).toEqual([1024, PEEK_LIMIT]);
    const source = createShowdownAiSource(4);
    const state = createBattle(battleInput());
    const others = (n: number): void => {
      for (let i = 0; i < n; i++) source.read({ ...state });
    };
    const first = source.read(state);
    others(3);
    expect(source.read(state)).toBe(first); // among the last 4 read, and now the latest again
    others(3);
    expect(source.read(state)).toBe(first);
    others(4);
    const again = source.read(state);
    expect([again === first, again]).toStrictEqual([false, first]);
    const bad = changedFrom(state, FAULT.noNote);
    const failed = thrownBy(() => source.read(bad));
    expect(failed).toBeInstanceOf(AiError);
    others(3);
    expect(thrownBy(() => source.read(bad))).toBe(failed);
    others(4);
    const rebuilt = thrownBy(() => source.read(bad));
    expect([rebuilt === failed, rebuilt]).toEqual([false, failed]);
  });
});

describe('showdownAiSource.read: its faults', () => {
  it.each<[string, (battle: Battle) => void, string]>([
    ['an unknown ability', FAULT.playerAbility, badView('Showdown ability "nonsense" has no ROM ID')],
    ['an unknown item', FAULT.playerItem, badView('Showdown item "nonsense" has no ROM ID')],
    ['an unknown type', FAULT.playerTypes, badView('Showdown type "Nonsense" has no ROM ID')],
    ['no field note', FAULT.noNote, NO_NOTE],
    ['no trainer bag', FAULT.noBag, 'Error: This battle has no trainer bag: createBattle gives a battle one'],
  ])('throws a fault the view met before its first ROM read, in the player\'s battler up to its held item: %s', (_name, change, error) => {
    const state = changed(change);
    expect([thrown(() => showdownAiSource.read(state)), thrown(() => showdownRead(peekBattle(state), state))]).toEqual([error, error]);
    // The kept read throws the same error object each time.
    const first = thrownBy(() => showdownAiSource.read(state));
    expect(thrownBy(() => showdownAiSource.read(state))).toBe(first);
  });

  it('registers each later fault beside the read, under its field, and holds a placeholder in the field', () => {
    const { playerStatus, playerLastItem, enemyAbility, benchStatus, weather, noTrainer } = FAULT;
    const read = showdownAiSource.read(changed(both(playerStatus, playerLastItem, enemyAbility, benchStatus, weather, noTrainer)));
    const NO_TRAINER = 'Error: The state holds no trainer identity (not made by createBattle)';
    const faults: [Parameters<typeof rethrowReadFault>[1], string][] = [
      ['mons.0.status', badView('Showdown status "xyz" has no cartridge encoding')], ['mons.0.lastItem', badView('Showdown item "nonsense" has no ROM ID')],
      ['mons.1.ability', badView('Showdown ability "nonsense" has no ROM ID')],
      // The player's active Pokémon is its party member 0, whose party status is the same fault.
      ['parties.0.0.fields', badView('Showdown status "xyz" has no cartridge encoding')],
      ['parties.1.1.fields', badView('Showdown status "abc" has no cartridge encoding')],
      ['fieldConditionsMask', badView('Showdown weather "desolateland" has no Gen 4 encoding')], ['trainer', NO_TRAINER],
      ...(['mons.0.ability', 'mons.1.status', 'mons.1.lastItem', 'parties.1.0.fields', 'protectChainKnown'] as const).map((key): [typeof key, string] => [key, 'no throw']),
    ];
    expect(faults.map(([key]) => thrown(() => rethrowReadFault(read, key)))).toEqual(faults.map(([, error]) => error));
    // The placeholders, which no consumer may read; readTrainer gives the fault, never the placeholder.
    expect([read.mons[0].status, read.mons[0].lastItem, read.mons[1].ability, read.fieldConditionsMask, read.trainer]).toEqual([0, 0, 0, 0, { romIndex: 0, aiMask: 0 }]);
    expect(thrown(() => readTrainer(read))).toBe(NO_TRAINER);
    // A read with no fault registers none, and readTrainer gives the state's trainer.
    const start = createBattle(battleInput());
    const clean = showdownAiSource.read(start);
    expect(faults.map(([key]) => thrown(() => rethrowReadFault(clean, key))).every((error) => error === 'no throw')).toBe(true);
    expect(readTrainer(clean)).toEqual(battleTrainer(start));
  });

  it('registers a request it cannot read, which no view reads, instead of throwing it from every read', () => {
    // A request the engine never makes (`activeRequest` isn't in the state's JSON, so the battle is changed by hand).
    const state = createBattle(battleInput());
    const battle = restore(state);
    (battle.p2 as { activeRequest: unknown }).activeRequest = { active: [{ moves: 5 }] };
    let read: AiBattleRead | null = null;
    expect(thrown(() => { read = showdownRead(battle, state); })).toBe('no throw');
    expect(read!.request).toBeNull(); // the placeholder
    expect(thrown(() => rethrowReadFault(read!, 'request'))).toBe('TypeError: moves.map is not a function');
    expect(thrown(() => rethrowReadFault(showdownAiSource.read(state), 'request'))).toBe('no throw');
  });
});
