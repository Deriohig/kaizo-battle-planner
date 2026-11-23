// The engine's battle-level notes (src/engine/notes.ts) are listed, exported and complete: every `addUnmodelledNote` call
// in src/engine records a listed note, a Metronome call's or a trainer item's, so the real-data detail check accepts
// every note a correct verdict can meet. And `plainUnmodelled` turns each `unmodelledIn` entry into one plain sentence
// for the fight page, free of the engine's developer reasons (function names, file and line cites).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as battle from '../../../src/engine/battle.js';
import { createBattle } from '../../../src/engine/battle.js';
import { ENGINE_EFFECTS, NO_ENTRY_REASON } from '../../../src/engine/effects.js';
import * as engine from '../../../src/engine/index.js';
import { installKaizoDex, unmodelledIn } from '../../../src/engine/index.js';
import * as conditions from '../../../src/engine/mod/conditions.js';
import * as exp from '../../../src/engine/mod/exp.js';
import * as field from '../../../src/engine/mod/field.js';
import * as moves from '../../../src/engine/mod/moves.js';
import * as procs from '../../../src/engine/mod/procs.js';
import * as scripts from '../../../src/engine/mod/scripts.js';
import * as speedOrder from '../../../src/engine/mod/speedOrder.js';
import { BATTLE_NOTES, isBattleNote, PLAIN_NOTES, plainUnmodelled } from '../../../src/engine/notes.js';
import * as trainerItems from '../../../src/engine/trainerItems.js';
import { BAG, emberTurn, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

/** Every .ts file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') ? [path] : [];
  });
}
const MODULES = [battle, conditions, exp, field, moves, procs, scripts, speedOrder, trainerItems].map((module) => module as unknown as Record<string, unknown>);

describe('the engine\'s battle-level notes', () => {
  it('every addUnmodelledNote call records a listed note, a Metronome call\'s or a trainer item\'s', () => {
    const calls = sources('src/engine').flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/addUnmodelledNote\(\s*[\w.]+,\s*([^;]+?)\);/g)].map((match) => ({ path, note: match[1]!.trim() })));
    expect(calls.length).toBeGreaterThan(15);
    for (const { path, note } of calls) {
      if (/^[A-Z][A-Z_]*NOTE$/.test(note)) {
        const value = MODULES.map((module) => module[note]).find((found) => typeof found === 'string') as string | undefined;
        expect(value, `${path}: ${note} is exported`).toBeDefined();
        expect(value!.startsWith('engine:') ? isBattleNote(value!) : value!.startsWith('trainer item:'), `${path}: ${note}`).toBe(true);
      } else if (note.startsWith('metronomeCallNote(')) {
        expect(isBattleNote(moves.metronomeCallNote('Splash'))).toBe(true);
      } else {
        expect(note, `${path}: a note built in place is a trainer item's`).toMatch(/^`trainer item: /);
      }
    }
  });

  it('the list holds only engine: notes, each once, the index exports it, and nothing else is a battle note', () => {
    expect(new Set(BATTLE_NOTES).size).toBe(BATTLE_NOTES.length);
    for (const note of BATTLE_NOTES) expect(note.startsWith('engine: ')).toBe(true);
    expect([engine.BATTLE_NOTES, engine.isBattleNote]).toEqual([BATTLE_NOTES, isBattleNote]);
    for (const note of [engine.PICKUP_NOTE, engine.RESIST_BERRY_NOTE, engine.KNOCK_OFF_PLATE_NOTE]) expect(BATTLE_NOTES).toContain(note);
    // A move note, a trainer item's, invented ones.
    expect(['Pursuit: no entry for its effect text', trainerItems.UNDEFINED_CATEGORY_NOTE, 'engine: some invented note', 'engine: Metronome called , which the engine doesn\'t model']
      .map((note) => isBattleNote(note))).toEqual([false, false, false, false]);
  });
});

describe('the plain notes the page shows', () => {
  /** What a player must never see: function names, file or line cites, source labels, the reference engine's name. */
  const JARGON = [/bs:/, /\.s:/, /\.c:/, /\.s\b/, /\.c\b/, /BtlCmd_/, /Showdown/i, /engine:/i, /ROM effect/i, /decompil/i, /:\d/, /\b[a-z]+_[a-z_0-9]+\b/, /\bcartridge\b/i];
  function expectPlain(text: string, label: string): void {
    expect(text.trim(), `${label} is not empty`).not.toBe('');
    for (const pattern of JARGON) expect(text, `${label} matches ${pattern}: ${text}`).not.toMatch(pattern);
  }

  it('every unmodelled effect, battle-level note and trainer item note has a plain sentence with no cites', () => {
    const unmodelled = Object.entries(ENGINE_EFFECTS).flatMap(([text, effect]) => (effect.kind === 'unmodelled' ? [[text, effect] as const] : []));
    expect(unmodelled.length).toBeGreaterThan(20);
    for (const [text, effect] of unmodelled) expectPlain((effect as unknown as { plain: string }).plain, `the plain text of "${text}"`);
    for (const note of [...BATTLE_NOTES, trainerItems.UNDEFINED_CATEGORY_NOTE]) expectPlain(PLAIN_NOTES[note] ?? '', `the plain text of ${note}`);
    expectPlain(plainUnmodelled([moves.metronomeCallNote('Future Sight')])[0]!, 'a Metronome call');
    expectPlain(plainUnmodelled(['engine: move "bogus" is not a hack move'])[0]!, 'a move that is no hack move');
    for (const name of Object.values(trainerItems.BAG_ITEM_NAMES)) {
      expectPlain(plainUnmodelled([`trainer item: ${name}'s HP recovery left stored outside the potion routine (itemHPRecovery)`])[0]!, `the ${name} note`);
    }
  });

  it('an entry nothing recognises still reads plainly, never as the developer text', () => {
    const [plain] = plainUnmodelled(['Tackle: some new developer reason (BtlCmd_Whatever, bs:1-2) ("Whatever")']);
    expectPlain(plain!, 'an unknown move entry');
    expect(plain).toMatch(/^Tackle: /);
    expectPlain(plainUnmodelled(['engine: a brand new note (battle_script.c:1-2)'])[0]!, 'an unknown note');
  });

  it('the page shape: one move, its name, then one plain sentence, from what the engine reports for a battle', () => {
    const noRule = "Double-Edge: the planner has no rule for this move's effect";
    expect([plainUnmodelled([`Double-Edge: ${NO_ENTRY_REASON} ("Recoil")`]), plainUnmodelled(unmodelledIn(createBattle(emberTurn([ID.doubleEdge]))))]).toEqual([[noRule], [noRule]]);
    const secret = Object.values(ENGINE_EFFECTS).find((effect) => effect.kind === 'unmodelled' && effect.reason.startsWith('its added effect depends on the battle terrain')) as unknown as { reason: string };
    expect(plainUnmodelled([`Secret Power: ${secret.reason} ("Secret Power effect")`])).toEqual(["Secret Power: its added effect depends on where the battle takes place, which the planner doesn't know"]);
    const raw = unmodelledIn(createBattle({ player: [playerMon(ID.monferno, 30, [ID.beatUp, ID.ember])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.beatUp])]), field: {} }));
    expect(raw).toHaveLength(1);
    const [plain] = plainUnmodelled(raw);
    expectPlain(plain!, 'Beat Up');
    expect(plain).toMatch(/^Beat Up: /);
  });
});
