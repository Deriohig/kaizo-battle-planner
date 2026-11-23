// A Focus Sash at full HP on real data (`survives`, src/server/lineDamage.ts): Leader Roark leads with Bonsly holding a
// Focus Sash, so Prinplup's Aqua Cutter, which KOs it from full HP in one hit by the calc, carries `survives: 'Focus Sash'`
// at the start. The player's eligible party on his current save (`PK_SAVE_CURRENT`, else pk-run-2026-11-11.dsv beside PK_SAVE,
// as lineKoExact.test.ts finds it), Prinplup leading, through the line service over the real deps (src/server/lineDeps.ts),
// with the box's pool as the line's Pokémon. A browser check (11-21): "OHKO 100%" with no word of the Sash.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { buildBox } from '../../src/server/box.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService } from '../../src/server/lines.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import type { ServerData } from '../../src/server/state.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
/** The player's current run: `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE` (engineExp.test.ts). */
const CURRENT = process.env.PK_SAVE_CURRENT || path.join(path.dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');
const suite = needFiles('a Focus Sash at full HP on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE_CURRENT: CURRENT,
});

const ROARK = 'roark-split/leader-roark/1';

describe.skipIf(suite.skip)(suite.title, () => {
  it("Roark's Bonsly leads at full HP with a Focus Sash, and Prinplup's Aqua Cutter into it carries survives: 'Focus Sash'", async () => {
    const base = loadBaseDeps(DATA);
    const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
    // The server matches the Sash by hold effect 103 (src/server/lineDamage.ts `SURVIVORS`): the Focus Sash's alone.
    expect(base.data.rom.items.filter((item) => item.holdEffect === 103).map((item) => item.id)).toEqual([275]);
    const box = buildBox({ file: fs.readFileSync(CURRENT), savePath: CURRENT, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
    const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
    expect(box.pool.get(party[0]!)).toMatchObject({ species: 394 });   // Prinplup leads
    const service = createLineService({ deps: (d) => realLineDeps(d, DATA) });
    const root = await service.start({ data, mons: box.pool, trainerId: ROARK, variant: 0, team: party, world: 0 });

    expect(root.phase).toBe('turnChoice');
    expect(root.view.player.active).toMatchObject({ name: 'Prinplup' });
    const bonsly = root.view.enemy.active!;
    expect(bonsly).toMatchObject({ name: 'Bonsly', item: 'Focus Sash' });
    expect(bonsly.hp).toBe(bonsly.maxHp);

    const aquaCutter = root.damage!.yours.find((m) => m.name === 'Aqua Cutter')!;
    expect(aquaCutter, 'Aqua Cutter in his moves').toBeDefined();
    expect(aquaCutter.koExact![0]).toEqual({ num: '1', den: '1' });
    expect(aquaCutter.survives).toBe('Focus Sash');
    expect(root.damage!.yours.filter((m) => m.status).every((m) => m.survives === null)).toBe(true);
    expect(root.view.player.active!.item).not.toBe('Focus Sash');
    expect(root.damage!.theirs.every((m) => m.survives === null), 'Prinplup holds no Focus Sash').toBe(true);
  });
});
