// The line ground on real data: where each save is in the run, the EXP a knockout pays as the engine pays it, a
// level-up that EXP brings with the damage numbers still worked out, a draft through `applyDraft` as the route
// applies it, and the items a draft may hold. Over the June save (PK_SAVE) and the player's current one (`PK_SAVE_CURRENT`, else
// pk-run-2026-11-11.dsv beside PK_SAVE, as engineExp.test.ts finds it), through the real engine, trainer AI, labeler and
// view (src/server/lineDeps.ts), with the box's pool as the line's Pokémon (as `POST /api/line/start` has them).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Choice } from '../../src/contracts/engine.js';
import type { LineExpandJson, LineNodeJson, LineOutcomeJson } from '../../src/contracts/api.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { personalRowFor } from '../../src/rom/forms.js';
import { type BoxState, buildBox } from '../../src/server/box.js';
import { applyDraft, draftItems, parseDraft } from '../../src/server/draft.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService } from '../../src/server/lines.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import type { ServerData } from '../../src/server/state.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
/** The player's current run: `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE` (engineExp.test.ts). */
const CURRENT = process.env.PK_SAVE_CURRENT || path.join(path.dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');
const suite = needFiles('the line ground on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE, PK_SAVE_CURRENT: CURRENT,
});

const TRISTAN = 'roark-split/youngster-tristan/1';
const OPHELIA = 'gardenia-split/galacticfophelia/1';

const likeliest = (step: LineExpandJson) => step.outcomes.reduce((best, o) =>
  BigInt(o.probability.num) * BigInt(best.probability.den) > BigInt(best.probability.num) * BigInt(o.probability.den) ? o : best);

describe.skipIf(suite.skip)(suite.title, () => {
  let loaded: { data: ServerData; june: BoxState; current: BoxState } | null = null;
  /** The data and both saves' boxes, read once (on first use, so a skipped suite reads nothing). */
  function load() {
    if (loaded !== null) return loaded;
    const base = loadBaseDeps(DATA);
    const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
    const box = (savePath: string) => buildBox({ file: fs.readFileSync(savePath), savePath, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
    loaded = { data, june: box(PK_SAVE), current: box(CURRENT) };
    return loaded;
  }

  /** A save's box, its eligible party's refs (lead first), and a line service over the real deps. */
  function setup(which: 'june' | 'current') {
    const { data, june, current } = load();
    const box = which === 'june' ? june : current;
    const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
    const service = createLineService({ deps: () => realLineDeps(data, DATA) });
    return { data, box, party, service };
  }

  /** From `from`, the trainer's steps (his send-outs, the likeliest outcome each) up to the next `turnChoice`, at most 3. */
  async function nextTurn(service: ReturnType<typeof setup>['service'], data: ServerData, from: LineNodeJson): Promise<LineNodeJson> {
    let node = from;
    for (let hops = 0; hops < 3 && node.phase !== 'turnChoice'; hops += 1) {
      const sent = await service.expand(data, node.line, node.node);
      node = await service.node(data, node.line, likeliest(sent).node);
    }
    return node;
  }

  it('the run: the June save is in the Roark split at cap 16, the 11-11 save in the Gardenia split at cap 28', () => {
    const { june, current } = load();
    expect([june.json.badges, june.json.run.split, june.json.levelCap]).toEqual([0, 'Roark Split', 16]);
    expect([current.json.badges, current.json.run.split, current.json.levelCap]).toEqual([1, 'Gardenia Split', 28]);
    expect(current.json.run.splits).toHaveLength(10);
  });

  it('a knockout pays the EXP the engine pays: Prinplup gets 415 for Galactic Ophelia\'s Shuppet (11-11 save)', async () => {
    const { data, box, party, service } = setup('current');
    // Map C's probe: Prinplup, level 21 at 6458 EXP; 6458 + 415 is
    // under level 22's 7577, so no level.
    expect(box.pool.get(party[0]!)).toMatchObject({ species: 394, level: 21, exp: 6458 });
    const root = await service.start({ data, mons: box.pool, trainerId: OPHELIA, variant: 0, team: party.slice(0, 3), world: 0 });
    const allOutcomes: LineOutcomeJson[] = [];
    for (const move of root.choices!.filter((c) => c.choice.kind === 'move')) {
      allOutcomes.push(...(await service.expand(data, root.line, root.node, move.choice)).outcomes);
    }
    const ko = allOutcomes.find((o) => o.faints.p2.includes('Shuppet'))!;
    expect(ko, 'an outcome where Shuppet faints').toBeDefined();
    expect(ko.exp).toEqual([{ index: 0, name: 'Prinplup', gained: 415, boosted: false, fromLevel: 21, toLevel: 21, learned: [], offered: [] }]);
    expect(ko.summary.join(' ')).not.toMatch(/EXP/);
  });

  it.each(['june', 'current'] as const)('%s save: one EXP short of a level, the lead levels on its first knockout and its damage numbers are still worked out', async (which) => {
    const { data, box, party, service } = setup(which);
    const ref = party[0]!;
    const lead = box.pool.get(ref)!;
    const growth = data.local.rom.growth[data.local.rom.species[personalRowFor(lead.species, lead.form)]!.growthRate]!;
    const mons = new Map(box.pool).set(ref, applyDraft(lead, { ref, exp: growth[lead.level + 1]! - 1 }, data.local));
    const root = await service.start({ data, mons, trainerId: TRISTAN, variant: 0, team: party, world: 0 });

    // Breadth first from the root, over his move choices and every outcome (the trainer's steps between free), at most 3
    // of his decisions deep and 300 nodes, for a knockout with no death that the fight goes on after.
    const queue: { node: LineNodeJson; decisions: number }[] = [{ node: root, decisions: 0 }];
    let nodes = 1;
    let ko: LineOutcomeJson | undefined;
    search: while (queue.length > 0) {
      const { node, decisions } = queue.shift()!;
      if (node.phase === 'terminal' || node.aiError !== undefined) continue;
      const choices: (Choice | undefined)[] = node.choices === undefined ? [undefined]
        : decisions < 3 ? node.choices.filter((c) => c.choice.kind === 'move').map((c) => c.choice) : [];
      for (const choice of choices) {
        const step = await service.expand(data, node.line, node.node, choice);
        ko = step.outcomes.find((o) => o.faints.p2.length > 0 && !o.death && o.next !== 'terminal');
        if (ko !== undefined) break search;
        for (const o of step.outcomes.filter((o) => !o.death && o.next !== 'terminal')) {
          if (nodes >= 300) break search;
          nodes += 1;
          queue.push({ node: await service.node(data, node.line, o.node), decisions: decisions + (choice === undefined ? 0 : 1) });
        }
      }
    }
    expect(ko, `a knockout within 3 decisions and 300 nodes (searched ${nodes})`).toBeDefined();
    const gain = ko!.exp.find((g) => g.index === 0)!;
    expect(gain.fromLevel).toBe(lead.level);
    expect(gain.toLevel).toBeGreaterThan(gain.fromLevel);

    const next = await nextTurn(service, data, await service.node(data, root.line, ko!.node));
    expect(next.phase).toBe('turnChoice');
    expect(next.view.player.active).toMatchObject({ level: gain.toLevel });
    expect(next.view.player.party[0]!.expToNext).toBeGreaterThan(0);
    expect(next.damage!.yours.filter((m) => m.note?.startsWith("can't calculate here: your"))).toEqual([]);
  });

  it('a draft starts the fight as drafted: 1 HP and a burn on the lead', async () => {
    const { data, box, party, service } = setup('current');
    // As the route does (src/server/app.ts `draftedPool`): parsed over the team, then each team member drafted, an empty
    // entry for one the draft leaves out.
    const entries = new Map(parseDraft([{ ref: party[0], hp: 1, status: 'burn' }], party).map((entry) => [entry.ref, entry]));
    const mons = new Map(box.pool);
    for (const ref of party) mons.set(ref, applyDraft(box.pool.get(ref)!, entries.get(ref) ?? { ref }, data.local));
    const root = await service.start({ data, mons, trainerId: TRISTAN, variant: 0, team: party, world: 0 });
    expect(root.view.player.active).toMatchObject({ hp: 1, status: 'burned' });
  });

  it('the items a Pokémon may hold are named ones: Leftovers and Lucky Egg are in, the unused and the unnamed are out', () => {
    const items = draftItems(load().data.local);
    expect(items).toEqual(expect.arrayContaining([{ id: 234, name: 'Leftovers' }, { id: 231, name: 'Lucky Egg' }, { id: 42, name: 'Lava Cookie' }]));
    expect(items.some((item) => item.name.startsWith('(') || (item.id >= 113 && item.id <= 134))).toBe(false);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });
});
