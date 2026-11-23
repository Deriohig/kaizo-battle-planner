import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import type { Choice, FieldSpec } from '../../../src/contracts/engine.js';
import * as engineIndex from '../../../src/engine/index.js';
import { carryOut, createBattle, legalChoices, restore, runFirstOutcome } from '../../../src/engine/battle.js';
import { abilityId, itemId, speciesId } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { bagItemId, installKaizoDex, showdownEngine, unmodelledIn } from '../../../src/engine/index.js';
import { observe } from '../../../src/engine/observe.js';
import { trainerBag, UNDEFINED_CATEGORY_NOTE } from '../../../src/engine/trainerItems.js';
import { ENGINE_REVISION, SHOWDOWN_VERSION } from '../../../src/engine/version.js';
import { BAG, emberTurn, fixtureDex, ID, ITEM, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
/** Monferno (Tackle, Water Ball: plain hits) against Zigzagoon (Tackle), with `bag`, `field` and held items. */
const plainHits = (bag: number = BAG.none, field: FieldSpec = {}, items: [number, number] = [0, 0]) => createBattle({
  player: [playerMon(ID.monferno, 30, [ID.tackle, ID.waterBall], { item: items[0] })],
  trainer: resolvedTrainer(bag, [resolvedMon(ID.zigzagoon, 20, [ID.tackle], { item: items[1] })]), field,
});
/** `run` under a fixture install changed by `change`. */
const underChanged = <T>(change: (other: ReturnType<typeof fixtureDex>) => void, run: () => T): T => {
  const other = fixtureDex();
  change(other);
  installKaizoDex(other.data, other.moves);
  try {
    return run();
  } finally {
    installKaizoDex(fixture.data, fixture.moves);
  }
};

describe('the Engine object', () => {
  it('id names Showdown, the engine revision and the installed data, and changes with the data and the move data unmodelledIn reads', () => {
    const { version } = JSON.parse(readFileSync('node_modules/pokemon-showdown/package.json', 'utf8')) as { version: string };
    expect(SHOWDOWN_VERSION).toBe(version);
    const id = showdownEngine.id;
    expect(id).toMatch(new RegExp(`^showdown@${SHOWDOWN_VERSION.replaceAll('.', '\\.')}\\+platkaizo@${ENGINE_REVISION}-[0-9a-f]{12}$`));
    const changes: ((other: ReturnType<typeof fixtureDex>) => void)[] = [
      (other) => { other.data.rom.species[ID.zigzagoon]!.baseStats.hp += 1; },
      ...[(m: KaizoMove) => { m.unmodelled = 'Changed'; }, (m: KaizoMove) => { m.effectText = 'Changed'; }].map((edit) => (other: ReturnType<typeof fixtureDex>) => edit(other.moves.get(ID.tackle)!)),
    ];
    for (const change of changes) expect(underChanged(change, () => showdownEngine.id)).not.toBe(id);
    expect(showdownEngine.id).toBe(id);
  });

  it('the public index: no first-outcome step; the id helpers, trainer bag and bag item names the trainer-AI adapter reads; no retired notes', () => {
    const keys = Object.keys(engineIndex);
    expect(['runStep', 'runFirstOutcome', 'INTERIM_BEHAVIOURS_NOTE', 'UNAPPLIED_FIELD_NOTE', 'pinchItemNote'].filter((key) => keys.includes(key))).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(['expandTurn', 'BAG_ITEM_NAMES']));
    expect([engineIndex.abilityId, engineIndex.itemId, engineIndex.speciesId, engineIndex.trainerBag]).toEqual([abilityId, itemId, speciesId, trainerBag]);
    expect([engineIndex.BAG_ITEM_NAMES[23], engineIndex.BAG_ITEM_NAMES[62], engineIndex.BAG_ITEM_NAMES[4]]).toEqual(['Full Restore', 'X Sp. Def', undefined]); // Poké Ball: Showdown's
    for (const [id, name] of Object.entries(engineIndex.BAG_ITEM_NAMES)) expect(bagItemId(Number(id))).toBe(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  });

  it('observe is the root view; the other members are the engine\'s functions', () => {
    const state = createBattle(emberTurn());
    expect(showdownEngine.observe(state)).toBe(observe(restore(state), []));
    expect(JSON.parse(showdownEngine.observe(state)).events).toEqual([]);
    expect([showdownEngine.createBattle, showdownEngine.legalChoices, showdownEngine.expandTurn, showdownEngine.carryOut]).toEqual([createBattle, legalChoices, expandTurn, carryOut]);
    expect(showdownEngine.legalChoices(state, 'p1')).toEqual([move(0), move(1)]);
  });

  it('unmodelledIn names the moves whose engine effect is unmodelled, each once, then the battle\'s notes', () => {
    expect([unmodelledIn(plainHits()), showdownEngine.unmodelledIn(plainHits()), unmodelledIn(createBattle(emberTurn()))]).toEqual([[], [], []]);
    // The table families: a burn chance, a plain hit, a stat drop, a sleep move, a flinch chance.
    expect(unmodelledIn(createBattle({
      player: [playerMon(ID.monferno, 30, [ID.ember, ID.tackle, ID.leer, ID.yawn])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.growl, ID.bite])]), field: {},
    }))).toEqual([]);
    // Beat Up is unmodelled, named by move, reason and text; Mean Look and Guillotine are modelled.
    const beatUp = engineIndex.engineEffect(fixture.moves.get(ID.beatUp)!) as { kind: string; reason: string };
    expect(beatUp.kind).toBe('unmodelled');
    expect(unmodelledIn(createBattle({
      player: [playerMon(ID.monferno, 30, [ID.beatUp, ID.guillotine, ID.ember])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.beatUp, ID.meanLook])]), field: {},
    }))).toEqual([`Beat Up: ${beatUp.reason} ("Beat Up effect")`]);
    expect(unmodelledIn(createBattle(emberTurn([ID.doubleEdge])))).toEqual(['Double-Edge: no engine entry for its effect text ("Recoil")']);
    // A modelled move whose damage the calc can't reproduce is not reported: the engine is the model of record.
    expect(underChanged((other) => { other.moves.get(ID.tackle)!.unmodelled = 'Changed'; }, () => unmodelledIn(plainHits()))).toEqual([]);
    const undefinedItem = runFirstOutcome(plainHits(BAG.potions), { p1: move(0), p2: { kind: 'item', item: 'potion', consumeSlots: [0], effect: { category: 'undefined' } } });
    expect(unmodelledIn(undefinedItem)).toEqual([UNDEFINED_CATEGORY_NOTE]);
  });

  it('unmodelledIn reports no field note (weather, fog, Trick Room and Gravity are applied) and no held pinch item', () => {
    for (const field of [{ fog: false, trickRoom: false, gravity: false }, { weather: 'sand' }, { gravity: true }] as FieldSpec[]) expect(unmodelledIn(plainHits(BAG.none, field))).toEqual([]);
    expect(unmodelledIn(expandTurn(plainHits(BAG.none, { gravity: true }), { p1: move(0), p2: move(0) })[0]!.state)).toEqual([]);
    for (const items of [[ITEM.leftovers, ITEM.quickClaw], [ITEM.ganlonBerry, ITEM.apicotBerry], [ITEM.shoalSalt, 0]] as [number, number][]) expect(unmodelledIn(plainHits(BAG.none, {}, items))).toEqual([]);
  });
});
