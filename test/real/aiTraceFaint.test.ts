// Real-data regression: a trainer-AI error after a Trace Smeargle faints, from the native engine's
// stage-2 playouts over the Gardenia split. GalacticfTerra (ROM 435) leads with Smeargle (Trace, Focus Sash), which traces
// the player's ability at the battle start. When it faints, the AI's replacement was refused, AiError('UNDEFINED',
// 'unguarded unknown path mons.1.ability'): the memory listed the traced ability as a field the fainted BattleMon keeps
// (BattleSystem_CleanupFaintedMon, battle_lib.c:2156–2210) and Showdown's faint resets (clearVolatile). The Trace line
// names it (subscript_trace.s:6–7 copies the traced battler's ability into the tracer's BattleMon), so the memory keeps
// it (aiTraced) and the replacement is the post-KO pick with it, as stage 2 reads it (battle_lib.c:8054–8063).
//
// The battle is the differential corpus's case 435.0.0 (aiCorpus.ts: Smeargle against the sweep's Garchomp, Rough
// Skin), and the AI is called as the solver calls it (src/solver/arena.ts): `support` at each turn choice, the player's
// first legal choice against each action, `remember` of each outcome, and `replacementSupport` at the replacement.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { protocolIds, viewFromState } from '../../src/ai/adapter.js';
import type { AiMemoryData } from '../../src/ai/memory.js';
import type { AiMemory } from '../../src/contracts/ai.js';
import type { EngineState } from '../../src/contracts/engine.js';
import { createBattle, expandTurn, legalChoices, ONE, restore } from '../../src/engine/index.js';
import { loadCorpus } from './aiCorpus.js';
import { DATA_DIR, needFiles, PK_ROM } from './env.js';

const ROM_DIR = join(DATA_DIR, 'rom');
const suite = needFiles("a Trace Smeargle's faint: the AI's replacement (GalacticfTerra, ROM 435)", { PK_ROM }, [{
  name: 'ROM extract', dir: ROM_DIR,
  skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
    ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
}]);

/** The turns the search plays, and the outcomes of a step it follows (spread evenly), as the corpus bounds its own. */
const TURNS = 3;
const OUTCOMES_PER_STEP = 8;

describe.skipIf(suite.skip)(suite.title, () => {
  it('is the post-KO pick with the traced ability, never a refusal', () => {
    const corpus = loadCorpus(DATA_DIR);
    const { model, data, ai } = corpus;
    const c = corpus.cases.find((entry) => entry.id === '435.0.0');
    expect(c?.input.trainer.name).toBe('GalacticfTerra');
    const roughSkin = protocolIds().ability('Rough Skin');
    const root = createBattle(c!.input);
    const rootMemory = model.initialMemory(root);
    // Smeargle traced Garchomp's Rough Skin at the battle start.
    expect(restore(root).p2.active[0]!.ability).toBe('roughskin');

    let frontier: { state: EngineState; memory: AiMemory }[] = [{ state: root, memory: rootMemory }];
    let replacements = 0;
    for (let turn = 0; turn < TURNS && frontier.length > 0; turn++) {
      const next: typeof frontier = [];
      for (const { state, memory } of frontier) {
        const p1 = legalChoices(state, 'p1')[0]!;
        for (const action of model.support(state, memory)) {
          const outcomes = expandTurn(state, { p1, p2: action.choice }, { maxLeaves: 400 });
          const picked = outcomes.length <= OUTCOMES_PER_STEP ? outcomes.keys()
            : Array.from({ length: OUTCOMES_PER_STEP }, (_, i) => Math.floor((i * outcomes.length) / OUTCOMES_PER_STEP));
          for (const j of picked) {
            const outcome = outcomes[j]!;
            if (outcome.fainted.p1.length > 0 || outcome.unlabelled) continue;
            const after = model.remember(memory, outcome);
            if (outcome.state.phase.kind === 'enemyReplacement') {
              expect(outcome.log.some((line) => line.startsWith('|faint|p2a: Smeargle'))).toBe(true);
              const support = model.replacementSupport(outcome.state, after);
              expect(support).toHaveLength(1);
              expect([support[0]!.choice.kind, support[0]!.probability]).toEqual(['switch', ONE]);
              // Showdown's faint reset the ability; the cartridge's BattleMon keeps Rough Skin, which the view gives.
              expect(restore(outcome.state).p2.active[0]!.ability).toBe('trace');
              const v = viewFromState(outcome.state, data, ai, after.data as AiMemoryData);
              expect([v.mons[1]!.ability, v.unknown]).toEqual([roughSkin, []]);
              replacements++;
            } else if (outcome.state.phase.kind === 'turnChoice') {
              next.push({ state: outcome.state, memory: after });
            }
          }
        }
      }
      frontier = next.slice(0, 6);
    }
    // Focus Sash holds the first hit, so Smeargle faints from the second turn on.
    expect(replacements).toBeGreaterThan(0);
    // The memory holds the traced ability from the battle start, and nothing is listed for it.
    expect([(rootMemory.data as AiMemoryData).aiTraced, (rootMemory.data as AiMemoryData).aiKept]).toEqual([roughSkin, []]);
  }, 600_000);
});
