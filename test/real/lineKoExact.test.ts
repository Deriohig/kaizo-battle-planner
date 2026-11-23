// Exact KO odds on real data: a step's damage numbers carry the calc's exact KO fractions and the HP
// ranges, and they agree with the outcomes the engine gives for the same hit. Galactic Venus's Numel against the player's
// eligible party on his current save (`PK_SAVE_CURRENT`, else pk-run-2026-11-11.dsv beside PK_SAVE, as lineGround.test.ts
// finds it), through the line service over the real engine, trainer AI, labeler and view (src/server/lineDeps.ts), with
// the box's pool as the line's Pokémon (as `POST /api/line/start` has them). The board's probe (11-20): Prinplup's Aerial
// Ace into Numel at 50/50 never KOs in one hit without a crit, KOs on a crit half the time, and the crit knockout is
// exactly 1/32 of the step's outcomes.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineRationalJson } from '../../src/contracts/api.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { type BoxState, buildBox } from '../../src/server/box.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService } from '../../src/server/lines.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import type { ServerData } from '../../src/server/state.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
/** The player's current run: `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE` (engineExp.test.ts). */
const CURRENT = process.env.PK_SAVE_CURRENT || path.join(path.dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');
const suite = needFiles('exact KO odds on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE_CURRENT: CURRENT,
});

const VENUS = 'gardenia-split/galacticf-venus/1';

/** The exact sum of fractions, reduced. */
function sum(fractions: LineRationalJson[]): { num: bigint; den: bigint } {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  let [num, den] = [0n, 1n];
  for (const f of fractions) {
    [num, den] = [num * BigInt(f.den) + BigInt(f.num) * den, den * BigInt(f.den)];
    const g = gcd(num, den);
    [num, den] = [num / g, den / g];
  }
  return { num, den };
}

describe.skipIf(suite.skip)(suite.title, () => {
  let loaded: { data: ServerData; box: BoxState } | null = null;
  /** The data and the current save's box, read once (on first use, so a skipped suite reads nothing). */
  function load() {
    if (loaded !== null) return loaded;
    const base = loadBaseDeps(DATA);
    const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
    const box = buildBox({ file: fs.readFileSync(CURRENT), savePath: CURRENT, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
    loaded = { data, box };
    return loaded;
  }

  const service = createLineService({ deps: (d) => realLineDeps(d, DATA) });

  it("Prinplup's Aerial Ace into Numel at 50/50 (11-11 save): no one-hit KO without a crit, 1/2 on a crit, and the crit knockout is in the outcomes at exactly 1/32", async () => {
    const { data, box } = load();
    const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
    const root = await service.start({ data, mons: box.pool, trainerId: VENUS, variant: 0, team: party, world: 0 });
    expect(root.view.enemy.active).toMatchObject({ name: 'Numel', hp: 50, maxHp: 50 });

    const aa = root.damage!.yours.find((m) => m.name === 'Aerial Ace')!;
    expect(aa, 'Aerial Ace in his moves').toBeDefined();
    expect(aa).toMatchObject({ percent: [44, 54], hp: [22, 27], critHp: [45, 54], koCritExact: { num: '1', den: '2' } });
    expect(aa.koExact![0]).toEqual({ num: '0', den: '1' });
    expect(aa.koExact![2]).toEqual({ num: '1', den: '1' });
    const two = aa.koExact![1]!;
    expect(two.num !== '0' && two.num !== two.den, `two hits KO strictly between 0 and 1: ${two.num}/${two.den}`).toBe(true);

    const aquaCutter = root.damage!.yours.find((m) => m.name === 'Aqua Cutter')!;
    expect(aquaCutter.koExact![0]).toEqual({ num: '1', den: '1' });
    const selfdestruct = root.damage!.theirs.find((m) => m.name === 'Selfdestruct')!;
    expect(selfdestruct.koExact![0]).toEqual({ num: '0', den: '1' });
    expect(selfdestruct.koCritExact).toEqual({ num: '1', den: '1' });

    const use = root.choices!.find((c) => c.choice.kind === 'move' && c.choice.slot === aa.slot)!;
    const step = await service.expand(data, root.line, root.node, use.choice);
    const critKo = ['Prinplup uses Aerial Ace', 'Critical hit on Numel', 'Numel loses 100% (0% left)', 'Numel fainted'];
    const matching = step.outcomes.filter((o) => JSON.stringify(o.summary) === JSON.stringify(critKo));
    expect(matching.length, 'outcomes that are the crit knockout').toBeGreaterThan(0);
    expect(sum(matching.map((o) => o.probability))).toEqual({ num: 1n, den: 32n });

    // The trainer's HP left is its 48-pixel bar's percent, to one decimal.
    const standing = step.outcomes.filter((o) => o.endHp.p2 !== null && o.endHp.p2.hp > 0);
    expect(standing.length).toBeGreaterThan(0);
    for (const o of standing) {
      const { hp, maxHp, percent } = o.endHp.p2!;
      expect(percent, `${o.summary.join(' / ')}: ${hp}/${maxHp}`).toBe(Math.round(Math.max(1, Math.floor((hp * 48) / maxHp)) * 1000 / 48) / 10);
    }
  });
});
