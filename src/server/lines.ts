// The line builder's service (docs/line-builder.md): a hand-driven walk over the real engine and trainer AI.
// The player picks his own decisions and which chance outcome to follow; this answers each step with the AI's exact odds and
// every outcome with its exact probability. It proves nothing and searches nothing.
//
// A line's battle is built with `battleInput` (src/integration/fight.ts): the resolver's fight (its field and worlds),
// The player's team lead first, each Pokémon on the HP, PP and status its `PlayerMon` has: the save's, with the draft's edits
// over them (the route applies the draft to `mons`, src/server/app.ts `draftedPool`). The service applies no levels and
// no pre-statuses of its own: a level, HP or status before the fight is set in the draft. The AI's memory starts at
// `initialMemory` and each outcome folds in with `remember`.
//
// Nodes. A node is a battle state with the AI's memory, the path's probability so far (`path`) and whether a death of
// The player's happened on the way (`dead`: any faint of his, and reaching `playerReplacement`). The root is 'root'; a child's
// id is a hash of its parent's id, the player's choice and the outcome's id, so the same path has the same node ids in every
// line and run (the page replays a lost line by its saved path). An outcome's id is a short hash of the outcome's state
// key, observation and who crit, and the AI action that led to it (two actions can reach one state; the doc's hash lacks
// the action).
//
// Expanding a node (`expand`): at `turnChoice` the player's choice with each action of the AI's `support` (`expandTurn(state,
// { p1: choice, p2: action })`); at `playerMidTurnSwitch` and `playerReplacement` his choice alone; at
// `enemyMidTurnSwitch` and `enemyReplacement` each action of `replacementSupport`. An outcome's probability is its
// action's times its own, exact. Every outcome becomes a stored child node; the same expand again answers from the store.
// The service yields to the event loop before each AI action, as the sheet's AI odds do between pairs, so the server keeps
// answering. Each outcome also carries the EXP the engine paid in it, read from its log against the view before the step,
// and the damage rolls it fixed (lineExp.ts); neither is in its `summary` or `signature`. Each outcome names the phase
// it reaches (`next`) and, at the end, the winner.
//
// The store is bounded: `maxNodes` nodes across all lines (see `DEFAULT_MAX_NODES`). Past it the line used least
// recently goes first (the doc says the oldest; a line in use is not the oldest), and a line that alone outgrows it is
// refused with 422. An unknown line or node, and every line after a data reload, answers 404 `LINE_LOST`.
//
// The next fight (`next`). From a node that ends a fight the player won, the next trainer's line starts with the team
// as that node's battle left it: the engine's `carryOut` of each Pokémon still standing (HP, PP, status, item, EXP and
// moves), in the won fight's order or with `lead` first. A fainted one is left behind and named (`dropped`). With `heal`
// each starts at full HP and PP with no status (`FULL_CARRY`), keeping its item, EXP and moves. The new line keeps the
// won line's Pokémon (`LineRec.mons`: the pool with that line's draft applied), so the next battle is built over the
// same sets, and its path probability starts again at 1. Its root, and only its root, says where the team came from
// (`LineNodeJson.carried`). The won line is not changed.
//
// Errors (`LineErrorCode`). An engine error (`UNSUPPORTED_DOUBLE`, `UNMODELLED_ITEM`, `BAD_CHOICE`, `LIMIT`) answers 422
// with its message and its code, and a choice that is not legal at the node is `BAD_CHOICE` too. An error with a string
// `code` from the AI (any `AiError`) is the node's `aiError`, and expanding that node answers 422 `AI_UNDEFINED` (so does
// one from the AI's first memory at a start); a battle the engine refuses to build with a `RangeError` is 422 `BAD_START`;
// a line that alone would outgrow the store is 422 `TOO_BIG`. Anything else is a bug and propagates.

import { createHash, randomBytes } from 'node:crypto';
import type { PlayerMon } from '../battle/playerMon.js';
import type {
  LineAiOddsJson, LineCarriedJson, LineDamageJson, LineChoiceJson, LineExpandJson, LineNodeJson, LineOutcomeJson, LineRationalJson, LineViewJson,
  LineWorldJson,
} from '../contracts/api.js';
import type { ActionSupport, AiMemory, EnemyModel } from '../contracts/ai.js';
import type { CarryState, Choice, Engine, EngineState, Rational } from '../contracts/engine.js';
import { plainUnmodelled } from '../engine/notes.js';
import { add, mul, ONE, ZERO } from '../engine/rational.js';
import { battleInput, type BattleResolver, type FightInfo, type MonInfo, type PlanLabeler } from '../integration/fight.js';
import { NATURES } from '../rom/natures.js';
import type { MonRef } from './apiTypes.js';
import { HttpError } from './http.js';
import { expGains, rollsOf } from './lineExp.js';
import { summarizeLog } from './lineSummary.js';
import type { ServerData } from './state.js';

/**
 * What the service runs on (`ServerDeps.lines`, injected like the sheet AI's): the engine and the trainer AI; the
 * resolver and the labeler, which read the box's Pokémon; `view`, what the page shows of a state (`labels` are the player's
 * Pokémon by team index, lead first); and the name of an ability ID, for the worlds' labels.
 */
export interface LineDeps {
  engine: Engine; model: EnemyModel;
  resolver(mons: ReadonlyMap<MonRef, PlayerMon>): BattleResolver;
  /** `team`: the battle's party as refs of `mons`, in order (so a level-up in the fight keeps each one's name). */
  labeler(mons: ReadonlyMap<MonRef, PlayerMon>, team: readonly MonRef[]): PlanLabeler;
  view(state: EngineState, labels: readonly string[]): LineViewJson;
  abilityName(id: number): string;
  /**
   * Optional: the damage numbers of a node's moves (lineDamage.ts), over the line's team (the Pokémon his side's sets were made
   * from, the draft's edits included, in the battle's party order). Without it nodes carry none.
   */
  damage?(team: PlayerMon[]): (state: EngineState) => LineDamageJson | null;
  /** Optional: a move's name by its Showdown ID, for an outcome's rolls. Without it a roll names the ID. */
  moveName?(showdownId: string): string;
  /**
   * Optional: the EXP `mon` still needs to go from `level` to the next with `exp` in all, or null at level 100 or when
   * unknown. With it the player's party in a node's view has `expToNext` (from the engine's `carryOut`); without it, no such field.
   */
  expToNext?(mon: PlayerMon, level: number, exp: number): number | null;
}

/**
 * One line to start. `mons` are the box's pool by ref (every Pokémon that may join a draft, over-cap ones included), with
 * the draft's edits applied to the team's; `team` is the lead first. Each Pokémon of the team starts as `mons` has it: its
 * level, HP, PP and status.
 */
export interface LineStartQuery {
  data: ServerData; mons: ReadonlyMap<MonRef, PlayerMon>;
  trainerId: string; variant: number; team: MonRef[]; world: number;
}

/**
 * The next fight from a won node (see the top of the file). `line` and `node` name the node; `trainerId` and `variant`
 * the next trainer; `lead` one of the Pokémon still standing (left out: the won fight's order); `heal` starts each at
 * full HP and PP with no status.
 */
export interface LineNextQuery {
  data: ServerData; line: string; node: string; trainerId: string; variant: number; world: number; lead?: MonRef; heal: boolean;
}

/** A carried HP or PP above any max HP or PP: the contract's `CarryState` reads it as full. */
export const FULL_CARRY = 65_535;

export interface LineService {
  /** Builds the battle and answers the root node. Throws `HttpError`: 400 for a bad team or world, 404 for an unknown trainer, 422 for a battle that cannot start. */
  start(query: LineStartQuery): Promise<LineNodeJson>;
  /** A node, answered from the store. 404 `LINE_LOST` for a line or node it does not hold. */
  node(data: ServerData, line: string, node: string): Promise<LineNodeJson>;
  /** The outcomes of the step from a node (see the top of the file). */
  expand(data: ServerData, line: string, node: string, choice?: Choice): Promise<LineExpandJson>;
  /**
   * The next trainer's line from a won node, with the team as its battle left it, and its root node. Throws `HttpError`:
   * 404 `LINE_LOST`; 422 for a node that does not end a fight the player won, an end the engine cannot carry, a double or a
   * battle that cannot start; 404 or 400 for the trainer as `start`; 400 for a `lead` that is not standing or a bad world.
   */
  next(query: LineNextQuery): Promise<LineNodeJson>;
}

/**
 * The most nodes the store keeps across all lines. Measured on the real engine, AI, labeler and view over the frozen save
 * (a six-Pokémon team, nodes expanded breadth first and the likeliest outcome of each viewed, heap after a forced GC, 2026-11-09):
 * a node is about 50 KB against Leader Fantina (its state JSON is 37 KB), 68 KB against Youngster Tristan (28 KB of JSON,
 * probably two bytes a character in V8, as a Nidoran♀ is in it) and 90 KB against Leader Roark (37 KB, two-byte), the engine
 * state being nearly all of it (the AI's memory is 0.3 KB, an outcome's summary under 1 KB). 3,000 nodes at the worst of
 * those, 90 KB, is 270 MB: under the doc's 300 MB, and about 150 expansions of a line.
 */
export const DEFAULT_MAX_NODES = 3_000;

export const DOUBLE_TEXT = "Double battles can't be built yet";
const NOT_WON_TEXT = 'Next fight starts from a fight you won: this step is not the end of one';
const ENGINE_CODES: ReadonlySet<string> = new Set(['UNSUPPORTED_DOUBLE', 'UNMODELLED_ITEM', 'BAD_CHOICE', 'LIMIT']);
const MAX_TEAM = 6;

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));
const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

const lost = () => new HttpError(404, 'The server no longer holds this tree', 'LINE_LOST');

/** An engine failure the page can read becomes 422 with its message and its code; anything else is rethrown. */
export function engineFailure(error: unknown): never {
  const code = codeOf(error);
  if (code !== undefined && ENGINE_CODES.has(code)) throw new HttpError(422, messageOf(error), code);
  throw error;
}

/** The 422 for an AI whose behaviour is undefined here (its `AiError`'s code and words): `AI_UNDEFINED`. */
export const aiUndefined = (text: string) => new HttpError(422, text, 'AI_UNDEFINED');

/** The fight against `trainerId`: 404 for a trainer the resolver does not know, 400 for another refusal, 422 for a double. */
export function fightOf(resolver: BattleResolver, trainerId: string, variant: number): FightInfo {
  let fight: FightInfo;
  try {
    fight = resolver.fight({ trainerId, variant });
  } catch (error) {
    throw new HttpError(/no trainer/i.test(messageOf(error)) ? 404 : 400, messageOf(error));
  }
  if (fight.trainer.battleType === 'double') throw new HttpError(422, DOUBLE_TEXT);
  return fight;
}

export const ratJson = (r: Rational): LineRationalJson => ({ num: String(r.num), den: String(r.den) });

/** The percent of a probability, to six decimals (bigint arithmetic, so a 30-digit fraction is no trouble). */
export const percentOf = (r: Rational): number => Number((r.num * 100_000_000n) / r.den) / 1_000_000;

function choiceKey(choice: Choice): string {
  switch (choice.kind) {
    case 'move': return `m${choice.slot}`;
    case 'switch': return `s${choice.index}`;
    case 'item': return `i:${choice.item}:${(choice.consumeSlots ?? []).join('.')}`;
  }
}

/** The AI's odds at a node: its actions with labels, or the error that makes the behaviour undefined here. */
export type AiAnswer =
  | { kind: 'turn' | 'replacement'; actions: { choice: Choice; label: string; probability: Rational }[]; odds: { label: string; probability: Rational }[] }
  | { error: string };

interface ExpandRecord { json: LineExpandJson }

interface NodeRec {
  id: string; parent: string | null; via: { choice: string; outcome: string } | null;
  state: EngineState; memory: AiMemory; dead: boolean; path: Rational;
  /** The player's Pokémon as the state's sets were made. */
  team: PlayerMon[];
  ai?: AiAnswer | null;
  expansions: Map<string, Promise<ExpandRecord>>;
  json?: LineNodeJson;
}

interface LineRec {
  /** The damage numbers over a node's team (one function per team array), when the deps have them. */
  damageFor: (team: PlayerMon[]) => ((state: EngineState) => LineDamageJson | null) | null;
  id: string; data: ServerData; deps: LineDeps; labeler: PlanLabeler; fight: FightInfo; world: number; worlds: LineWorldJson[] | undefined;
  /** The Pokémon the line was built over (`LineStartQuery.mons`); a carried line keeps the won line's. */
  mons: ReadonlyMap<MonRef, PlayerMon>;
  /** The battle's party as refs of `mons`, lead first. */
  team: MonRef[];
  /** Where a carried line's team came from: on its root's JSON. */
  carried?: LineCarriedJson;
  /** The player's Pokémon by team index, lead first (the resolver's page names). */
  labels: string[];
  /** Page names by battle name, for the player's side. */
  idents: Map<string, string>;
  /** The trainer's Pokémon by team index. */
  enemyNames: string[];
  nodes: Map<string, NodeRec>;
  alive: boolean;
}

export function createLineService(opts: { deps: (data: ServerData) => LineDeps; maxNodes?: number }): LineService {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  /** In use order: the first is the line used longest ago. */
  const lines = new Map<string, LineRec>();
  let total = 0;
  let storeData: ServerData | null = null;
  let depsFor: { data: ServerData; deps: LineDeps } | null = null;

  /** A new data load empties the store: its lines' states belong to the old data. */
  function sync(data: ServerData): void {
    if (storeData === data) return;
    for (const line of lines.values()) line.alive = false;
    lines.clear();
    total = 0;
    storeData = data;
  }

  function dropLine(id: string): void {
    const line = lines.get(id);
    if (line === undefined) return;
    line.alive = false;
    total -= line.nodes.size;
    lines.delete(id);
  }

  const touch = (line: LineRec): void => {
    lines.delete(line.id);
    lines.set(line.id, line);
  };

  /**
   * Room for `count` more nodes in `line`: the lines used longest ago go first; 422 `TOO_BIG` when `line` alone would not
   * fit (the page knows it by its code, never its words; a node is a step on the page).
   */
  function reserve(line: LineRec, count: number): void {
    if (line.nodes.size + count > maxNodes) {
      throw new HttpError(422, `This tree is too big for the server to keep (over ${maxNodes} steps): clear it and start again`, 'TOO_BIG');
    }
    for (const id of [...lines.keys()]) {
      if (total + count <= maxNodes) return;
      if (id !== line.id) dropLine(id);
    }
  }

  function find(data: ServerData, lineId: string, nodeId: string): { line: LineRec; rec: NodeRec } {
    sync(data);
    const line = lines.get(lineId);
    const rec = line?.nodes.get(nodeId);
    if (line === undefined || rec === undefined) throw lost();
    touch(line);
    return { line, rec };
  }

  function depsOf(data: ServerData): LineDeps {
    if (depsFor?.data !== data) depsFor = { data, deps: opts.deps(data) };
    return depsFor.deps;
  }

  /** The AI's answer at `rec`, worked out once. Null where the AI does not act. */
  function aiOf(line: LineRec, rec: NodeRec): AiAnswer | null {
    if (rec.ai !== undefined) return rec.ai;
    return (rec.ai = aiAnswer(line.deps, line.labeler, rec.state, rec.memory));
  }

  const decides = (kind: string) => kind === 'turnChoice' || kind === 'playerMidTurnSwitch' || kind === 'playerReplacement';

  async function nodeJson(line: LineRec, rec: NodeRec): Promise<LineNodeJson> {
    if (rec.json !== undefined) return rec.json;
    await yieldNow();
    const { phase } = rec.state;
    const ai = aiOf(line, rec);
    const choices: LineChoiceJson[] | undefined = decides(phase.kind)
      ? line.deps.engine.legalChoices(rec.state, 'p1').map((choice) => ({ choice, label: line.labeler.choice(rec.state, 'p1', choice) }))
      : undefined;
    const damageFn = phase.kind === 'turnChoice' ? line.damageFor(rec.team) : null;
    const numbers = damageFn === null ? null : damageFn(rec.state);
    const view = line.deps.view(rec.state, line.labels);
    addExpToNext(line.deps, rec, view);
    const damage = numbers === null ? null : { ...numbers, against: view.player.active?.name ?? numbers.against };
    const json: LineNodeJson = {
      line: line.id, node: rec.id, turn: rec.state.turn, phase: phase.kind, dead: rec.dead,
      view,
      ...(damage === null ? {} : { damage }),
      ...(ai === null ? {} : 'error' in ai ? { aiError: ai.error } : { aiOdds: oddsJson(ai) }),
      ...(choices === undefined ? {} : { choices }),
      ...(phase.kind === 'terminal' ? { terminal: { winner: phase.winner } } : {}),
      unmodelled: plainUnmodelled(line.deps.engine.unmodelledIn(rec.state)),
      pathProbability: ratJson(rec.path), pathPercent: percentOf(rec.path), world: line.world,
      ...(line.worlds === undefined ? {} : { worlds: line.worlds }),
      ...(rec.id === 'root' && line.carried !== undefined ? { carried: line.carried } : {}),
    };
    rec.json = json;
    return json;
  }

  async function runExpand(line: LineRec, rec: NodeRec, choice: Choice | null, key: string): Promise<ExpandRecord> {
    const { deps } = line;
    const ai = aiOf(line, rec);
    if (ai !== null && 'error' in ai) throw aiUndefined(ai.error);
    const before = deps.view(rec.state, line.labels);
    const seedHp = new Map<string, { hp: number; maxHp: number }>();
    for (const [side, party] of [['p1', before.player.party], ['p2', before.enemy.party]] as const) {
      for (const m of party) seedHp.set(`${side}|${m.ident}`, { hp: m.hp, maxHp: m.maxHp });
    }
    const seed = {
      hp: seedHp, active: { p1: before.player.active?.ident ?? null, p2: before.enemy.active?.ident ?? null },
      name: (side: 'p1' | 'p2', ident: string) => (side === 'p1' ? line.idents.get(ident) ?? ident : ident),
    };
    const moveName = deps.moveName ?? ((id: string) => id);
    const actions = ai === null ? [{ choice: null, label: null, probability: ONE }] : ai.actions;
    const children: NodeRec[] = [];
    const outcomes: LineOutcomeJson[] = [];
    const ids = new Set<string>();
    let enemyFaints = ZERO;
    let death = ZERO;
    let enemyCrit = ZERO;
    for (const action of actions) {
      await yieldNow();
      let results;
      try {
        results = deps.engine.expandTurn(rec.state, { ...(choice === null ? {} : { p1: choice }), ...(action.choice === null ? {} : { p2: action.choice }) });
      } catch (error) {
        engineFailure(error);
      }
      for (const o of results) {
        const id = hash(`${o.state.key}|${o.observation}|${o.critBy.p1 ? 1 : 0}${o.critBy.p2 ? 1 : 0}|${action.choice === null ? '-' : choiceKey(action.choice)}`);
        if (ids.has(id)) throw new Error(`line: two outcomes of one step share the id ${id}`);
        ids.add(id);
        const probability = mul(action.probability, o.probability);
        const summary = summarizeLog(o.log, seed);
        const died = o.fainted.p1.length > 0;
        const node = hash(`${rec.id}|${key}|${id}`);
        const next = o.state.phase;
        children.push({
          id: node, parent: rec.id, via: { choice: key, outcome: id }, state: o.state, memory: deps.model.remember(rec.memory, o),
          dead: rec.dead || died || next.kind === 'playerReplacement', path: mul(rec.path, probability), team: rec.team, expansions: new Map(),
        });
        outcomes.push({
          id, node, probability: ratJson(probability), percent: percentOf(probability), aiAction: action.label, summary: summary.lines,
          endHp: summary.endHp,
          faints: {
            p1: o.fainted.p1.map((i) => line.labels[i] ?? `party member ${i + 1}`),
            p2: o.fainted.p2.map((i) => line.enemyNames[i] ?? `party member ${i + 1}`),
          },
          death: died, enemyCrit: o.critBy.p2, unlabelled: o.unlabelled,
          signature: signatureOf(action.label, summary.lines, o, died, [
            o.fainted.p1.map((i) => line.labels[i] ?? `party member ${i + 1}`), o.fainted.p2.map((i) => line.enemyNames[i] ?? `party member ${i + 1}`),
          ]),
          next: next.kind, ...(next.kind === 'terminal' ? { winner: next.winner } : {}),
          exp: expGains(o.log, { party: before.player.party }), rolls: rollsOf(o.labels, moveName),
        });
        if (o.fainted.p2.length > 0) enemyFaints = add(enemyFaints, probability);
        if (died) death = add(death, probability);
        if (o.critBy.p2) enemyCrit = add(enemyCrit, probability);
      }
    }
    if (!line.alive) throw lost();
    reserve(line, children.length);
    if (!line.alive) throw lost();
    for (const child of children) {
      if (line.nodes.has(child.id)) continue;
      line.nodes.set(child.id, child);
      total += 1;
    }
    const groups = new Map<string | null, Rational>();
    for (const o of outcomes) groups.set(o.aiAction, add(groups.get(o.aiAction) ?? ZERO, { num: BigInt(o.probability.num), den: BigInt(o.probability.den) }));
    const order = [...groups].sort(([an, a], [bn, b]) => cmpDesc(a, b) || (an ?? '').localeCompare(bn ?? ''));
    const rank = new Map(order.map(([label], i) => [label, i]));
    outcomes.sort((a, b) => rank.get(a.aiAction)! - rank.get(b.aiAction)! || cmpDesc(rat(a.probability), rat(b.probability)) || a.id.localeCompare(b.id));
    return {
      json: {
        line: line.id, node: rec.id, choice,
        groups: order.map(([aiAction, probability]) => ({ aiAction, probability: ratJson(probability), percent: percentOf(probability) })),
        outcomes,
        totals: { enemyFaints: ratJson(enemyFaints), death: ratJson(death), enemyCrit: ratJson(enemyCrit) },
      },
    };
  }

  /**
   * What `start` and `next` share once the fight and the team are known: each Pokémon's info (400 for one the resolver
   * lacks), the world (400), the battle (`battleInput` with `carry`, in `team`'s order; null starts each as `mons` has
   * it), the AI's first memory, the new line and its stored root.
   */
  async function open(o: {
    data: ServerData; deps: LineDeps; mons: ReadonlyMap<MonRef, PlayerMon>; resolver: BattleResolver; fight: FightInfo;
    team: MonRef[]; world: number; carry: CarryState | null; carried?: LineCarriedJson;
  }): Promise<LineNodeJson> {
    const { deps, fight } = o;
    const infos: MonInfo[] = o.team.map((ref) => {
      try {
        return o.resolver.mon(ref);
      } catch (error) {
        throw new HttpError(400, messageOf(error));
      }
    });
    const world = Number.isInteger(o.world) ? fight.worlds[o.world] : undefined;
    if (world === undefined) throw new HttpError(400, `world must be a whole number from 0 to ${fight.worlds.length - 1}`);
    let state: EngineState;
    let memory: AiMemory;
    try {
      state = deps.engine.createBattle(battleInput({ info: fight, team: infos, startStatus: {}, healBefore: false }, 0, o.carry, world));
    } catch (error) {
      if (codeOf(error) === 'UNSUPPORTED_DOUBLE') throw new HttpError(422, DOUBLE_TEXT);
      if (error instanceof RangeError) throw new HttpError(422, error.message, 'BAD_START');
      engineFailure(error);
    }
    try {
      memory = deps.model.initialMemory(state);
    } catch (error) {
      if (codeOf(error) === undefined) throw error;
      throw aiUndefined(`The AI's behaviour is undefined here (${codeOf(error)}: ${messageOf(error)})`);
    }
    const labels = infos.map((info) => info.label);
    const root = deps.view(state, labels);
    const line: LineRec = {
      id: randomBytes(9).toString('base64url'), data: o.data, deps, damageFor: damageFns(deps), labeler: deps.labeler(o.mons, o.team), fight, world: o.world,
      worlds: fight.worlds.length > 1 ? describeWorlds(fight, deps) : undefined, mons: o.mons, team: o.team,
      ...(o.carried === undefined ? {} : { carried: o.carried }), labels,
      idents: new Map(root.player.party.map((m) => [m.ident, m.name])), enemyNames: root.enemy.party.map((m) => m.name),
      nodes: new Map(), alive: true,
    };
    const rec: NodeRec = {
      id: 'root', parent: null, via: null, state, memory, dead: false, path: ONE, team: infos.map((info) => info.mon), expansions: new Map(),
    };
    // A data reload during the awaits before this emptied the store for the new data: a line built from the old one is lost.
    if (storeData !== o.data) throw lost();
    reserve(line, 1);
    line.nodes.set(rec.id, rec);
    lines.set(line.id, line);
    total += 1;
    return nodeJson(line, rec);
  }

  return {
    async start(q) {
      sync(q.data);
      const deps = depsOf(q.data);
      await yieldNow();
      const resolver = deps.resolver(q.mons);
      const fight = fightOf(resolver, q.trainerId, q.variant);
      if (q.team.length < 1 || q.team.length > MAX_TEAM) throw new HttpError(400, `team must hold 1 to ${MAX_TEAM} Pokémon`);
      if (new Set(q.team).size !== q.team.length) throw new HttpError(400, 'team lists a Pokémon twice');
      return open({ data: q.data, deps, mons: q.mons, resolver, fight, team: q.team, world: q.world, carry: null });
    },

    async next(q) {
      const { line: won, rec } = find(q.data, q.line, q.node);
      const { phase } = rec.state;
      if (phase.kind !== 'terminal' || phase.winner !== 'p1') throw new HttpError(422, NOT_WON_TEXT);
      await yieldNow();
      let carry: CarryState;
      try {
        carry = won.deps.engine.carryOut(rec.state);
      } catch (error) {
        throw new HttpError(422, `This fight's end cannot be carried over: ${messageOf(error)}`);
      }
      if (carry.mons.length !== won.team.length) throw new Error(`line: carryOut gave ${carry.mons.length} Pokémon for a team of ${won.team.length}`);
      const standing = carry.mons.flatMap((m, i) => (m.hp > 0 ? [i] : []));
      const dropped = carry.mons.flatMap((m, i) => (m.hp > 0 ? [] : [won.labels[i] ?? `party member ${i + 1}`]));
      const resolver = won.deps.resolver(won.mons);
      const fight = fightOf(resolver, q.trainerId, q.variant);
      const refs = standing.map((i) => won.team[i]!);
      if (q.lead !== undefined && !refs.includes(q.lead)) throw new HttpError(400, `lead must be one of the Pokémon that carry over: ${refs.join(', ')}`);
      const order = q.lead === undefined ? standing : [standing[refs.indexOf(q.lead)]!, ...standing.filter((i) => won.team[i] !== q.lead)];
      const entries = order.map((i) => carry.mons[i]!);
      const carryIn = q.heal
        ? entries.map((entry) => ({ ...entry, hp: FULL_CARRY, pp: entry.pp.map(() => FULL_CARRY), status: { kind: 'none' as const } }))
        : entries;
      return open({
        data: q.data, deps: won.deps, mons: won.mons, resolver, fight, team: order.map((i) => won.team[i]!), world: q.world,
        carry: { mons: carryIn }, carried: { fromLine: won.id, fromNode: rec.id, dropped },
      });
    },

    async node(data, lineId, nodeId) {
      const { line, rec } = find(data, lineId, nodeId);
      return nodeJson(line, rec);
    },

    async expand(data, lineId, nodeId, choice) {
      const { line, rec } = find(data, lineId, nodeId);
      const kind = rec.state.phase.kind;
      if (kind === 'terminal') throw new HttpError(422, 'The battle is over: there is nothing to expand');
      let key = '';
      let given: Choice | null = null;
      if (decides(kind)) {
        if (choice === undefined) throw new HttpError(400, 'choice is required: the player decides at this step');
        if (!line.deps.engine.legalChoices(rec.state, 'p1').some((c) => choiceKey(c) === choiceKey(choice))) {
          throw new HttpError(422, 'That choice is not legal here', 'BAD_CHOICE');
        }
        key = choiceKey(choice);
        given = choice;
      }
      let pending = rec.expansions.get(key);
      if (pending === undefined) {
        pending = runExpand(line, rec, given, key);
        rec.expansions.set(key, pending);
        pending.catch(() => rec.expansions.delete(key));
      }
      const { json } = await pending;
      if (!line.alive) throw lost();
      return json;
    },
  };
}

/**
 * The AI's answer in `state` with `memory`: at `turnChoice` its `support` (kind 'turn'), at `enemyMidTurnSwitch` and
 * `enemyReplacement` its `replacementSupport` (kind 'replacement'); null at any other phase. Each action is labelled by
 * `labeler` without its "Use " or "Switch to "; `odds` sums the actions by label, largest first, then by label. An error
 * with a string `code` (an `AiError`) is the answer's `error`; anything else propagates.
 */
export function aiAnswer(deps: LineDeps, labeler: PlanLabeler, state: EngineState, memory: AiMemory): AiAnswer | null {
  const kind = state.phase.kind;
  const mode = kind === 'turnChoice' ? 'turn' : kind === 'enemyMidTurnSwitch' || kind === 'enemyReplacement' ? 'replacement' : null;
  if (mode === null) return null;
  let support: ActionSupport[];
  try {
    support = mode === 'turn' ? deps.model.support(state, memory) : deps.model.replacementSupport(state, memory);
  } catch (error) {
    const code = codeOf(error);
    if (code === undefined) throw error;
    return { error: `The AI's behaviour is undefined here (${code}: ${messageOf(error)})` };
  }
  const actions = support.map(({ choice, probability }) => {
    const text = labeler.choice(state, 'p2', choice);
    return { choice, probability, label: text.replace(mode === 'turn' ? /^Use / : /^Switch to /, '') };
  });
  const merged = new Map<string, Rational>();
  for (const a of actions) merged.set(a.label, add(merged.get(a.label) ?? ZERO, a.probability));
  const odds = [...merged].map(([label, probability]) => ({ label, probability }))
    .sort((a, b) => cmpDesc(a.probability, b.probability) || a.label.localeCompare(b.label));
  return { kind: mode, actions, odds };
}

/** An AI answer's odds as the page reads them. */
export function oddsJson(ai: Extract<AiAnswer, { kind: string }>): LineAiOddsJson {
  return { kind: ai.kind, choices: ai.odds.map((o) => ({ label: o.label, probability: ratJson(o.probability), percent: percentOf(o.probability) })) };
}

const rat = (r: LineRationalJson): Rational => ({ num: BigInt(r.num), den: BigInt(r.den) });

/** Descending order of probabilities: negative when `a` is larger. */
const cmpDesc = (a: Rational, b: Rational): number => {
  const d = b.num * a.den - a.num * b.den;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

/** Each world by its disputed values ("Geodude: Jolly"), the trainer's Pokémon by name. */
export function describeWorlds(fight: FightInfo, deps: LineDeps): LineWorldJson[] {
  return fight.worlds.map((world, index) => {
    const parts = world.enemy.flatMap((entry, i) => {
      const values = [
        ...(entry.nature === undefined ? [] : [NATURES[entry.nature] ?? `nature ${entry.nature}`]),
        ...(entry.ability === undefined ? [] : [deps.abilityName(entry.ability)]),
      ];
      return values.length === 0 ? [] : [`${fight.trainer.party[i]?.name ?? `Pokémon ${i + 1}`}: ${values.join(', ')}`];
    });
    return { index, label: parts.length === 0 ? `World ${index + 1}` : parts.join('; ') };
  });
}

/** The damage-number function for each team array a line's nodes have, made once per array (see `LineDeps.damage`). */
export function damageFns(deps: LineDeps): (team: PlayerMon[]) => ((state: EngineState) => LineDamageJson | null) | null {
  if (deps.damage === undefined) return () => null;
  const made = new WeakMap<PlayerMon[], (state: EngineState) => LineDamageJson | null>();
  return (team) => {
    let fn = made.get(team);
    if (fn === undefined) {
      fn = deps.damage!(team);
      made.set(team, fn);
    }
    return fn;
  };
}

/**
 * The player's party in `view` gets `expToNext` when the deps can work it out (`LineDeps.expToNext`): each one's EXP in the
 * state (`carryOut`) at its level in the view; null where the engine gives no EXP. Without the deps, nothing is added.
 */
function addExpToNext(deps: LineDeps, rec: NodeRec, view: LineViewJson): void {
  if (deps.expToNext === undefined) return;
  const carry = deps.engine.carryOut(rec.state);
  view.player.party.forEach((m, i) => {
    const exp = carry.mons[i]?.exp;
    const mon = rec.team[i];
    m.expToNext = exp === undefined || mon === undefined ? null : deps.expToNext!(mon, m.level, exp);
  });
}

/** An outcome's `signature` (see `LineOutcomeJson`): its AI action, summary, faints by name, crits and death. */
function signatureOf(aiAction: string | null, summary: string[], o: { critBy: { p1: boolean; p2: boolean } }, died: boolean, faints: [string[], string[]]): string {
  return [aiAction ?? '-', summary.join(' / '), `p1 fainted: ${faints[0].join(', ')}`, `p2 fainted: ${faints[1].join(', ')}`, `crit ${o.critBy.p1 ? 'p1' : ''}${o.critBy.p2 ? 'p2' : ''}`, died ? 'death' : 'safe'].join(' | ');
}
