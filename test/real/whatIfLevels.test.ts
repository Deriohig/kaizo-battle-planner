// What-if levels on real data (docs/what-if-levels.md): Youngster Tristan over the frozen save, with the lead raised two
// levels. The sheet and the line start both fight with the Pokémon at that level, its stats those of `computeStats` at it.
// Needs the extracted data in DATA_DIR (`npm run extract`) and the frozen save (PK_SAVE).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { computeStats } from '../../src/rom/stats.js';
import { buildBox } from '../../src/server/box.js';
import { levelledMons } from '../../src/server/levels.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService } from '../../src/server/lines.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import { sheetToJson } from '../../src/server/sheet.js';
import type { ServerData } from '../../src/server/state.js';
import { buildSheet } from '../../src/sheet/sheet.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
const suite = needFiles('what-if levels on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE,
});

const TRISTAN = 'roark-split/youngster-tristan/1';

/** The data, the save's box and the raised lead, read on first use so a skipped suite reads nothing. */
let loaded: ReturnType<typeof read> | undefined;
function read() {
  const base = loadBaseDeps(DATA);
  const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
  const box = buildBox({ file: fs.readFileSync(PK_SAVE), savePath: PK_SAVE, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
  const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
  const lead = box.byRef.get(party[0]!)!;
  const raised = lead.level + 2;
  const levels = new Map([[party[0]!, raised]]);
  const statsAt = (level: number) => computeStats(lead.baseStats, lead.ivs, lead.evs, level, lead.nature.value ?? 0);
  return { data, box, party, lead, raised, levels, statsAt };
}
const load = () => (loaded ??= read());

describe.skipIf(suite.skip)(suite.title, () => {
  it('the sheet has the lead at the higher level, with the stats of that level, and the rest of the party as in the save', () => {
    const { data, box, party, lead, raised, levels, statsAt } = load();
    const mons = levelledMons(box.byRef, levels);
    const team = party.map((ref) => mons.get(ref)!);
    const names = data.local.names;
    const json = (t: typeof team) => sheetToJson(buildSheet(t, data.catalog.byId(TRISTAN)!, { moves: data.moves }), { names, variant: 0, variants: 1 });
    const plain = json(party.map((ref) => box.byRef.get(ref)!));
    const sheet = json(team);
    expect(sheet.players[0]).toMatchObject({ key: party[0], level: raised, stats: statsAt(raised) });
    expect(plain.players[0]).toMatchObject({ level: lead.level, stats: statsAt(lead.level) });
    expect(sheet.players[0]!.stats.hp).toBeGreaterThan(plain.players[0]!.stats.hp);
    expect(sheet.players.slice(1)).toEqual(plain.players.slice(1));
    expect(sheet.pairs).toHaveLength(plain.pairs.length);
  });

  it('a line start has the lead at the higher level, its max HP the formula\'s at it, and full HP full', async () => {
    const { data, box, party, lead, raised, levels, statsAt } = load();
    const service = createLineService({ deps: () => realLineDeps(data, DATA) });
    const start = (withLevels: typeof levels | undefined) => service.start({
      data, mons: withLevels === undefined ? box.byRef : levelledMons(box.byRef, withLevels), trainerId: TRISTAN, variant: 0, team: party, world: 0,
    });
    const [plain, up] = [await start(undefined), await start(levels)];
    const [before, after] = [plain.view.player.party[0]!, up.view.player.party[0]!];
    expect([before.level, before.maxHp]).toEqual([lead.level, statsAt(lead.level).hp]);
    expect([after.level, after.maxHp, after.hp]).toEqual([raised, statsAt(raised).hp, statsAt(raised).hp]);
    expect(up.view.player.party.slice(1)).toEqual(plain.view.player.party.slice(1));
    // The box's own Pokémon were not changed by the line.
    expect(box.byRef.get(party[0]!)!.level).toBe(lead.level);
  });
});
