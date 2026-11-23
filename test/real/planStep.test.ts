// The plan step on real data: Leader Roark of the Roark split against the 11 November
// save, whose party leads with Prinplup (the same party as the player's live save on 2026-11-21), through the real engine,
// trainer AI, labeler, view and damage (src/server/lineDeps.ts). Needs the extracted data in DATA_DIR (`npm run extract`)
// and that save (PK_PLAN_SAVE, git-ignored).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineAiOddsJson, LineNodeJson, LineRationalJson, PlanStepFieldJson, PlanStepJson, PlanStepStateJson } from '../../src/contracts/api.js';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { buildBox } from '../../src/server/box.js';
import { applyDraft } from '../../src/server/draft.js';
import { realLineDeps } from '../../src/server/lineDeps.js';
import { createLineService } from '../../src/server/lines.js';
import { createPlanService, type PlanStepQuery } from '../../src/server/plan.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import type { ServerData } from '../../src/server/state.js';
import { DATA_DIR, needFiles } from './env.js';

const DATA = path.resolve(DATA_DIR);
const PLAN_SAVE = process.env.PK_PLAN_SAVE || 'data/saves/pk-run-2026-11-11.dsv';
const suite = needFiles('the plan step on real data', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_PLAN_SAVE: PLAN_SAVE,
});

const ROARK = 'roark-split/leader-roark/1';
/** Roark's party, in the copy's own order. */
const ROARK_PARTY = ['Bonsly', 'Lileep', 'Gible', 'Corsola', 'Shuckle', 'Cranidos'];

/** Nothing set; the weather left out, so the battle start's (Roark's permanent sand). */
const FIELD: PlanStepFieldJson = {
  trickRoom: false, rocks: { player: false, enemy: false },
  screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
  stages: { player: {}, enemy: {} }, enemyStatus: 'none',
};

/** A probability's percent to 4 significant digits, as the page rounds it (web/src/format.ts `formatOdds`). */
const pct = (r: LineRationalJson): string => ((Number(r.num) / Number(r.den)) * 100).toPrecision(4);

/** The odds as "label percent" lines. */
const read = (odds: LineAiOddsJson | undefined) => odds?.choices.map((c) => `${c.label} ${pct(c.probability!)}`);

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

/** Galactic Mercury of the Gardenia split, whose Wynaut has Shadow Tag. */
const MERCURY = 'gardenia-split/galactic-mercury/1';
/** Aroma Lady Jenna of the Gardenia split: her field's weather is rain, and her lead Numel has Drought. */
const JENNA = 'gardenia-split/aroma-lady-jenna/1';
/** Scientist Caliban of the Galactic split, in Galactic HQ's permanent Trick Room (data/docs: "PERMANENT TRICK ROOM"). */
const CALIBAN = 'galactic-split/scientist-caliban/1';
/** Lass Kaitlin of the Roark split, whose lead Snubbull has Intimidate. */
const KAITLIN = 'roark-split/lass-kaitlin/1';

/** A view without `expToNext`, which a plan step's view does not have. */
const withoutExp = (v: LineNodeJson['view']) => ({
  ...v,
  player: { ...v.player, party: v.player.party.map(({ expToNext: _e, ...m }) => m), active: v.player.active === null ? null : (({ expToNext: _e, ...m }) => m)(v.player.active) },
});

/** What a test changes of a step: the trainer, the team or the Pokémon, and the parts of the state. */
type Over = Partial<Pick<PlanStepQuery, 'team' | 'mons' | 'trainerId'>> & {
  player?: Partial<PlanStepStateJson['player']>; enemy?: Partial<PlanStepStateJson['enemy']>; field?: Partial<PlanStepFieldJson>;
};

describe.skipIf(suite.skip)(suite.title, () => {
  const setup = (() => {
    let made: ReturnType<typeof make> | null = null;
    function make() {
      const base = loadBaseDeps(DATA);
      const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
      const box = buildBox({ file: fs.readFileSync(PLAN_SAVE), savePath: PLAN_SAVE, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
      const party = box.json.mons.filter((m) => m.location === 'party' && m.eligible).map((m) => m.ref);
      const deps = realLineDeps(data, DATA);
      const plan = createPlanService({ deps: () => deps });
      const lines = createLineService({ deps: () => deps });
      const step = (over: Over = {}): Promise<PlanStepJson> => {
        const team = over.team ?? party;
        return plan.step({
          data, mons: over.mons ?? box.pool, team, trainerId: over.trainerId ?? ROARK, variant: 0, world: 0,
          state: {
            player: { active: team[0]!, fainted: [], ...over.player },
            enemy: { active: 0, fainted: [], ...over.enemy },
            field: { ...FIELD, ...over.field },
          },
        });
      };
      return { data, box, party, lines, step };
    }
    return () => (made ??= make());
  })();

  let turn1: PlanStepJson | null = null;
  const firstTurn = async () => (turn1 ??= await setup().step());
  const speciesOf = (ref: string) => setup().box.json.mons.find((m) => m.ref === ref)!.species;

  it('uses the save whose party leads with Prinplup', () => {
    const { party } = setup();
    expect(party).toHaveLength(6);
    expect(speciesOf(party[0]!)).toBe('Prinplup');
  });

  it("turn 1, nothing set: Roark's Bonsly replies Stealth Rock 68.72% · Brick Break 21.7% · Selfdestruct 9.585%", async () => {
    const step = await firstTurn();
    expect(step.phase).toBe('turnChoice');
    expect(step.aiOdds?.kind).toBe('turn');
    expect(read(step.aiOdds)).toEqual(['Stealth Rock 68.72', 'Brick Break 21.70', 'Selfdestruct 9.585']);
    expect(total(step.aiOdds!.choices.map((c) => c.probability!))).toBe('1/1');
    expect(step.aiError).toBeUndefined();
    expect(step.sendOut).toBeUndefined();
    expect(step.field).toEqual({ ...FIELD, weather: 'sand' });
    expect(step.startStages).toEqual({ player: {}, enemy: {} });
    expect(step.view.field.weather).toBe('Sandstorm');
    expect(step.unmodelled).toEqual((await setup().lines.start({ data: setup().data, mons: setup().box.pool, trainerId: ROARK, variant: 0, team: setup().party, world: 0 })).unmodelled);
  });

  it("turn 1 is the line start's root: the same AI odds, damage, choices and view, and it fits the tree's step panel", async () => {
    const { lines, data, box, party } = setup();
    const root = await lines.start({ data, mons: box.pool, trainerId: ROARK, variant: 0, team: party, world: 0 });
    const step = await firstTurn();
    const panel: Pick<LineNodeJson, 'phase' | 'view' | 'choices' | 'damage' | 'aiOdds' | 'aiError'> = step;
    expect(panel.phase).toBe(root.phase);
    expect(step.aiOdds).toEqual(root.aiOdds);
    expect(step.damage).toEqual(root.damage);
    expect(step.choices).toEqual(root.choices);
    expect(withoutExp(step.view)).toEqual(withoutExp(root.view));
  });

  it("weather left out against a weather ability (Aroma Lady Jenna's Numel, Drought, against her field's rain): turn 1 is still the line start's root", async () => {
    const { lines, data, box, party, step: run } = setup();
    const root = await lines.start({ data, mons: box.pool, trainerId: JENNA, variant: 0, team: party, world: 0 });
    const step = await run({ trainerId: JENNA });
    expect(step.view.enemy.active?.species).toBe('Numel');
    expect(step.view.field.weather).toBe(root.view.field.weather);
    expect(step.aiOdds).toEqual(root.aiOdds);
    expect(step.damage).toEqual(root.damage);
    expect(step.choices).toEqual(root.choices);
    expect(withoutExp(step.view)).toEqual(withoutExp(root.view));
    console.log(`plan step: Jenna's start weather ${step.field.weather} (view ${step.view.field.weather}); reply ${read(step.aiOdds)?.join(' · ')}`);
  });

  it("startStages: Lass Kaitlin's Snubbull leads with Intimidate, so the start gives his active -1 Atk; the step's stages stay the step's, and seeding them is the line start", async () => {
    const { lines, data, box, party, step: run } = setup();
    const step = await run({ trainerId: KAITLIN });
    expect(step.view.enemy.active?.species).toBe('Snubbull');
    expect(step.startStages).toEqual({ player: { atk: -1 }, enemy: {} });
    expect(step.view.player.active?.boosts ?? {}).toEqual({});
    const seeded = await run({ trainerId: KAITLIN, field: { stages: step.startStages! } });
    expect(seeded.view.player.active?.boosts).toEqual({ atk: '-1' });
    const root = await lines.start({ data, mons: box.pool, trainerId: KAITLIN, variant: 0, team: party, world: 0 });
    expect(seeded.aiOdds).toEqual(root.aiOdds);
    expect(seeded.damage).toEqual(root.damage);
    expect(withoutExp(seeded.view)).toEqual(withoutExp(root.view));
  });

  it("view and damage: Prinplup at the draft's HP against Bonsly; both sides' moves with T's fields", async () => {
    const { step: run, box, party, data } = setup();
    const step = await firstTurn();
    expect(step.view.player.active).toMatchObject({ species: 'Prinplup', hp: 61, maxHp: 61, active: true });
    expect(step.view.player.active?.moves?.map((m) => m.name)).toEqual(['Metal Claw', 'Aerial Ace', 'Aqua Cutter', 'Aurora Beam']);
    expect(step.view.enemy.active).toMatchObject({ species: 'Bonsly', active: true });
    expect(step.view.enemy.party.map((m) => m.species)).toEqual(ROARK_PARTY);
    expect(step.damage?.yours.map((m) => m.name)).toEqual(['Metal Claw', 'Aerial Ace', 'Aqua Cutter', 'Aurora Beam']);
    const brickBreak = step.damage?.theirs.find((m) => m.name === 'Brick Break');
    expect(brickBreak).toMatchObject({ status: false, hp: expect.any(Array), critHp: expect.any(Array), koExact: expect.any(Array), hitChance: expect.any(Number) });
    expect(step.damage?.theirs.find((m) => m.name === 'Stealth Rock')).toMatchObject({ status: true, hp: null });
    expect(step.damage?.against).toBe(step.view.player.active?.name);
    expect(step.choices.filter((c) => c.choice.kind === 'move')).toHaveLength(4);
    expect(step.choices.filter((c) => c.choice.kind === 'switch').map((c) => c.choice)).toEqual([1, 2, 3, 4, 5].map((index) => ({ kind: 'switch', index })));

    // The draft's HP: Prinplup drafted at 30 HP stays at 30 HP.
    const mons = new Map(box.pool).set(party[0]!, applyDraft(box.pool.get(party[0]!)!, { ref: party[0]!, hp: 30 }, data.local));
    const drafted = await run({ mons });
    expect(drafted.view.player.active).toMatchObject({ species: 'Prinplup', hp: 30, maxHp: 61 });
  });

  it('with Stealth Rock already on his side, Stealth Rock is 0%', async () => {
    const step = await setup().step({ field: { rocks: { player: true, enemy: false } } });
    const rock = step.aiOdds?.choices.find((c) => c.label === 'Stealth Rock');
    expect(rock === undefined || rock.probability!.num === '0').toBe(true);
    expect(total(step.aiOdds!.choices.map((c) => c.probability!))).toBe('1/1');
    expect(step.view.field.player).toContain('Stealth Rock');
    expect(step.view.field.enemy).not.toContain('Stealth Rock');
    console.log(`plan step: Stealth Rock on his side: ${read(step.aiOdds)?.join(' · ')}`);
    const theirs = await setup().step({ field: { rocks: { player: false, enemy: true } } });
    expect(theirs.view.field.enemy).toContain('Stealth Rock');
    expect(theirs.view.field.player).not.toContain('Stealth Rock');
  });

  it('a trainer Pokémon in an alternate form shows it in the view: Rotom forms and Giratina Origin carry speciesId and formId', async () => {
    const { data, step: run } = setup();
    for (const [species, form] of [[479, 2], [479, 5], [487, 1]] as const) {
      const holds = (m: { species: number; form: number }) => m.species === species && m.form === form;
      const trainer = data.catalog.trainers.find((t) => t.battleType === 'single' && t.party.some(holds));
      expect(trainer, `a single trainer with species ${species} form ${form}`).toBeDefined();
      const at = trainer!.party.findIndex(holds);
      const answer = await run({ trainerId: trainer!.id, enemy: { active: at } });
      expect(answer.view.enemy.active, trainer!.id).toMatchObject({ speciesId: species, formId: form });
      console.log(`plan step: ${trainer!.id}'s ${answer.view.enemy.active?.species} is species ${species} form ${form}`);
    }
    // A Pokémon in its base form has no formId.
    expect((await firstTurn()).view.enemy.active).not.toHaveProperty('formId');
  });

  it('Trick Room flips who moves first in the damage order', async () => {
    const turn = await firstTurn();
    const room = await setup().step({ field: { trickRoom: true } });
    expect(turn.damage?.order?.first).toBe('player');
    expect(room.damage?.order?.first).toBe('enemy');
  });

  it("a permanent Trick Room fight (Scientist Caliban): left out, the start's Trick Room, echoed; false still turns it off", async () => {
    const left = await setup().step({ trainerId: CALIBAN, field: { trickRoom: undefined } });
    expect(left.field.trickRoom).toBe(true);
    expect(left.view.field.conditions).toContain('Trick Room');
    expect(left.damage?.order?.first).toBe('player');
    const off = await setup().step({ trainerId: CALIBAN, field: { trickRoom: false } });
    expect(off.field.trickRoom).toBe(false);
    expect(off.damage?.order?.first).toBe('enemy');
    // Roark's field has no Trick Room: left out is off.
    expect((await setup().step({ field: { trickRoom: undefined } })).field.trickRoom).toBe(false);
  });

  it('their active marked fainted: their send-out odds, with party indices, over the Pokémon not marked fainted', async () => {
    const { step: run } = setup();
    const turn = await firstTurn();
    const one = await run({ enemy: { fainted: [0] } });
    expect(one.phase).toBe('turnChoice');
    expect(one.aiOdds).toEqual(turn.aiOdds);
    expect(one.damage).toEqual(turn.damage);
    expect(one.sendOut?.kind).toBe('replacement');
    expect(total(one.sendOut!.choices.map((c) => c.probability!))).toBe('1/1');
    for (const c of one.sendOut!.choices) expect(ROARK_PARTY[c.index]).toBe(c.label);
    expect(one.sendOut!.choices.every((c) => c.index > 0)).toBe(true);

    const three = await run({ enemy: { fainted: [0, 1, 2] } });
    for (const c of three.sendOut!.choices) expect(['Corsola', 'Shuckle', 'Cranidos']).toContain(c.label);
    expect(three.view.enemy.party.filter((m) => m.fainted).map((m) => m.species)).toEqual(['Lileep', 'Gible']);

    // None of theirs left standing: no send-out, never an error.
    const all = await run({ enemy: { fainted: [0, 1, 2, 3, 4, 5] } });
    expect(all.sendOut).toBeUndefined();
    expect(all.sendOutError).toBeUndefined();
    expect(all.aiOdds?.kind).toBe('turn');
  });

  it("his active marked fainted: the turn's damage and reply stand; phase playerReplacement, his choices the Pokémon not marked fainted", async () => {
    const { step: run, party } = setup();
    const turn = await firstTurn();
    const marked = await run({ player: { fainted: [party[0]!] } });
    expect(marked.phase).toBe('playerReplacement');
    expect(marked.aiOdds).toEqual(turn.aiOdds);
    expect(marked.damage).toEqual(turn.damage);
    expect(marked.choices).toEqual(turn.choices.filter((c) => c.choice.kind === 'switch'));

    const bench = await run({ player: { fainted: [party[0]!, party[1]!, party[3]!] } });
    expect(bench.choices.map((c) => c.choice)).toEqual([2, 4, 5].map((index) => ({ kind: 'switch', index })));
    expect(bench.view.player.party.map((m) => m.fainted)).toEqual([false, true, false, true, false, false]);
    expect([bench.view.player.party[1]!.hp, bench.view.player.party[3]!.hp]).toEqual([0, 0]);
    expect(bench.view.player.active).toMatchObject({ species: 'Prinplup', hp: 61 });
    const benchOnly = await run({ player: { fainted: [party[1]!] } });
    expect(benchOnly.phase).toBe('turnChoice');
    expect(benchOnly.choices.filter((c) => c.choice.kind === 'move')).toHaveLength(4);
  });

  it("his replacements against Shadow Tag (Mercury's Wynaut): his turn has no switch, his marked active's replacements are the bench not marked fainted", async () => {
    const { step: run, party, data } = setup();
    const k = data.catalog.trainers.find((t) => t.id === MERCURY)!.party.findIndex((m) => m.name === 'Wynaut');
    expect(k).toBeGreaterThanOrEqual(0);
    const turn = await run({ trainerId: MERCURY, enemy: { active: k } });
    expect(turn.view.enemy.active?.species).toBe('Wynaut');
    expect(turn.choices.filter((c) => c.choice.kind === 'switch')).toEqual([]);
    const marked = await run({ trainerId: MERCURY, enemy: { active: k }, player: { fainted: [party[0]!, party[2]!] } });
    expect(marked.phase).toBe('playerReplacement');
    expect(marked.choices.map((c) => c.choice)).toEqual([1, 3, 4, 5].map((index) => ({ kind: 'switch', index })));
    expect(marked.choices.map((c) => c.label)).toEqual([1, 3, 4, 5].map((i) => `Switch to ${marked.view.player.party[i]!.name}`));
  });

  it("weather: left out, Roark's permanent sand from the battle start; given, it wins", async () => {
    const { step: run } = setup();
    const none = await run({ field: { weather: 'none' } });
    expect(none.field.weather).toBe('none');
    expect(none.view.field.weather).toBeNull();
    expect(none.aiOdds?.kind).toBe('turn');
    const rain = await run({ field: { weather: 'rain' } });
    expect(rain.field.weather).toBe('rain');
    expect(rain.view.field.weather).toBe('Rain');
    const aquaCutter = (s: PlanStepJson) => s.damage!.yours.find((m) => m.name === 'Aqua Cutter')!.hp![1];
    expect(aquaCutter(rain)).toBeGreaterThan(aquaCutter(none));
    const sand = await run({ field: { weather: 'sand' } });
    expect(sand.aiOdds).toEqual((await firstTurn()).aiOdds);
  });

  it("their active can be any of the trainer's party: Gible leads, the party keeps the copy's order, and the numbers are Gible's", async () => {
    const { step: run } = setup();
    const step = await run({ enemy: { active: 2 } });
    expect(step.view.enemy.active?.species).toBe('Gible');
    expect(step.view.enemy.party.map((m) => m.species)).toEqual(ROARK_PARTY);
    expect(step.view.enemy.party.map((m) => m.active)).toEqual([false, false, true, false, false, false]);
    expect(step.aiOdds?.kind).toBe('turn');
    expect(total(step.aiOdds!.choices.map((c) => c.probability!))).toBe('1/1');
    // The damage reader finds Gible's own data: numbers, never "can't calculate".
    expect(step.damage?.theirs.length).toBeGreaterThan(0);
    expect(step.damage?.theirs.some((m) => m.hp !== null)).toBe(true);
    expect(step.damage?.theirs.every((m) => m.note === null || !m.note.includes("can't calculate"))).toBe(true);
    expect(step.damage?.yours.every((m) => m.note === null || !m.note.includes("can't calculate"))).toBe(true);
    // A send-out from Gible's fall: each with the copy's own party index.
    const fallen = await run({ enemy: { active: 2, fainted: [2, 0] } });
    for (const c of fallen.sendOut!.choices) expect(ROARK_PARTY[c.index]).toBe(c.label);
    expect(fallen.sendOut!.choices.map((c) => c.index).every((i) => i !== 0 && i !== 2)).toBe(true);
  });

  it('his active can be a box Pokémon in the active slot, the switches indexed by team position', async () => {
    const { step: run, box, party } = setup();
    const boxMon = box.json.mons.find((m) => m.location === 'box' && m.draft !== null && box.pool.has(m.ref));
    expect(boxMon).toBeDefined();
    const team = [boxMon!.ref, ...party.slice(0, 5)];
    const step = await run({ team });
    expect(step.view.player.party.map((m) => m.species)).toEqual(team.map(speciesOf));
    expect(step.view.player.active?.species).toBe(boxMon!.species);
    expect(step.aiOdds?.kind).toBe('turn');
    expect(step.choices.filter((c) => c.choice.kind === 'switch').map((c) => c.choice)).toEqual([1, 2, 3, 4, 5].map((index) => ({ kind: 'switch', index })));
  });

  it('stat stages, screens, Trick Room and their status reach the state', async () => {
    const { step: run } = setup();
    const turn = await firstTurn();
    const boosted = await run({ field: { stages: { player: { atk: 2, spe: -1 }, enemy: { acc: -1, eva: 1, def: 6 } } } });
    expect(boosted.view.player.active?.boosts).toEqual({ atk: '+2', spe: '-1' });
    expect(boosted.view.enemy.active?.boosts).toEqual({ def: '+6', accuracy: '-1', evasion: '+1' });
    const claw = (s: PlanStepJson) => s.damage!.yours.find((m) => m.name === 'Metal Claw')!.hp!;
    expect(claw(boosted)).not.toEqual(claw(turn));

    const field = await run({ field: { trickRoom: true, screens: { player: { reflect: true, lightScreen: false }, enemy: { reflect: false, lightScreen: true } } } });
    expect(field.view.field.conditions).toContain('Trick Room');
    expect(field.view.field.player).toContain('Reflect');
    expect(field.view.field.enemy).toContain('Light Screen');
    // Reflect halves Selfdestruct (Brick Break would break the screen, so the calc leaves it alone).
    const boom = (s: PlanStepJson) => s.damage!.theirs.find((m) => m.name === 'Selfdestruct')!.hp![1];
    expect(boom(field)).toBeLessThan(boom(turn));

    expect((await run({ field: { enemyStatus: 'par' } })).view.enemy.active?.status).toBe('paralysed');
    expect((await run({ field: { enemyStatus: 'brn' } })).view.enemy.active?.status).toBe('burned');
  });

  it("sleep and toxic on Roark's Bonsly (marked fainted): every counter gives the same figures, so the status is used; the reply is turn 1's", async () => {
    const { step: run } = setup();
    const turn = await firstTurn();
    for (const [status, word] of [['slp', 'asleep'], ['tox', 'badly poisoned']] as const) {
      const step = await run({ field: { enemyStatus: status }, enemy: { fainted: [0] } });
      expect(step.unmodelled.some((line) => line.endsWith('which the plan does not set'))).toBe(false);
      expect(step.view.enemy.active?.status).toBe(word);
      expect(step.field.enemyStatus).toBe(status);
      expect(step.aiOdds).toEqual(turn.aiOdds);
      expect(step.sendOut?.kind).toBe('replacement');
    }
  });
});
