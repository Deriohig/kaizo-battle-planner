// Real-data check for src/engine/facts.ts: on real fights, every reader answers for each state the engine
// built what it answers for the same state rebuilt as a new object, which the cache misses (so the reader restores it).
// The player's eligible team from the frozen 12 June save against a handful of real trainers across splits, among them one
// with a bag and one with a field note, each walked three steps with every outcome of each step checked, and a level-up.
// And over the same walks, each outcome's first peek is its kept
// leaf's battle (no restore), which equals a restore of its state in everything `peek`'s read rule promises, and the
// real trainer AI answers from it what it answers from a restore.

import { readFileSync } from 'node:fs';
import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createTrainerAi } from '../../src/ai/model.js';
import { extractAiData } from '../../src/ai/rom/aiData.js';
import { buildCatalog } from '../../src/battle/catalog.js';
import { buildMoves } from '../../src/battle/moves.js';
import { eligibleTeam, type PlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData, ResolvedTrainer } from '../../src/battle/types.js';
import type { BattleInput, Outcome } from '../../src/contracts/engine.js';
import { loadDocs } from '../../src/data/load.js';
import { NoChanceDriver, peekConfig } from '../../src/engine/facts.js';
import { createBattle, installKaizoDex, levelUp, peek, restore } from '../../src/engine/index.js';
import { describeDifferences, peekDifferences } from '../../src/engine/peekCheck.js';
import { fieldSpec } from '../../src/integration/resolver.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { extractRomData } from '../../src/rom/extract.js';
import { DEFAULT_GRAVEYARD_BOXES, readSave } from '../../src/save/readSave.js';
import { cacheMismatches, emptyCorpus, walk } from '../unit/engine/walk.js';
import { needFiles, PK_ROM, PK_SAVE } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('The engine\'s cached readers on real fights', { PK_ROM, PK_SAVE }, [caches.docs]);

describe.skipIf(suite.skip)(suite.title, () => {
  let data: LoadedData;
  let romFile: Buffer;
  let inputs: BattleInput[];

  beforeAll(() => {
    const docs = loadDocs(caches.docs.dir);
    romFile = readFileSync(PK_ROM);
    const rom = extractRomData(romFile);
    data = { rom, names: buildNameIndex(docs), docs };
    installKaizoDex(data, buildMoves(data));
    const save = readSave(readFileSync(PK_SAVE), rom);
    const team: PlayerMon[] = eligibleTeam(save, data, { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: 100 }).slice(0, 3);
    const singles = buildCatalog(data).trainers.filter((trainer) => trainer.battleType === 'single');
    const hasBag = (trainer: ResolvedTrainer) => rom.trainers.find((entry) => entry.index === trainer.romIndex)?.items.some((item) => item !== 0) === true;
    const hasField = (trainer: ResolvedTrainer) => Object.keys(fieldSpec(trainer.field)).length > 0;
    const picked = new Set<ResolvedTrainer>([
      ...singles.slice(0, 2), singles[Math.floor(singles.length / 2)]!, singles[singles.length - 1]!,
      singles.find(hasBag)!, singles.find(hasField)!,
    ]);
    expect([...picked].some(hasBag) && [...picked].some(hasField)).toBe(true);
    inputs = [...picked].map((trainer) => ({ player: team, trainer: { ...trainer, variants: [] }, field: fieldSpec(trainer.field) }));
  }, 300_000);

  it('every reader answers the same with the cache as without, over three steps of real fights', () => {
    const corpus = emptyCorpus();
    for (const [i, input] of inputs.entries()) walk(corpus, input, 3, i + 1, 3_000);
    const root = corpus.states.find((state) => state.phase.kind === 'turnChoice')!;
    const levelled = levelUp(root, 0, 100);
    console.log(`engineFacts: ${inputs.length} trainers, ${corpus.states.length} states, phases ${[...corpus.phases].join(', ')}`);
    expect(corpus.states.length).toBeGreaterThan(20);
    expect(cacheMismatches([...corpus.states, levelled])).toEqual([]);
  }, 900_000);

  it('each outcome\'s first peek restores nothing, equals a restore, and gives the trainer AI a restore\'s answers', () => {
    const model = createTrainerAi(data, extractAiData(romFile));
    const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)) ?? 'undefined';
    const answer = (run: () => unknown): string => {
      try {
        return json(run());
      } catch (error) {
        return json({ threw: error instanceof Error ? error.message : String(error) });
      }
    };
    const found = { outcomes: 0, restored: [] as string[], differ: [] as string[], answers: 0, answerDiffers: [] as string[] };
    const fromJSON = vi.spyOn(PS.Battle, 'fromJSON');
    try {
      for (const [i, input] of inputs.entries()) {
        const start = model.initialMemory(createBattle(input));
        walk(emptyCorpus(), input, 3, i + 1, 3_000, (outcomes: readonly Outcome[]) => {
          for (const outcome of outcomes.slice(-peekConfig.seedLimit)) {
            const { state } = outcome;
            const where = `${state.key.slice(0, 10)} (turn ${state.turn}, ${state.phase.kind})`;
            found.outcomes += 1;
            fromJSON.mockClear();
            const verify = peekConfig.verify;
            peekConfig.verify = false;
            let battle: Battle;
            try {
              battle = peek(state);
            } finally {
              peekConfig.verify = verify;
            }
            if (fromJSON.mock.calls.length !== 0) found.restored.push(where);
            const differences = peekDifferences(battle, restore(state, new NoChanceDriver([])));
            if (differences.length > 0) found.differ.push(`${where}: ${describeDifferences(differences)}`);
            const copy = { ...state };
            const memory = model.remember(start, outcome);
            const pairs: [string, () => unknown, () => unknown][] = [
              ['remember', () => memory, () => model.remember(start, { ...outcome, state: copy })],
            ];
            if (state.phase.kind === 'turnChoice') pairs.push(['support', () => model.support(state, memory), () => model.support(copy, memory)]);
            if (state.phase.kind === 'enemyReplacement' || state.phase.kind === 'enemyMidTurnSwitch') {
              pairs.push(['replacementSupport', () => model.replacementSupport(state, memory), () => model.replacementSupport(copy, memory)]);
            }
            for (const [name, mine, theirs] of pairs) {
              found.answers += 1;
              const [a, b] = [answer(mine), answer(theirs)];
              if (a !== b && found.answerDiffers.length < 5) found.answerDiffers.push(`${where}, ${name}: ${a.slice(0, 300)} VS ${b.slice(0, 300)}`);
            }
          }
        });
      }
    } finally {
      fromJSON.mockRestore();
    }
    console.log(`engineFacts peek: ${found.outcomes} outcomes checked, ${found.answers} AI answers compared`);
    expect(found.outcomes).toBeGreaterThan(20);
    expect(found.restored).toEqual([]);
    expect(found.differ).toEqual([]);
    expect(found.answerDiffers).toEqual([]);
  }, 900_000);
});
