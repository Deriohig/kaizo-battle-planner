// The line builder on real data: Youngster Tristan over the frozen save, through the real engine, the real trainer AI and
// the real labeler and view (src/server/lineDeps.ts). Needs the extracted data in DATA_DIR (`npm run extract`) and the
// frozen save (PK_SAVE).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineExpandJson, LineNodeJson, LineRationalJson } from '../../src/contracts/api.js';
import { hitChance } from '../../src/calc/accuracy.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { pageNames } from '../../src/integration/resolver.js';
import { buildSheet } from '../../src/sheet/sheet.js';
import { buildBox } from '../../src/server/box.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService } from '../../src/server/lines.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import type { ServerData } from '../../src/server/state.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
const suite = needFiles('the line builder on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE,
});

const TRISTAN = 'roark-split/youngster-tristan/1';

/** The sum of fractions, as a reduced fraction. */
function total(parts: LineRationalJson[]): string {
  let [num, den] = [0n, 1n];
  for (const p of parts) {
    num = num * BigInt(p.den) + BigInt(p.num) * den;
    den *= BigInt(p.den);
  }
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const g = gcd(num, den);
  return `${num / g}/${den / g}`;
}

const likeliest = (step: LineExpandJson) => step.outcomes.reduce((best, o) =>
  BigInt(o.probability.num) * BigInt(best.probability.den) > BigInt(best.probability.num) * BigInt(o.probability.den) ? o : best);

describe.skipIf(suite.skip)(suite.title, () => {
  function setup() {
    const base = loadBaseDeps(DATA);
    const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
    const box = buildBox({ file: fs.readFileSync(PK_SAVE), savePath: PK_SAVE, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
    const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
    const service = createLineService({ deps: () => realLineDeps(data, DATA) });
    const start = () => service.start({ data, mons: box.byRef, trainerId: TRISTAN, variant: 0, team: party, world: 0 });
    return { service, data, start, party, box };
  }

  it('starts with the party\'s lead, expands a move, its outcomes sum to exactly 1, commits the likeliest and reaches the next turn', async () => {
    const { service, data, start, party } = setup();
    expect(party.length).toBeGreaterThan(1);
    const root = await start();
    expect(root).toMatchObject({ node: 'root', turn: 1, phase: 'turnChoice', dead: false });
    expect(root.view.player.active?.name).toBeTruthy();
    expect(root.view.player.party).toHaveLength(party.length);
    expect(root.view.enemy.party.length).toBeGreaterThan(0);
    expect(root.aiOdds?.kind).toBe('turn');
    expect(total(root.aiOdds!.choices.map((c) => c.probability!))).toBe('1/1');
    const firstMove = root.choices!.find((c) => c.choice.kind === 'move')!;
    expect(firstMove.label).toMatch(/^Use /);

    const step = await service.expand(data, root.line, root.node, firstMove.choice);
    expect(total(step.outcomes.map((o) => o.probability))).toBe('1/1');
    expect(total(step.groups.map((g) => g.probability))).toBe('1/1');
    expect(new Set(step.outcomes.map((o) => o.id)).size).toBe(step.outcomes.length);
    for (const o of step.outcomes) {
      expect(o.summary.length).toBeGreaterThan(0);
      expect(o.endHp.p1).not.toBeNull();
      expect(o.endHp.p2).not.toBeNull();
    }
    expect(step.outcomes[0]!.summary.join(' ')).toContain(root.view.player.active!.name);

    let node: LineNodeJson = await service.node(data, root.line, likeliest(step).node);
    for (let hops = 0; hops < 3 && !(node.phase === 'turnChoice' && node.turn >= 2); hops += 1) {
      expect(node.phase).toBe('enemyReplacement');
      expect(node.aiOdds?.kind).toBe('replacement');
      const sent = await service.expand(data, node.line, node.node);
      expect(total(sent.outcomes.map((o) => o.probability))).toBe('1/1');
      node = await service.node(data, node.line, likeliest(sent).node);
    }
    expect(node).toMatchObject({ phase: 'turnChoice' });
    expect(node.turn).toBeGreaterThanOrEqual(2);
    expect(node.pathPercent).toBeGreaterThan(0);
    expect(node.pathPercent).toBeLessThanOrEqual(100);
  });

  it('a second run gives the same outcome ids and node ids, and a switch is a choice too', async () => {
    const a = setup();
    const b = setup();
    const [rootA, rootB] = [await a.start(), await b.start()];
    const move = rootA.choices!.find((c) => c.choice.kind === 'move')!.choice;
    const [stepA, stepB] = [await a.service.expand(a.data, rootA.line, 'root', move), await b.service.expand(b.data, rootB.line, 'root', move)];
    expect(stepA.outcomes.map((o) => [o.id, o.node, o.probability])).toEqual(stepB.outcomes.map((o) => [o.id, o.node, o.probability]));
    const swap = rootA.choices!.find((c) => c.choice.kind === 'switch')!;
    expect(swap.label).toMatch(/^Switch to /);
    const swapped = await a.service.expand(a.data, rootA.line, 'root', swap.choice);
    expect(total(swapped.outcomes.map((o) => o.probability))).toBe('1/1');
    expect(swapped.outcomes[0]!.summary.join(' ')).toContain('You send out');
  });

  it("the root's damage numbers are the matchup sheet's for the lead against Zigzagoon (full HP), and a node after a switch reads the Pokémon now in front", async () => {
    const { service, data, start, party } = setup();
    const root = await start();
    const box = buildBox({ file: fs.readFileSync(PK_SAVE), savePath: PK_SAVE, savedAt: new Date(), data: data.local, settings: { ...DEFAULT_SETTINGS } });
    const lead = box.byRef.get(party[0]!)!;
    const trainer = data.catalog.byId(TRISTAN)!;
    const pair = buildSheet([{ ...lead, currentHp: lead.currentHp }], trainer, { moves: data.moves, hp: 'full' }).pairs[0]!;
    expect(pair.enemy.name).toBe('Zigzagoon');
    const numbers = root.damage!;
    expect(numbers.yours.map((m) => m.name)).toEqual(pair.playerMoves.map((c) => c.move.name));
    expect(numbers.theirs.map((m) => m.name)).toEqual(pair.enemyMoves.map((c) => c.move.name));
    const same = (got: typeof numbers.yours, cells: typeof pair.playerMoves) => cells.forEach((cell, i) => {
      const g = got[i]!;
      expect(g.hitChance).toBe(cell.hitChance);
      if (cell.result === null) {
        expect(g.percent).toBeNull();
        return;
      }
      expect(g.percent).toEqual(cell.result.percent);
      expect(g.ko).toBe(cell.result.koChance![0]!.chance);
      expect(g.critPercent![1]).toBeGreaterThanOrEqual(g.percent![1]);
    });
    same(numbers.yours, pair.playerMoves);
    same(numbers.theirs, pair.enemyMoves);
    expect(numbers.yours.some((m) => m.percent !== null)).toBe(true);

    // After a switch (the likeliest outcome, and the trainer's send-outs), the next turn's numbers are for the Pokémon now
    // in front: its name, its moves, and the calc's hit chances on the stat stages the node shows (whatever the save's
    // Pokémon and Zigzagoon's move do to them).
    const first = root.choices!.find((c) => c.choice.kind === 'switch')!;
    if (first.choice.kind !== 'switch') throw new Error('not a switch');
    const step = await service.expand(data, root.line, root.node, first.choice);
    let node = await service.node(data, root.line, likeliest(step).node);
    for (let hops = 0; hops < 3 && node.phase !== 'turnChoice'; hops += 1) {
      const sent = await service.expand(data, node.line, node.node);
      node = await service.node(data, node.line, likeliest(sent).node);
    }
    expect(node.phase).toBe('turnChoice');
    const active = node.view.player.active!;
    const mon = box.byRef.get(party[first.choice.index]!)!;
    const enemyMon = trainer.party.find((m) => m.name === node.view.enemy.active!.name)!;
    expect(enemyMon, `${node.view.enemy.active!.name} in Tristan's party`).toBeDefined();
    const stages = (shown: Record<string, string>) => Object.fromEntries(Object.entries(shown).map(([stat, text]) => [stat, Number(text)]));
    expect(node.damage!.against).toBe(active.name);
    expect(node.damage!.against).not.toBe(root.damage!.against);
    expect(node.damage!.yours.map((m) => m.name)).toEqual(active.moves!.map((m) => m.name));
    // The calc is given an empty field: a weather or a field condition at the node would need its own.
    if (node.view.field.weather === null && node.view.field.conditions.length === 0) {
      node.damage!.yours.forEach((m, i) => {
        expect(m.hitChance).toBe(hitChance({ mon, boosts: stages(active.boosts) }, { mon: enemyMon, boosts: stages(node.view.enemy.active!.boosts) }, data.moves.get(mon.moves[i]!)!, {}));
      });
    }
  });

  it('a bench Pokémon that never came out is replaced: the rebuilt path has the same steps, summaries and probabilities, over the new team', async () => {
    const { service, data, start, party } = setup();
    const box = buildBox({ file: fs.readFileSync(PK_SAVE), savePath: PK_SAVE, savedAt: new Date(), data: data.local, settings: { ...DEFAULT_SETTINGS } });
    expect(party.length).toBeGreaterThan(2);
    const oldRoot = await start();

    // Three steps in: the lead's first move (likeliest outcome), the trainer's send-out, the first move again.
    const walked: { choice: LineNodeJson['choices'] extends (infer C)[] | undefined ? C | null : never; outcome: LineExpandJson['outcomes'][number] }[] = [];
    let node: LineNodeJson = oldRoot;
    for (let step = 0; step < 3; step += 1) {
      const choice = node.choices === undefined ? null : node.choices.find((c) => c.choice.kind === 'move')!;
      const expansion = await service.expand(data, node.line, node.node, choice?.choice);
      const outcome = likeliest(expansion);
      walked.push({ choice: choice as never, outcome });
      node = await service.node(data, node.line, outcome.node);
    }
    expect(walked[1]!.choice).toBeNull();

    const bench = party[party.length - 1]!;
    const spare = [...box.byRef.keys()].find((ref) => !party.includes(ref))!;
    const team = party.map((ref) => (ref === bench ? spare : ref));
    const rebuilt = await service.start({ data, mons: box.byRef, trainerId: TRISTAN, variant: 0, team, world: 0 });
    // The page's names (a default nickname reads as the species), not the nicknames.
    const names = pageNames(box.byRef);
    expect(rebuilt.view.player.party.map((m) => m.name)).toContain(names.get(spare)!);
    expect(rebuilt.view.player.party.map((m) => m.name)).not.toContain(names.get(bench)!);
    expect(oldRoot.view.player.party.map((m) => m.name)).toContain(names.get(bench)!);

    let again: LineNodeJson = rebuilt;
    for (const { choice, outcome } of walked) {
      const expansion = await service.expand(data, again.line, again.node, choice?.choice);
      const same = expansion.outcomes.filter((o) => o.signature === outcome.signature);
      expect(same).toHaveLength(1);
      expect(same[0]!.summary).toEqual(outcome.summary);
      expect(same[0]!.probability).toEqual(outcome.probability);
      expect(same[0]!.id).not.toBe(outcome.id);
      again = await service.node(data, again.line, same[0]!.node);
    }
    expect(again.turn).toBe(node.turn);
    expect(again.pathProbability).toEqual(node.pathProbability);
  });
});
