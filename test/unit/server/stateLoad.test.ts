import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalData } from '../../../src/data/load.js';
import { DocsError } from '../../../src/docs/fetchDocs.js';
import { RomError } from '../../../src/errors.js';
import { DATA_UNSTABLE_MESSAGE, fingerprintData } from '../../../src/integration/fingerprint.js';
import { createState, type ServerState } from '../../../src/server/state.js';
import { buildSheet } from '../../../src/sheet/sheet.js';
import { serverData } from './fixtures.js';

const states: ServerState[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const READY = { state: 'ready', message: null, trainers: 3 };
const UNSTABLE = { state: 'error', message: DATA_UNSTABLE_MESSAGE, trainers: null };
const halfWritten = () => new RomError('BAD_FORMAT', 'ROM data unreadable: romdata.json: Unexpected end of JSON input; extract it again');

/** A temp data folder holding two of the files the loaders read, and the server state over it with `loadData`. */
async function stateOver(loadData: (write: (file: string, text: string) => void) => LocalData, prepare: (dataDir: string) => void = () => undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-load-'));
  dirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dataDir, file)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, file), text);
  };
  write('rom/romdata.json', '{"extract":0}');
  write('docs/Moves.csv', 'Move,Type\n');
  prepare(dataDir);
  const state = await createState({ dataDir, settingsFile: path.join(dir, 'settings.json'), staticDir: null, buildSheet, loadData: () => loadData(write) });
  states.push(state);
  return { state, dataDir, write };
}

describe("the server's data load and the data fingerprint", () => {
  it('load takes the fingerprint of the folder it loaded; a reload after a change takes the new one', async () => {
    const { state, dataDir, write } = await stateOver(() => serverData());
    const first = state.data()?.fingerprint;
    expect(first).toBe(fingerprintData(dataDir));
    const version = state.dataVersion();
    write('docs/Moves.csv', 'Move,Type\nTackle,Normal\n');   // an extract
    state.reloadData();
    expect([state.data()?.fingerprint, state.dataVersion()]).toEqual([fingerprintData(dataDir), version + 1]);
    expect(state.data()?.fingerprint).not.toBe(first);
  });

  it.each([
    ['loads', () => serverData()],
    ['fails', () => { throw halfWritten(); }],
  ])('a folder that changes while the first read %s is read again: the data has the final bytes\' fingerprint', async (_name, firstRead) => {
    let calls = 0;
    const { state, dataDir } = await stateOver((write) => {
      if (++calls > 1) return serverData();
      write('rom/romdata.json', '{"extract":1}');               // an extract writing in place as the server loads
      return firstRead();
    });
    expect([state.dataStatus(), state.data()?.fingerprint, calls, state.dataVersion()]).toEqual([READY, fingerprintData(dataDir), 2, 1]);
  });

  it.each([
    ['loads', () => serverData()],
    ['fails', () => { throw halfWritten(); }],
  ])('a folder that keeps changing while each read %s gives the unstable error after three tries, and no data', async (_name, read) => {
    let calls = 0;
    const { state } = await stateOver((write) => {
      write('rom/romdata.json', `{"extract":${++calls}}`);
      return read();
    });
    expect([state.dataStatus(), state.data(), calls]).toEqual([UNSTABLE, null, 3]);
  });

  it('a listed file that cannot be stamped (a folder in its place) gives a status, never takes the server down', async () => {
    // A file the loader reads: the loader's own error classifies.
    const unreadable = new DocsError('BAD_FORMAT', 'Personal', '"Personal" tab cannot be read: EISDIR: illegal operation on a directory, read');
    const docs = await stateOver(() => { throw unreadable; }, (dataDir) => fs.mkdirSync(path.join(dataDir, 'docs', 'Personal.csv')));
    expect(docs.state.dataStatus()).toEqual({ state: 'error', message: unreadable.message, trainers: null });
    // A file the loader does not read (the AI's): the load succeeds, but without a stamp there is no fingerprint.
    const ai = await stateOver(() => serverData(), (dataDir) => fs.mkdirSync(path.join(dataDir, 'rom', 'trainer-ai.json')));
    expect([ai.state.dataStatus(), ai.state.data()]).toEqual([{ state: 'error', message: expect.stringContaining('EISDIR'), trainers: null }, null]);
    expect(() => ai.state.reloadData()).not.toThrow();
    expect(ai.state.dataStatus().state).toBe('error');
  });
});
