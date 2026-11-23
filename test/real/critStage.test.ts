// The move's own crit stage on real data (src/server/critChance.ts `ownCrit`): the server reads it from the installed
// engine's move, Showdown's `critRatio` less 1 and `willCrit`, as the engine's `getDamage` draws the crit; the calc spec's
// `critStage` and `alwaysCrit` are only its fallback where the engine has no move. Over every move of the installed dex,
// this checks the two sources agree, and lists the ones that differ (an inherited or unmodelled move keeps Showdown's
// own fields, which the calc spec, built from the docs' effect text, may not have).

import path from 'node:path';
import PS from 'pokemon-showdown';
import { describe, expect, it } from 'vitest';
import { KAIZO_MOD, moveId } from '../../src/engine/dex.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { ownCrit } from '../../src/server/critChance.js';
import { DATA_DIR, needFiles } from './env.js';

const { Dex } = PS;
const DATA = path.resolve(DATA_DIR);
const suite = needFiles('crit stage: the engine move against the calc spec', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'),
});

/** The moves whose two sources differ, as `differences` words them; the server goes by the engine's. */
const KNOWN: readonly string[] = [];

describe.skipIf(suite.skip)(suite.title, () => {
  it("every move's stage and always-crit agree between the engine's move and the calc spec, bar the listed ones", () => {
    const base = loadBaseDeps(DATA);
    const dex = Dex.mod(KAIZO_MOD);
    const missing: string[] = [];
    const differences: string[] = [];
    const words = ({ stage, always }: { stage: number; always: boolean }) => `stage ${stage}${always ? ', always crits' : ''}`;
    const raised: string[] = [];
    let checked = 0;
    for (const move of base.moves.values()) {
      let id: string;
      try {
        id = moveId(move);
      } catch {
        missing.push(move.name);
        continue;
      }
      const sim = dex.moves.get(id);
      if (!sim.exists) {
        missing.push(move.name);
        continue;
      }
      checked += 1;
      // The engine never rolls a crit for a move with willCrit false; `ownCrit` has no word for it, so none may have it.
      expect(sim.willCrit, move.name).not.toBe(false);
      const engine = ownCrit(move, sim);
      const calc = ownCrit(move, null);
      if (engine.stage > 0) raised.push(move.name);
      if (engine.stage !== calc.stage || engine.always !== calc.always) differences.push(`${move.name} (${move.id}): engine ${words(engine)}, calc ${words(calc)}`);
    }
    expect(checked).toBeGreaterThan(400);
    // The engine's side is really read: the high-crit moves have a raised stage there.
    expect(raised).toEqual(expect.arrayContaining(['Slash', 'Stone Edge']));
    expect(missing).toEqual([]);
    expect(differences).toEqual(KNOWN);
  });
});
