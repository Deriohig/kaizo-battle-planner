// The data the solver's and the line builder's deps are built over (`BaseDeps`): the loaded data, its catalog and moves,
// installed in this thread's dex, and the trainer AI over `<dataDir>/rom`. deps.ts re-exports it for the solver's half.
// An extract can rewrite the data folder at any time, so every read of it here is checked against the fingerprint of the
// data the server loaded (fingerprint.ts): a thread never builds on other bytes than the server's.

import path from 'node:path';
import { createTrainerAi } from '../ai/index.js';
import { loadAiData } from '../ai/rom/aiData.js';
import { buildCatalog } from '../battle/catalog.js';
import { buildMoves, type KaizoMove } from '../battle/moves.js';
import type { TrainerCatalog } from '../battle/types.js';
import type { EnemyModel } from '../contracts/ai.js';
import { type LocalData, loadLocalData } from '../data/load.js';
import { installKaizoDex } from '../engine/index.js';
import { readStable } from './fingerprint.js';

/** The data a solve's deps are built over: the loaded data, its catalog and moves (installed in this thread's dex), and the trainer AI. */
export interface BaseDeps { data: LocalData; catalog: TrainerCatalog; moves: ReadonlyMap<number, KaizoMove>; enemyModel: EnemyModel }

const models = new WeakMap<LocalData, EnemyModel>();

/**
 * `data`'s deps base, as the server loaded it: its dex installed in this thread (a no-op when it already is) and the
 * trainer AI over `<dataDir>/rom` (made once per data). With the data's `fingerprint` (the server's data always has
 * one), the AI's file is read in a `readStable` against it: a folder whose bytes changed since the server loaded it
 * throws DataChangedError, and no model is kept.
 */
export function baseDeps(
  data: { local: LocalData; catalog: TrainerCatalog; moves: ReadonlyMap<number, KaizoMove>; fingerprint?: string }, dataDir: string,
): BaseDeps {
  installKaizoDex(data.local, data.moves as Map<number, KaizoMove>);
  let enemyModel = models.get(data.local);
  if (enemyModel === undefined) {
    const romDir = path.join(dataDir, 'rom');
    const ai = typeof data.fingerprint === 'string' ? readStable(dataDir, data.fingerprint, () => loadAiData(romDir)).value : loadAiData(romDir);
    enemyModel = createTrainerAi(data.local, ai);
    models.set(data.local, enemyModel);
  }
  return { data: data.local, catalog: data.catalog, moves: data.moves, enemyModel };
}

/** The data in `dataDir`, loaded now (`loadLocalData`, as the server loads it), with its catalog and moves. */
function readData(dataDir: string): { local: LocalData; catalog: TrainerCatalog; moves: ReadonlyMap<number, KaizoMove> } {
  const local = loadLocalData(dataDir);
  return { local, catalog: buildCatalog(local), moves: buildMoves(local) };
}

/**
 * The deps base over the data in `dataDir`, loaded now, every call (a worker's, through workerDeps.ts, which keeps one
 * per data version). The data and the AI's file are read once, in one `readStable`: a folder that changes meanwhile,
 * or (with `expected`, the server's fingerprint) holds other bytes, throws DataChangedError before anything is
 * installed in this thread.
 */
export function readBaseDeps(dataDir: string, expected: string | null = null): BaseDeps {
  const { value: { local, ai } } = readStable(dataDir, expected, () => ({ local: loadLocalData(dataDir), ai: loadAiData(path.join(dataDir, 'rom')) }));
  const catalog = buildCatalog(local);
  const moves = buildMoves(local);
  installKaizoDex(local, moves);
  const enemyModel = createTrainerAi(local, ai);
  models.set(local, enemyModel);
  return { data: local, catalog, moves, enemyModel };
}

const loaded = new Map<string, { local: LocalData; catalog: TrainerCatalog; moves: ReadonlyMap<number, KaizoMove> }>();

/** The deps base over the data in `dataDir`, loaded once per thread and folder (the real tests' main thread). */
export function loadBaseDeps(dataDir: string): BaseDeps {
  let data = loaded.get(dataDir);
  if (data === undefined) {
    data = readData(dataDir);
    loaded.set(dataDir, data);
  }
  return baseDeps(data, dataDir);
}
