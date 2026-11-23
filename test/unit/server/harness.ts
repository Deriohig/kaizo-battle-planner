// The server test harness: `startServer` on port 0 over a temp folder, with the fixture data, a scripted save watcher
// and `buildSheet`. Each test file calls `closeServers` after each test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiOddsLevel, SettingsJson } from '../../../src/server/apiTypes.js';
import { startServer } from '../../../src/server/app.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import type { ServerDeps, ServerState } from '../../../src/server/state.js';
import type { watchSave } from '../../../src/server/watchSave.js';
import { buildSheet } from '../../../src/sheet/sheet.js';
import { saveFile, serverData } from './fixtures.js';

/** A watcher the test fires by hand, in place of `watchSave`'s polling. */
export interface ScriptedWatcher { path: string; onChange: () => void | Promise<void>; closed: boolean }

export interface Harness {
  url: string; state: ServerState; dir: string; settingsFile: string; savePath: string; watchers: ScriptedWatcher[];
  /** Runs the open watcher's change callback, as `watchSave` would after a debounced change, and waits for it. */
  fire(): Promise<void>;
}

const running: { close(): Promise<void>; dir: string }[] = [];

/** Closes every server `start` opened and removes the temp folders. */
export async function closeServers(): Promise<void> {
  for (const server of running.splice(0)) {
    await server.close();
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
}

/** Removes `dir` at the next `closeServers`. */
export function removeLater(dir: string): void {
  running.push({ close: async () => undefined, dir });
}

/**
 * A server over a temp folder: the save (`saveFile()` unless given) at `<dir>/game.dsv`, the settings file at
 * `<dir>/config/settings.json` (written from `settings(savePath)` when given), `serverData()`, a scripted watcher and
 * `buildSheet`. `deps.aiOdds` is the AI odds level, full when left out.
 */
export async function start(opts: {
  deps?: Partial<ServerDeps> & { aiOdds?: AiOddsLevel }; settings?: (savePath: string) => Partial<SettingsJson>; save?: Uint8Array;
} = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-app-test-'));
  const savePath = path.join(dir, 'game.dsv');
  fs.writeFileSync(savePath, opts.save ?? saveFile());
  const settingsFile = path.join(dir, 'config', 'settings.json');
  if (opts.settings) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...DEFAULT_SETTINGS, ...opts.settings(savePath) }));
  }
  const watchers: ScriptedWatcher[] = [];
  const watch = ((watched: string, onChange: () => void | Promise<void>) => {
    const watcher: ScriptedWatcher = { path: watched, onChange, closed: false };
    watchers.push(watcher);
    return { close: () => { watcher.closed = true; } };
  }) as typeof watchSave;
  const server = await startServer({
    dataDir: path.join(dir, 'data'), settingsFile, staticDir: null, buildSheet, watch, loadData: () => serverData(), port: 0, ...opts.deps,
  });
  running.push({ close: server.close, dir });
  return {
    url: server.url, state: server.state, dir, settingsFile, savePath, watchers,
    async fire() {
      const open = watchers.filter((w) => !w.closed);
      if (open.length !== 1) throw new Error(`Expected one open watcher, found ${open.length}`);
      await open[0]!.onChange();
    },
  };
}
