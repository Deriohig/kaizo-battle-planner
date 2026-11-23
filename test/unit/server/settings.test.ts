import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, graveyardBoxes, loadSettings, parseSettings, saveSettings, SettingsError, settingsFile, toLinuxPath,
} from '../../../src/server/settings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-t3-'));
  file = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The defaults with some fields replaced; untyped, so a test can put in a wrong value. */
const settingsWith = (patch: Record<string, unknown>) => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });

describe('saveSettings and loadSettings', () => {
  it('round-trip into a new folder, replacing the old file and leaving no temp file; a missing file loads the defaults', () => {
    const nested = path.join(dir, 'config', 'plat-kaizo-planner', 'settings.json');
    saveSettings(nested, DEFAULT_SETTINGS);
    expect([loadSettings(nested), fs.readdirSync(path.dirname(nested))]).toEqual([DEFAULT_SETTINGS, ['settings.json']]);
    const changed = { romPath: '/mnt/c/roms/kaizo.nds', savePath: '/mnt/c/Battery/kaizo.dsv', graveyardBox: 17, levelCapOverride: 47 };
    saveSettings(nested, changed);
    expect([loadSettings(nested), fs.readdirSync(path.dirname(nested))]).toEqual([changed, ['settings.json']]);
    const loaded = loadSettings(path.join(dir, 'nothing-here.json'));   // a missing file: a fresh copy of the defaults
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    loaded.graveyardBox = 12;
    expect(DEFAULT_SETTINGS.graveyardBox).toBeNull();
  });

  it('an old file loads: the solver keys and priorities are dropped, a hand-edited Windows path is read as a WSL path', () => {
    fs.writeFileSync(file, JSON.stringify({
      romPath: 'C:\\roms\\pk.nds', savePath: null, graveyardBox: 12, levelCapOverride: 30, budgetsMs: { route: 1 }, ranking: ['nope'], threads: 4096,
      engine: 'rust', priorities: { party: 'never', boxes: { '3': 'must' }, mons: {} },
    }));
    expect(loadSettings(file)).toEqual({ romPath: '/mnt/c/roms/pk.nds', savePath: null, graveyardBox: 12, levelCapOverride: 30 });
  });

  it.each([
    ['corrupt JSON', '{\n  "romPath": \n', []],
    ['JSON that is not an object', '[1, 2]', []],
    ['a bad value', JSON.stringify({ levelCapOverride: 101 }), ['levelCapOverride']],
  ])('a file holding %s throws SettingsError naming the path, on one line', (_name, text, names) => {
    fs.writeFileSync(file, text);
    let error: unknown;
    try {
      loadSettings(file);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SettingsError);
    const { message } = error as Error;
    for (const part of [file, ...names]) expect(message).toContain(part);
    expect(message).not.toMatch(/[\r\n]/);
  });
});

it.each([
  [{ PKP_SETTINGS: '/x/s.json', XDG_CONFIG_HOME: '/xdg', HOME: '/h' }, '/x/s.json'],
  [{ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }, '/xdg/plat-kaizo-planner/settings.json'],
  [{ HOME: '/h' }, '/h/.config/plat-kaizo-planner/settings.json'],
])('settingsFile(%o) is %s', (env, want) => {
  expect(settingsFile(env)).toBe(want);
});

it.each([
  ['"C:\\Users\\User\\Desktop\\Battery\\x.dsv"', '/mnt/c/Users/User/Desktop/Battery/x.dsv'],
  ['D:/roms/a.nds', '/mnt/d/roms/a.nds'],
  ['/home/player/data', '/home/player/data'],
  ['  /mnt/c/x.dsv \n', '/mnt/c/x.dsv'],
  ["'E:\\saves\\x.dsv'", '/mnt/e/saves/x.dsv'],
  ['"/tmp/a"b"', '/tmp/a"b'],       // only one matching pair of quotes is stripped
  ['"/tmp/x.dsv', '"/tmp/x.dsv'],
  ['""', ''],
])('toLinuxPath(%j) is %j', (input, want) => {
  expect(toLinuxPath(input)).toBe(want);
});

describe('parseSettings', () => {
  const { levelCapOverride: _gone, ...three } = DEFAULT_SETTINGS;

  it.each([
    ['the defaults', {}, {}],
    ['pasted Windows paths and empty paths', { romPath: '  ', savePath: '"C:\\Battery\\x.dsv"' }, { romPath: null, savePath: '/mnt/c/Battery/x.dsv' }],
    ['the low edges', { graveyardBox: 1, levelCapOverride: 100 }, { graveyardBox: 1, levelCapOverride: 100 }],
    ['the high edges', { graveyardBox: 18, levelCapOverride: 1 }, { graveyardBox: 18, levelCapOverride: 1 }],
    ['the old keys, dropped', { threads: 4, engine: 'native', budgetsMs: {}, ranking: [] }, {}],
  ])('accepts %s', (_name, patch, want) => {
    expect(parseSettings(settingsWith(patch))).toEqual({ ok: true, settings: { ...DEFAULT_SETTINGS, ...want } });
  });

  it.each<[unknown, RegExp]>([
    [settingsWith({ graveyardBox: 19 }), /graveyardBox/], [settingsWith({ graveyardBox: 0 }), /graveyardBox/],
    [settingsWith({ graveyardBox: 15.5 }), /graveyardBox/], [settingsWith({ levelCapOverride: 0 }), /levelCapOverride/],
    [settingsWith({ levelCapOverride: 101 }), /levelCapOverride/], [settingsWith({ levelCapOverride: '50' }), /levelCapOverride/],
    [three, /^levelCapOverride must be a whole number from 1 to 100, or null$/],
    [settingsWith({ romPath: 5 }), /romPath/], [settingsWith({ savePath: undefined }), /savePath/],
    [null, /settings/i], [[], /settings/i],
  ])('rejects %j naming the field', (body, error) => {
    expect(parseSettings(body)).toEqual({ ok: false, error: expect.stringMatching(error) });
  });
});

it.each([[null, [15, 16, 17, 18]], [15, [15, 16, 17, 18]], [18, [18]], [12, [12, 13, 14, 15, 16, 17, 18]]])(
  'graveyardBoxes with graveyardBox %s is %j', (graveyardBox, want) => {
    expect(graveyardBoxes({ ...DEFAULT_SETTINGS, graveyardBox })).toEqual(want);
  },
);
