// The fake line server: a tiny fight, Blaze and Bench against Imp and Mouse, the move numbers the plan step answers
// with, and `lineServer()`, whose routes answer the line API for a start, its steps to a win and the next fight.

import type {
  LineDamageJson, LineMonJson, LineMoveDamageJson, LineNodeJson, LineOutcomeJson, LineRationalJson, LineViewJson,
} from '../../../src/server/apiTypes';
import type { FetchCall } from './stubServer';

export const r = (num: number, den: number): LineRationalJson => ({ num: String(num), den: String(den) });
export const percent = (p: LineRationalJson) => (Number(p.num) / Number(p.den)) * 100;

/** The trainer's HP bar percent as the server works it out: floor(HP × 48 / max HP) pixels, at least 1 with HP left, to one decimal. */
export function barOf(hp: number, maxHp: number): number {
  if (hp <= 0) return 0;
  return Math.round((Math.max(1, Math.floor((hp * 48) / maxHp)) * 1000) / 48) / 10;
}

export const mon = (name: string, over: Partial<LineMonJson> = {}): LineMonJson => ({
  ident: name, name, species: name, level: 5, hp: 20, maxHp: 20, percent: 100, status: null, boosts: {}, item: null, ability: 'Keen Eye',
  fainted: false, active: true, ...over,
});

/** Blaze (the Monferno of the box fixture) and Bench against Imp and Mouse; Imp's percent is the bar of its HP (`barOf`). */
export function view(over: { foe?: Partial<LineMonJson>; me?: Partial<LineMonJson> } = {}): LineViewJson {
  const blaze = mon('Blaze', { species: 'Monferno', level: 15, hp: 44, maxHp: 44, ability: 'Blaze', moves: [{ name: 'Scratch', pp: 35, maxPp: 35 }], ...over.me });
  const foe = mon('Imp', over.foe);
  const imp = { ...foe, percent: barOf(foe.hp, foe.maxHp) };
  return {
    player: { active: blaze, party: [blaze, mon('Bench', { active: false, hp: 30, maxHp: 30 })] },
    enemy: { active: imp, party: [imp, mon('Mouse', { active: false })] },
    field: { weather: null, conditions: [], player: [], enemy: [] },
  };
}

export const QUICK = { label: 'Quick Attack', probability: r(5, 8), percent: 62.5 };
export const SAND = { label: 'Sand-Attack', probability: r(3, 8), percent: 37.5 };
export const turnOdds = { kind: 'turn' as const, choices: [QUICK, SAND] };
export const SCRATCH = { choice: { kind: 'move' as const, slot: 0 }, label: 'Use Scratch' };
export const BENCH = { choice: { kind: 'switch' as const, index: 1 }, label: 'Switch to Bench' };

/** A move of his with the real engine's numbers for Aerial Ace into a 50 HP Numel (the move test/real/lineKoExact.test.ts pins), not Scratch's into Imp. */
export const damage = (over: Partial<LineMoveDamageJson>): LineMoveDamageJson => ({
  name: 'Scratch', hitChance: 1, status: false, percent: [44, 54], critPercent: [90, 108], ko: 0, koCrit: 0.5,
  koExact: [r(0, 1), r(51, 128), r(1, 1), r(1, 1)], koCritExact: r(1, 2), hp: [22, 27], critHp: [45, 54], note: null, priority: 0, survives: null, ...over,
});
/** A move's fields when it has no numbers (a status move, or one the server cannot calculate). */
const NO_NUMBERS = { percent: null, critPercent: null, ko: null, koCrit: null, koExact: null, koCritExact: null, hp: null, critHp: null, survives: null } as const;
/** Their Quick Attack against Blaze (44 HP): 4–5 HP (9–11.3%), 8–10 on a crit (18.1–22.7%); four hits leave Blaze standing. */
export const NUMBERS: LineDamageJson = {
  against: 'Blaze', order: null,
  yours: [damage({ slot: 0 })],
  theirs: [
    damage({
      name: 'Quick Attack', percent: [9, 11.3], critPercent: [18.1, 22.7], ko: 0, koCrit: 0, koExact: [r(0, 1), r(0, 1), r(0, 1), r(0, 1)], koCritExact: r(0, 1),
      hp: [4, 5], critHp: [8, 10], priority: 1,
    }),
    damage({ name: 'Sand-Attack', status: true, ...NO_NUMBERS }),
    damage({ name: 'Rock Slide', hitChance: 0.9, ...NO_NUMBERS, note: "can't calculate here: an effect the calculator leaves out" }),
  ],
};


const node = (id: string, over: Partial<Omit<LineNodeJson, 'line'>>, path: LineRationalJson = r(1, 1)): Omit<LineNodeJson, 'line'> => ({
  node: id, turn: 1, phase: 'turnChoice', dead: false, view: view(), unmodelled: [], pathProbability: path, pathPercent: percent(path), world: 0, ...over,
});
const NODES: Record<string, Omit<LineNodeJson, 'line'>> = {
  root: node('root', { aiOdds: turnOdds, choices: [SCRATCH, BENCH], damage: NUMBERS }),
  faint: node('faint', { phase: 'enemyReplacement', view: view({ foe: { hp: 0, fainted: true } }), aiOdds: { kind: 'replacement', choices: [{ label: 'Mouse', probability: r(1, 1), percent: 100 }] } }, r(5, 16)),
  mouse: node('mouse', { turn: 2, aiOdds: { kind: 'turn', choices: [{ label: 'Bite', probability: r(1, 1), percent: 100 }] }, choices: [{ choice: { kind: 'move', slot: 0 }, label: 'Use Strike' }] }, r(5, 16)),
  won: node('won', { turn: 3, phase: 'terminal', terminal: { winner: 'p1' }, view: view({ me: { hp: 30 }, foe: { hp: 0, fainted: true } }) }, r(5, 16)),
};
const outcome = (id: string, nodeId: string, aiAction: string, summary: string[], faints: string[]): LineOutcomeJson => ({
  id, node: nodeId, probability: r(1, 1), percent: 100, aiAction, summary, faints: { p1: [], p2: faints }, death: false, enemyCrit: false, unlabelled: false,
  endHp: { p1: { name: 'Blaze', hp: 44, maxHp: 44, percent: 100 }, p2: { name: 'Imp', hp: 0, maxHp: 20, percent: 0 } },
  signature: `${aiAction} | ${summary.join(' / ')}`, next: 'turnChoice', exp: [], rolls: [],
});
/** Each step by "<node>|<choice key>" (a move 0 is m0, none is empty): a knockout, Mouse sent out, Mouse knocked out. */
const STEPS: Record<string, LineOutcomeJson> = {
  'root|m0': outcome('o-faint', 'faint', 'Quick Attack', ['Blaze uses Scratch', 'Imp fainted'], ['Imp']),
  'faint|': outcome('o-mouse', 'mouse', 'Mouse', ['The trainer sends out Mouse'], []),
  'mouse|m0': outcome('o-win', 'won', 'Bite', ['Blaze uses Strike', 'Mouse fainted'], ['Mouse']),
};
const LOST = { status: 404, json: { error: 'The server no longer holds this tree', code: 'LINE_LOST' } };

/** The words of the next-fight route's refusal of a step that is not the end of a fight the player won. */
export const NOT_WON = 'Next fight starts from a fight you won: this step is not the end of one';

// Each start is a new line holding the nodes its expands made. A next fight from a won node is a new line whose root has Blaze
// at Lv 16 on 30 HP (44 healed), Bench leading for lead party:2, the won line's team size, and `carried` (`gate.dropped` left behind).
export function lineServer() {
  let count = 0;
  const held = new Map<string, Set<string>>();
  const nextRoots = new Map<string, LineNodeJson>();
  const sizes = new Map<string, number>();
  const gate = { dropped: [] as string[] };
  const newLine = (size: number) => {
    const line = `L${++count}`;
    held.set(line, new Set(['root']));
    sizes.set(line, size);
    return line;
  };
  const routes = {
    'POST /api/line/start': (call: FetchCall) => ({ json: { ...NODES.root, line: newLine((call.body as { team: string[] }).team.length) } }),
    'GET /api/line/node': (call: FetchCall) => {
      const params = new URL(call.url, 'http://127.0.0.1').searchParams;
      const [line, id] = [params.get('line') ?? '', params.get('node') ?? ''];
      if (held.get(line)?.has(id) !== true) return LOST;
      return { json: (id === 'root' ? nextRoots.get(line) : undefined) ?? { ...NODES[id], line } };
    },
    'POST /api/line/expand': (call: FetchCall) => {
      const body = call.body as { line: string; node: string; choice?: { kind: string; slot?: number } };
      if (held.get(body.line)?.has(body.node) !== true) return LOST;
      const found = STEPS[`${body.node}|${body.choice === undefined ? '' : `m${body.choice.slot}`}`]!;
      held.get(body.line)!.add(found.node);
      const groups = [{ aiAction: found.aiAction, probability: r(1, 1), percent: 100 }];
      return { json: { groups, outcomes: [found], totals: { enemyFaints: r(1, 1), death: r(0, 1), enemyCrit: r(0, 1) }, line: body.line, node: body.node, choice: body.choice ?? null } };
    },
    'POST /api/line/next': (call: FetchCall) => {
      const body = call.body as { line: string; node: string; lead?: string; heal?: boolean };
      if (held.get(body.line)?.has(body.node) !== true) return LOST;
      if (NODES[body.node]?.terminal?.winner !== 'p1') return { status: 422, json: { error: NOT_WON } };
      const size = sizes.get(body.line) ?? 2;
      const line = newLine(size);
      const shown = view({ me: { level: 16, hp: body.heal === true ? 44 : 30 } });
      const party = (body.lead === 'party:2' ? [...shown.player.party].reverse() : shown.player.party).map((m, i) => ({ ...m, active: i === 0 })).slice(0, size);
      shown.player = { active: party[0]!, party };
      const root = { ...NODES.root, line, view: shown, carried: { fromLine: body.line, fromNode: body.node, dropped: [...gate.dropped] } } as LineNodeJson;
      nextRoots.set(line, root);
      return { json: root };
    },
  };
  return { routes, gate };
}
