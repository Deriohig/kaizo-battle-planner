// `npm run serve -- [--port <n>]`: the npm script builds the page first, then this serves it and the API on
// http://127.0.0.1:<port> (default 4310). The server serves the page, the box, the matchup sheet (`buildSheet`)
// with the AI's odds, and the fight routes (the line builder, `/api/line/*`). SIGINT and SIGTERM close it.
// The data folder is `$PKP_DATA`, else `data`; the settings file is `settingsFile()`'s. The first-run setup page
// extracts into the data folder with `defaultExtractor`, as `npm run extract` does. The sheet's AI odds
// (`POST /api/sheet/ai/stream`) come from the real trainer AI over the data folder's `rom/`, built on first use with
// `baseDeps`, injected here so the app never loads the real data's deps itself. The line builder runs on the same
// `baseDeps` (`realLineDeps`), so this thread has one dex. Once it is up, the Pokémon sprites are extracted from the ROM
// into `<data>/sprites/` in the background when they are not there yet (`ensureSprites`; one file read when they are).
//
// Hosted mode (`PKP_MODE=hosted`, or `--hosted`) is the same planner for many players on a
// rented server: `node dist/server/server/main.js --hosted`, the variables of section 8.4 (mode.ts). It loads the data
// bundle once (`loadHostedData`), checks the sprites and the built page, builds the trainer AI, and exits with code 1 and
// one line when any of it is missing. It never reads or writes the settings file, watches no save, extracts nothing and
// writes nothing to disk. An uncaught exception is logged and exits with code 1 for the supervisor to restart it.

import type { AiOddsLevel } from '../contracts/api.js';
import { baseDeps } from '../integration/baseDeps.js';
import { buildSheet } from '../sheet/sheet.js';
import { startServer } from './app.js';
import { checkStaticDir, HostedDataError, loadHostedData } from './hostedData.js';
import { startHostedServer } from './hostedRoutes.js';
import { realLineDeps } from './lineDeps.js';
import { createLog, errorRef } from './log.js';
import { type HostedConfig, ModeError, readMode } from './mode.js';
import { SettingsError, settingsFile } from './settings.js';
import { defaultExtractor } from './setup.js';
import { SHOWDOWN_SHEET_ENGINE, type SheetAiDeps } from './sheetAi.js';
import { ensureSprites } from './sprites.js';
import type { ServerData, ServerState } from './state.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function dataLine(state: ServerState, dataDir: string): string {
  const { state: dataState, message, trainers } = state.dataStatus();
  if (dataState === 'ready') return `Data: ${trainers} trainers from ${dataDir}/`;
  if (dataState === 'error') return `Data: cannot load ${dataDir}/: ${message}`;
  return `Data: none in ${dataDir}/ yet; open the page to set it up, or run npm run extract -- --rom <path>`;
}

/**
 * The AI odds' deps for a data load, which the app builds on first use, once per load: `baseDeps` installs the data's
 * dex in this thread (a no-op once it is) and makes the trainer AI over `<dataDir>/rom`.
 */
const sheetAiOver = (dataDir: string) => (data: ServerData): SheetAiDeps => ({ model: baseDeps(data, dataDir).enemyModel, engine: SHOWDOWN_SHEET_ENGINE });

/** The line builder's deps for a data load (lineDeps.ts), built on first use, once per load, over the same `baseDeps`. */
const linesOver = (dataDir: string) => (data: ServerData) => realLineDeps(data, dataDir);

/** SIGINT and SIGTERM close `server`, then exit. */
function stopOnSignals(server: { close(): Promise<void> }): void {
  let stopping = false;
  function stop(): void {
    if (stopping) return;
    stopping = true;
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Closing the server failed:', error);
        process.exit(1);
      },
    );
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function runLocal(port: number, dataDir: string, staticDir: string, version: string, aiOdds: AiOddsLevel): Promise<void> {
  const file = settingsFile();
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      dataDir, settingsFile: file, staticDir,
      buildSheet, extract: defaultExtractor, port, sheetAi: sheetAiOver(dataDir), lines: linesOver(dataDir), sprites: ensureSprites, version, aiOdds,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(`Port ${port} is in use; pass --port <other>`);
    if (error instanceof SettingsError) fail(error.message);
    throw error;
  }
  const { state } = server;
  console.log(`Plat Kaizo Planner on ${server.url}`);
  console.log(`${dataLine(state, dataDir)}; settings: ${file}; save: ${state.settings().savePath ?? 'none chosen yet'}`);
  if (aiOdds !== 'full') console.log(`AI odds: ${aiOdds} (PKP_AI_ODDS)`);
  void ensureSprites(dataDir, state.settings().romPath);
  stopOnSignals(server);
}

async function runHosted(config: HostedConfig): Promise<void> {
  const log = createLog({ requests: config.logRequests });
  process.on('unhandledRejection', (reason) => log.error(errorRef(), 'unhandledRejection', reason));
  process.on('uncaughtException', (error) => {
    log.error(errorRef(), 'uncaughtException', error);
    process.exit(1);
  });

  const { dataDir, staticDir } = config;
  let loaded: ReturnType<typeof loadHostedData>;
  try {
    loaded = loadHostedData(dataDir, { warn: (message) => console.warn(message) });
    checkStaticDir(staticDir);
  } catch (error) {
    if (error instanceof HostedDataError) fail(error.message);
    throw error;
  }
  const sheetAi = sheetAiOver(dataDir);
  const lines = linesOver(dataDir);
  let lineDeps: ReturnType<typeof lines>;
  try {
    sheetAi(loaded.data);                                          // builds the trainer AI now, so a bad file stops the start
    lineDeps = lines(loaded.data);                                 // and the plan step's engine deps
  } catch (error) {
    fail(`Data: the trainer AI cannot load from ${dataDir}/rom: ${error instanceof Error ? error.message : String(error)}`);
  }

  let server: Awaited<ReturnType<typeof startHostedServer>>;
  try {
    server = await startHostedServer({
      data: loaded.data, dataDir, staticDir, buildSheet, sheetAi, lines: lineDeps, limits: config, log, host: config.host, port: config.port,
      aiOdds: config.aiOdds,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(`Port ${config.port} is in use; set PORT or pass --port <other>`);
    throw error;
  }
  console.log(`Plat Kaizo Planner (hosted, version ${config.version}) on ${server.url}`);
  console.log(`Data: ${loaded.data.catalog.trainers.length} trainers and ${loaded.sprites.species} species' sprites from ${dataDir}/${loaded.bundle === null ? ' (no bundle.json)' : `, bundle of ${loaded.bundle.createdAt}`}`);
  console.log(`Password: ${config.password === null ? 'none (public)' : 'on'}; proxies trusted: ${config.trustProxy}; request log: ${config.logRequests ? 'on' : 'off'}; AI odds: ${config.aiOdds}`);
  stopOnSignals(server);
}

let mode: ReturnType<typeof readMode>;
try {
  mode = readMode(process.argv.slice(2), process.env, import.meta.url);
} catch (error) {
  if (error instanceof ModeError) fail(error.message);
  throw error;
}
if (mode.mode === 'hosted') await runHosted(mode.config);
else await runLocal(mode.port, mode.dataDir, mode.staticDir, mode.version, mode.aiOdds);
