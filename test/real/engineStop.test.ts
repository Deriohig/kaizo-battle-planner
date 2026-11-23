// The real-engine twin of the toy test in
// test/unit/solver/stop.test.ts. The step that ran 239 s on a 30 s budget was Lass Caroline's Grotle using Bullet Seed:
// a multi-hit move, whose hit count, per-hit rolls and crits take one turn to thousands of leaves (up to the engine's
// 20,000). Through the contract's shouldStop, a stop that turns true 100 ms into that step must end it with
// STOPPED within 300 ms.
//
// Waiting on the engine: the poll is the engine's half (src/engine/expand.ts polls shouldStop on entry
// and before every leaf), which an engine without it lacks. Until then the test skips itself:
// it first asks for a step with shouldStop already true and maxLeaves 1, which an engine that polls on entry refuses at
// once with STOPPED, and an engine without the poll answers or throws LIMIT after its first leaves (cheap either way).
// Once the engine's poll is merged it runs with no change here.
//
// Battle: the player's party from the frozen save of the 2026-11-11 baseline bench (PK_STOP_SAVE) against Lass Caroline with
// her Grotle sent out first, the player's first legal choice against Bullet Seed.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Choice, EngineState } from '../../src/contracts/engine.js';
import { showdownEngine } from '../../src/engine/index.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { buildBox } from '../../src/server/box.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import { DATA_DIR, needFiles } from './env.js';

const DATA = path.resolve(DATA_DIR);
const SAVE = path.resolve(process.env.PK_STOP_SAVE || 'data/saves/pk-run-2026-11-11.dsv');
const suite = needFiles("an engine step a stop can interrupt (Lass Caroline's Grotle, Bullet Seed)", {
  PK_STOP_SAVE: SAVE, ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'),
});

/** National dex number of Grotle and the move ID of Bullet Seed. */
const GROTLE = 388;
const BULLET_SEED = 331;

function codeOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
}

/** The battle and the step: Grotle out first, Bullet Seed against the player's first legal choice. */
function bulletSeedStep(): { state: EngineState; choices: { p1: Choice; p2: Choice } } {
  const base = loadBaseDeps(DATA);
  const box = buildBox({ file: new Uint8Array(readFileSync(SAVE)), savePath: SAVE, savedAt: new Date(), data: base.data, settings: DEFAULT_SETTINGS });
  const party = [...box.byRef.entries()].filter(([ref, mon]) => ref.startsWith('party:') && mon.currentHp > 0);
  const player = party.sort(([a], [b]) => Number(a.slice('party:'.length)) - Number(b.slice('party:'.length))).map(([, mon]) => mon);
  const caroline = base.catalog.trainers.find((t) => t.name === 'Lass Caroline' && t.party.some((m) => m.species === GROTLE && m.moves.includes(BULLET_SEED)));
  if (caroline === undefined) throw new Error('no Lass Caroline with a Grotle that knows Bullet Seed in the catalog');
  const grotle = caroline.party.find((m) => m.species === GROTLE)!;
  const trainer = { ...caroline, party: [grotle, ...caroline.party.filter((m) => m !== grotle)], variants: [] };
  const state = showdownEngine.createBattle({ player, trainer, field: {} });
  const p2: Choice = { kind: 'move', slot: grotle.moves.indexOf(BULLET_SEED) };
  const legal = showdownEngine.legalChoices(state, 'p2');
  if (!legal.some((c) => c.kind === 'move' && c.slot === p2.slot)) throw new Error(`Bullet Seed (slot ${p2.slot}) is not a legal choice for Grotle`);
  return { state, choices: { p1: showdownEngine.legalChoices(state, 'p1')[0]!, p2 } };
}

/** Whether the engine polls shouldStop on entry (see the top of the file). */
function engineHasPoll(step: ReturnType<typeof bulletSeedStep>): boolean {
  try {
    showdownEngine.expandTurn(step.state, step.choices, { maxLeaves: 1, shouldStop: () => true });
  } catch (e) {
    return codeOf(e) === 'STOPPED';
  }
  return false;
}

describe.skipIf(suite.skip)(suite.title, () => {
  it('a stop true 100 ms into the step ends it with STOPPED within 300 ms', (ctx) => {
    const step = bulletSeedStep();
    if (!engineHasPoll(step)) ctx.skip("the engine does not poll shouldStop yet (the poll is not merged)");
    const began = performance.now();
    const shouldStop = (): boolean => performance.now() - began > 100;
    let thrown: unknown = null;
    try {
      showdownEngine.expandTurn(step.state, step.choices, { shouldStop });
    } catch (e) {
      thrown = e;
    }
    const wall = performance.now() - began;
    expect(codeOf(thrown), 'the step must still be running at 100 ms: a shorter one proves nothing').toBe('STOPPED');
    expect(wall).toBeLessThan(300);
  });
});
