// Real-data check: EXP paid mid-fight, and a level-up it brings,
// in fights from the player's current save (pk-run-2026-11-11.dsv, beside PK_SAVE, as saveOwnership.test.ts finds it) against
// ROM trainer 16 (Camper Jacob: Seedot 21, Seel 21, Ponyta 21, Nidorino 22). Every expected number is a literal from the
// cartridge's arithmetic, never the engine's helper: a knock-out pays floor(base × level / 7), ×150/100 for
// the trainer battle, ×150/100 again for a traded Pokémon; the hack's base EXP of the four is 74, 100, 152, 118. The new
// stats are the formula's (`computeStats`, src/rom/stats.ts: `Pokemon_CalcStats`, pokeplatinum src/pokemon.c:564-648).
// A two-fight gauntlet too: the level gained in fight 1 is carried into fight 2 (`carryOut`'s `exp` and
// `moves`; medium slow: level 22 at 7577, 23 at 8825, 24 at 10208).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { buildCatalog } from '../../src/battle/catalog.js';
import { buildMoves } from '../../src/battle/moves.js';
import { type PlayerMon, toPlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData } from '../../src/battle/types.js';
import type { CarryState, Choice, EngineState, Outcome } from '../../src/contracts/engine.js';
import { loadDocs } from '../../src/data/load.js';
import { EXP_KEY } from '../../src/engine/exp.js';
import { carryOut, createBattle, expandTurn, installKaizoDex, legalChoices, restore, snapshot } from '../../src/engine/index.js';
import { cmp } from '../../src/engine/rational.js';
import { fieldSpec } from '../../src/integration/resolver.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { extractRomData } from '../../src/rom/extract.js';
import { computeStats } from '../../src/rom/stats.js';
import { readSave } from '../../src/save/readSave.js';
import { needFiles, PK_ROM, PK_SAVE } from './env.js';

const caches = inject('realCaches');

/** The player's current run: `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE` (saveOwnership.test.ts). */
const PK_SAVE_CURRENT = process.env.PK_SAVE_CURRENT || join(dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');

const suite = needFiles("EXP and a level-up mid-fight, the player's current save against ROM trainer 16", { PK_ROM, PK_SAVE_CURRENT }, [caches.docs]);

/** What one knock-out showed: the step's EXP lines, and the Pokémon's EXP, level, HP, max HP and stats after it. */
interface Knockout { lines: string[]; exp: number; level: number; hp: number; maxhp: number; stats: Record<string, number> }

describe.skipIf(suite.skip)(suite.title, () => {
  // Read in `beforeAll`, not the describe body: vitest runs a skipped suite's body to collect it (see boxOrigin.test.ts).
  let rom: ReturnType<typeof extractRomData>;
  let data: LoadedData;
  let party: PlayerMon[];
  let trainer: ReturnType<typeof buildCatalog>['trainers'][number];
  beforeAll(() => {
    const docs = loadDocs(caches.docs.dir);
    rom = extractRomData(readFileSync(PK_ROM));
    data = { rom, names: buildNameIndex(docs), docs };
    installKaizoDex(data, buildMoves(data));
    const save = readSave(readFileSync(PK_SAVE_CURRENT), rom);
    party = save.party.map((m) => toPlayerMon(m, data, save.trainer));
    trainer = buildCatalog(data).trainers.find((candidate) => candidate.romIndex === 16)!;
  });

  /**
   * `mon` alone against trainer 16, each turn its highest-power move against the trainer's first legal choice, down the
   * most probable outcome; the trainer replaces in party order. With `oneHp`, each enemy is put at 1 HP at every turn
   * choice (the one synthetic change), so `mon` knocks out each with one hit. With `carry`, the fight is a gauntlet's
   * next one. Returns each knock-out's record, and the state the fight ended in.
   */
  function fight(mon: PlayerMon, oneHp: boolean, carry?: CarryState): { knockouts: Knockout[]; end: EngineState } {
    installKaizoDex(data, buildMoves(data));
    let state: EngineState = start(mon, carry);
    const power = mon.moves.map((id) => rom.moves[id]!.power);
    const knockouts: Knockout[] = [];
    let next = 1;
    for (let turn = 0; turn < 40 && state.phase.kind !== 'terminal'; turn++) {
      const choices: { p1?: Choice; p2?: Choice } = {};
      if (state.phase.kind === 'turnChoice') {
        if (oneHp) {
          const live = restore(state);
          live.p2.active[0]!.hp = 1;
          state = snapshot(live);
        }
        const moves = legalChoices(state, 'p1').filter((choice): choice is Extract<Choice, { kind: 'move' }> => choice.kind === 'move');
        choices.p1 = moves.reduce((best, choice) => (power[choice.slot]! > power[best.slot]! ? choice : best));
        choices.p2 = legalChoices(state, 'p2')[0]!;
      } else if (state.phase.kind === 'enemyReplacement') {
        choices.p2 = { kind: 'switch', index: next++ };
      } else {
        throw new Error(`${mon.nickname} stopped at ${state.phase.kind}`);
      }
      const outcome = expandTurn(state, choices).reduce((best: Outcome, other) => (cmp(other.probability, best.probability) > 0 ? other : best));
      state = outcome.state;
      if (!outcome.log.some((line) => line.startsWith('|faint|p2a: '))) continue;
      const pokemon = restore(state).p1.pokemon[0]!;
      knockouts.push({
        lines: outcome.log.filter((line) => line.startsWith('|-kaizo')), exp: (pokemon.m as Record<string, number>)[EXP_KEY]!,
        level: pokemon.level, hp: pokemon.hp, maxhp: pokemon.maxhp, stats: { ...pokemon.storedStats },
      });
    }
    return { knockouts, end: state };
  }

  /** The start of `mon`'s fight against trainer 16, from `carry` when given. */
  const start = (mon: PlayerMon, carry?: CarryState): EngineState =>
    createBattle({ player: [mon], trainer: { ...trainer, variants: [] }, field: fieldSpec(trainer.field), ...(carry === undefined ? {} : { carry }) });

  const formula = (mon: PlayerMon, level: number) => computeStats(mon.baseStats, mon.ivs, mon.evs, level, mon.nature.value ?? 0);
  const fiveStats = (stats: ReturnType<typeof computeStats>) => ({ atk: stats.atk, def: stats.def, spa: stats.spa, spd: stats.spd, spe: stats.spe });

  it('Prinplup, own, level 21 at 6458 EXP, knocks out all four (each at 1 HP): 6791, 7241, 7925 at level 22 on the third, 8480', () => {
    const prinplup = party.find((mon) => mon.species === 394)!;
    expect([prinplup.level, prinplup.exp, prinplup.origin]).toEqual([21, 6458, 'own']);
    const [seedot, seel, ponyta, nidorino] = fight(prinplup, true).knockouts;
    const name = prinplup.nickname;
    // Seedot 74 × 21 / 7 = 222 → 333; Seel 300 → 450; Ponyta 456 → 684; Nidorino 118 × 22 / 7 = 370 → 555.
    // Medium slow: level 22 at 7577, 23 at 8825.
    expect(seedot!.lines).toEqual([`|-kaizoexp|p1a: ${name}|333`]);
    expect(seel!.lines).toEqual([`|-kaizoexp|p1a: ${name}|450`]);
    expect(ponyta!.lines).toEqual([`|-kaizoexp|p1a: ${name}|684`, `|-kaizolevel|p1a: ${name}|22`]);
    expect(nidorino!.lines).toEqual([`|-kaizoexp|p1a: ${name}|555`]);
    expect([seedot, seel, ponyta, nidorino].map((knockout) => [knockout!.exp, knockout!.level])).toEqual([[6791, 21], [7241, 21], [7925, 22], [8480, 22]]);
    // At level 22: the formula's stats, max HP up by maxHp(22) − maxHp(21), and the HP before the knock-out up by the same.
    const [at21, at22] = [formula(prinplup, 21), formula(prinplup, 22)];
    expect(ponyta!.maxhp).toBe(at22.hp);
    expect(ponyta!.stats).toEqual(fiveStats(at22));
    expect(seel!.maxhp).toBe(at21.hp);
    expect(seel!.stats).toEqual(fiveStats(at21));
  }, 300_000);

  it('Chestnut, traded (Hilary\'s), level 19 at 6859 EXP: 7358 "[boosted]", then 8033 with level 20 on the second knock-out', () => {
    const chestnut = party.find((mon) => mon.nickname === 'Chestnut')!;
    expect([chestnut.level, chestnut.exp, chestnut.origin]).toEqual([19, 6859, 'traded']);
    const [seedot, seel] = fight(chestnut, false).knockouts;
    // Seedot 222 → 333 → 499; Seel 300 → 450 → 675. Medium fast: level 20 at 8000.
    expect(seedot!.lines).toEqual(['|-kaizoexp|p1a: Chestnut|499|[boosted]']);
    expect(seel!.lines).toEqual(['|-kaizoexp|p1a: Chestnut|675|[boosted]', '|-kaizolevel|p1a: Chestnut|20']);
    expect([seedot!.exp, seedot!.level, seel!.exp, seel!.level]).toEqual([7358, 19, 8033, 20]);
    const [at19, at20] = [formula(chestnut, 19), formula(chestnut, 20)];
    expect([seedot!.maxhp, seel!.maxhp]).toEqual([at19.hp, at20.hp]);
    expect(seedot!.stats).toEqual(fiveStats(at19));
    expect(seel!.stats).toEqual(fiveStats(at20));
  }, 300_000);

  it('a two-fight gauntlet: Prinplup ends fight 1 at level 22 with 8480 EXP; fight 2 starts it there, and its EXP goes on from 8480', () => {
    const prinplup = party.find((mon) => mon.species === 394)!;
    expect([prinplup.level, prinplup.exp, prinplup.moves]).toEqual([21, 6458, [232, 332, 377, 62]]);
    const first = fight(prinplup, true);
    expect(first.end.phase.kind).toBe('terminal');
    const carry = carryOut(first.end);
    const ended = restore(first.end).p1.pokemon[0]!;
    // Four moves known, and nothing to learn at 22 (its learnset: 332 at 21, 363 at 24), so the list is the save's.
    expect(carry.mons[0]).toMatchObject({ hp: ended.hp, exp: 8480, moves: [232, 332, 377, 62] });
    expect(carry.mons[0]!.pp).toEqual(ended.baseMoveSlots.map((slot) => slot.pp));

    // Fight 2 as carried: level 22, the formula's stats and max HP at 22, the EXP, and the HP and PP fight 1 ended with.
    const at22 = formula(prinplup, 22);
    const next = restore(start(prinplup, carry)).p1.pokemon[0]!;
    expect([next.level, next.maxhp, next.hp, (next.m as Record<string, number>)[EXP_KEY]]).toEqual([22, at22.hp, ended.hp, 8480]);
    expect(next.storedStats).toEqual(fiveStats(at22));
    expect(next.baseMoveSlots.map((slot) => [slot.id, slot.pp, slot.maxpp])).toEqual(ended.baseMoveSlots.map((slot) => [slot.id, slot.pp, slot.maxpp]));

    // Healed between the fights, written as "above max": full HP at 22. Then each enemy at 1 HP again: Seedot 333 → 8813
    // (23 is at 8825), Seel 450 → 9263, level 23; Ponyta 684 → 9947; Nidorino 555 → 10502, level 24 (at 10208).
    const healed: CarryState = { mons: carry.mons.map((mon) => ({ ...mon, hp: 999, pp: mon.pp.map(() => 99), status: { kind: 'none' } })) };
    expect(restore(start(prinplup, healed)).p1.pokemon[0]!.hp).toBe(at22.hp);
    const second = fight(prinplup, true, healed).knockouts;
    const name = prinplup.nickname;
    expect(second[0]!.lines).toEqual([`|-kaizoexp|p1a: ${name}|333`]);
    expect(second[1]!.lines).toEqual([`|-kaizoexp|p1a: ${name}|450`, `|-kaizolevel|p1a: ${name}|23`]);
    expect(second.map((knockout) => [knockout.exp, knockout.level])).toEqual([[8813, 22], [9263, 23], [9947, 23], [10502, 24]]);
    expect([second[0]!.maxhp, second[1]!.maxhp]).toEqual([at22.hp, formula(prinplup, 23).hp]);
    expect(second[1]!.stats).toEqual(fiveStats(formula(prinplup, 23)));
  }, 300_000);
});
