// The next fight on real data: a win over Youngster Tristan carried into Galactic Ophelia on the player's current save
// (`PK_SAVE_CURRENT`, else pk-run-2026-11-11.dsv beside PK_SAVE, as lineGround.test.ts finds it), through the line
// service's `next` over the real engine, trainer AI, labeler and view (src/server/lineDeps.ts), with the box's pool as the
// line's Pokémon (as `POST /api/line/start` has them). The plan's probe (11-20): the lead drafted one EXP short of Lv 22
// and to 40 HP won at Lv 22, 38/64, and started the next battle there, its damage numbers worked out at Lv 22; a heal
// started it at 64/64 with full PP.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineExpandJson, LineNodeJson, LineOutcomeJson } from '../../src/contracts/api.js';
import type { CarryState, Engine, EngineState } from '../../src/contracts/engine.js';
import { showdownEngine } from '../../src/engine/index.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { personalRowFor } from '../../src/rom/forms.js';
import { type BoxState, buildBox } from '../../src/server/box.js';
import { applyDraft } from '../../src/server/draft.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService, type LineNextQuery } from '../../src/server/lines.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import type { ServerData } from '../../src/server/state.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
/** The player's current run: `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE` (engineExp.test.ts). */
const CURRENT = process.env.PK_SAVE_CURRENT || path.join(path.dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');
const suite = needFiles('the next fight on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE_CURRENT: CURRENT,
});

const TRISTAN = 'roark-split/youngster-tristan/1';
const OPHELIA = 'gardenia-split/galacticfophelia/1';

const likeliest = (step: LineExpandJson) => step.outcomes.reduce((best, o) =>
  BigInt(o.probability.num) * BigInt(best.probability.den) > BigInt(best.probability.num) * BigInt(o.probability.den) ? o : best);

/** What carries of the player's party: name, level, HP, max HP, status, item and EXP to the next level. */
const seen = (n: LineNodeJson) => n.view.player.party.map((m) => [m.name, m.level, m.hp, m.maxHp, m.status, m.item, m.expToNext]);

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

  /**
   * Every battle the engine built and every carry it read, in order, seen through the service's deps: the real engine
   * wrapped, so a carried member's moves and PP can be read where the view does not show them (it shows the active one's).
   */
  const built: EngineState[] = [];
  const carries: CarryState[] = [];
  const service = createLineService({
    deps: (d) => {
      const real = realLineDeps(d, DATA);
      const engine: Engine = {
        ...real.engine,
        createBattle: (input) => { const state = real.engine.createBattle(input); built.push(state); return state; },
        carryOut: (state) => { const carry = real.engine.carryOut(state); carries.push(carry); return carry; },
      };
      return { ...real, engine };
    },
  });
  /** The data the service runs on (`load`'s). */
  let data: ServerData;

  /** From `root` to the end: his move whose likeliest outcome knocks one out with no death, else one with no death; the likeliest outcome of each step. */
  async function winFrom(root: LineNodeJson): Promise<LineNodeJson> {
    let node = root;
    for (let steps = 0; steps < 60 && node.phase !== 'terminal'; steps += 1) {
      const tries: LineOutcomeJson[] = [];
      for (const c of node.choices?.filter((c) => c.choice.kind === 'move') ?? [undefined]) tries.push(likeliest(await service.expand(data, node.line, node.node, c?.choice)));
      const pick = tries.find((o) => o.faints.p2.length > 0 && !o.death) ?? tries.find((o) => !o.death) ?? tries[0]!;
      node = await service.node(data, node.line, pick.node);
    }
    return node;
  }

  it('a win over Youngster Tristan carries into Galactic Ophelia: HP, PP, EXP and the level it gained (11-11 save)', async () => {
    const { box } = load();
    data = load().data;
    const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
    const ref = party[0]!;
    const lead = box.pool.get(ref)!;
    expect(lead).toMatchObject({ species: 394, level: 21 });                                 // Prinplup
    const growth = data.local.rom.growth[data.local.rom.species[personalRowFor(lead.species, lead.form)]!.growthRate]!;
    const mons = new Map(box.pool).set(ref, applyDraft(lead, { ref, exp: growth[lead.level + 1]! - 1, hp: 40 }, data.local));
    const root = await service.start({ data, mons, trainerId: TRISTAN, variant: 0, team: party.slice(0, 3), world: 0 });

    const won = await winFrom(root);
    expect(won.terminal, `the walk's end: ${JSON.stringify(seen(won))}`).toEqual({ winner: 'p1' });
    expect(won.dead).toBe(false);
    const wonLead = won.view.player.party[0]!;
    expect(wonLead.level).toBe(22);
    expect(wonLead.hp).toBeLessThan(wonLead.maxHp);
    expect(wonLead.expToNext).toBeGreaterThan(0);

    const query: LineNextQuery = { data, line: won.line, node: won.node, trainerId: OPHELIA, variant: 0, world: 0, heal: false };
    const mark = { built: built.length, carries: carries.length };
    const next = await service.next(query);
    expect(seen(next)).toEqual(seen(won));
    expect(next.carried).toEqual({ fromLine: won.line, fromNode: won.node, dropped: [] });
    expect(next.view.enemy.active?.name).toBe('Shuppet');
    const pp = won.view.player.active!.moves!.map((m) => m.pp);
    expect(next.view.player.active!.moves!.map((m) => m.pp)).toEqual(pp);
    expect(next.view.player.active!.moves!.some((m) => m.pp < m.maxPp)).toBe(true);
    // Every carried member's moves (ROM IDs, in slot order) and PP, not only the active
    // one's PP. `next` reads the won state's carry first (lines.ts), then builds the battle; the engine's own reader of that
    // battle gives back each member as the win left it.
    const wonCarry = carries[mark.carries]!;
    const kept = (c: CarryState) => c.mons.map((m) => ({ moves: m.moves, pp: m.pp }));
    expect(built).toHaveLength(mark.built + 1);
    expect(wonCarry.mons).toHaveLength(won.view.player.party.length);
    expect(wonCarry.mons.every((m) => m.moves !== undefined && m.moves.length > 0 && m.moves.length === m.pp.length)).toBe(true);
    expect(kept(showdownEngine.carryOut(built[mark.built]!))).toEqual(kept(wonCarry));
    expect(next.damage!.yours.filter((m) => m.note?.startsWith("can't calculate here: your"))).toEqual([]);

    const healed = await service.next({ ...query, heal: true });
    expect(healed.view.player.party.every((m) => m.hp === m.maxHp && m.status === null)).toBe(true);
    expect(healed.view.player.party.map((m) => [m.level, m.expToNext])).toEqual(won.view.player.party.map((m) => [m.level, m.expToNext]));
    expect(healed.view.player.active!.moves!.every((m) => m.pp === m.maxPp)).toBe(true);

    const led = await service.next({ ...query, lead: party[1]! });
    expect(led.view.player.active?.name).toBe(won.view.player.party[1]!.name);
    expect(led.view.player.party[1]).toMatchObject({ level: wonLead.level, hp: wonLead.hp });

    // One knockout in the carried fight pays on top of the carried EXP: from Lv 22.
    const outcomes: LineOutcomeJson[] = [];
    for (const move of next.choices!.filter((c) => c.choice.kind === 'move')) {
      outcomes.push(...(await service.expand(data, next.line, next.node, move.choice)).outcomes);
    }
    const ko = outcomes.find((o) => o.faints.p2.includes('Shuppet'));
    expect(ko, 'an outcome where Shuppet faints').toBeDefined();
    expect(ko!.exp[0]).toMatchObject({ index: 0, fromLevel: 22 });
  });
});
