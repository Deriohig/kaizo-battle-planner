# Wiring the solver to the real engine and AI

This page is for the server and the page. It lists what has to be built around the
solver (`src/solver`) before it can run on real data instead of the toy game in `test/unit/solver/toy/`. The
solver is written against the contracts only (`src/contracts/{engine,ai,solver}.ts`). It never imports `src/engine` or
`src/ai`, so all of the wiring below belongs to the integration. How the solver itself works is in
`docs/solver-design.md`.

## 1. The entry point

```ts
import { createSolver, type SolverDeps } from 'src/solver/index.js';

const solver = createSolver(deps);                        // implements Solver from src/contracts/solver.ts
const verdict = await solver.solve(request, onProgress, signal);
```

`SolverDeps` (`src/solver/types.ts`):

```ts
export interface SolverDeps {
  engine: Engine; enemyModel: EnemyModel; resolver: BattleResolver;
  oracles: { damage: DamageOracle; speed: SpeedOracle };
  labeler?: PlanLabeler; orderHint?: OrderHint;
  teamScore?: (team: MonRef[], fights: FightInfo[]) => number;   // higher = more promising
  now?: () => number;                                            // default performance.now
  config?: Partial<SolverConfig>;
}
```

The integration builds every one of these. Without `labeler` the solver falls back to `defaultLabeler`, which knows no
names ("Use move 1", "Switch to party 2"), so the page needs a real one (section 6).

## 2. A `BattleResolver` over the save and the battle data

These are the exact shapes (`src/solver/types.ts`):

```ts
/**
 * `status`: the save's status (box mons 'none'). `fullPp`: each limited-PP move's max PP including PP Ups, in
 * CarryState.pp order (what a heal restores; inputs.ts healedCarry).
 */
export interface MonInfo { ref: MonRef; mon: PlayerMon; maxHp: number; fullPp: number[]; status: StartStatus; label: string; preStatusCandidates: StartStatus[] }

/**
 * `worlds` has at least one entry ([{ enemy: [] }] when nothing is disputed). `benchMonotone`: no Roar/Whirlwind and no
 * AI read of the player's bench.
 */
export interface FightInfo { spec: FightSpec; trainer: ResolvedTrainer; field: FieldSpec; worlds: WorldAssignment[]; label: string; benchMonotone: boolean }

/** Both methods throw Error for an unknown id. */
export interface BattleResolver { mon(ref: MonRef): MonInfo; fight(spec: FightSpec): FightInfo }
```

`mon(ref)`, for `'party:<slot>'` or `'box:<box>:<slot>'`:

- `mon`: the `PlayerMon` from the save.
- `maxHp`: the HP stat from `computeStats(baseStats, ivs, evs, level, nature)` (`src/rom/stats.ts`). The solver uses it
  for the healed carry and for the HP fractions in the ranking.
- `fullPp`: each move's max PP including PP Ups, in `CarryState.pp` order (the limited-PP moves in move-slot order,
  which in the real game is every move slot). The solver uses it to build the healed carry after a "heal here" gap
  (`FightSpec.healBefore`): full HP, full PP and no status. The engine is always given an explicit carry. Without one it
  would start from the save, so a heal is never "no carry".
- `status`: the save's status for a party mon, `{ kind: 'none' }` for a box mon.
- `label`: the name the page shows (nickname, or species). Plan labels use it ("Lead with Staravia"), as do the
  team-search lines ("Team Staravia, Machop: …") and the pre-status line.
- `preStatusCandidates`: the statuses the solver may propose for this mon when the request says `preStatus: 'propose'`. Pre-sleep is always counter 1,
  and the solver rewrites any sleep candidate to `{ kind: 'sleep', turns: 1 }` itself.

`fight(spec)`:

- `spec`: a copy of the request's `FightSpec`.
- `trainer`: the `ResolvedTrainer`. `FightSpec.variant` 0 (the default) is the trainer as the catalog resolves it (the harder copy); k ≥ 1 is `trainer.variants[k-1]`, as the server already uses it. The solver never reads
  `variant` itself: the resolver has to apply it.
- `field`: the battle's `FieldSpec` (weather, fog and so on) for the trainer.
- `label`: the fight's name in messages ("Gym Leader Roark").
- `benchMonotone`: true only when no enemy Pokémon has Roar or Whirlwind (or any other move that drags in a random
  bench member) and no AI command reads the player's bench or party. When it is true, the team search
  tries only full-size teams and may rule out subsets of a disproved team. Get it wrong and a team search can skip a
  team that works. When in doubt, use false: every team size is then tried.
- `worlds`: see below.

### Worlds from `Sourced<T>.alternatives`

`src/battle/types.ts` marks disputed enemy data:

```ts
export interface Sourced<T> { value: T; source: 'rom' | 'docs'; disputed: boolean; alternatives: T[] }
```

For each enemy party index i, take the nature candidates (`value` plus `alternatives`) and the ability candidates. Then
collapse candidates that give identical proof-relevant numbers: the five neutral natures give identical stats and count
as one, and so do natures that differ only in a stat the mon never uses. Judge that conservatively: if anything in the
battle could read the stat, keep both natures. Take the product over the enemy party to get one `WorldAssignment` per
combination (`{ enemy: [{ nature?, ability? }, …] }`, indexed by p2 party index). Use `[{ enemy: [] }]` when nothing is
disputed. The solver proves every world: in display mode, the player's plan must work in all of them without knowing which
one is real. It refuses a fight with more than `maxWorlds` worlds (default 64, decision solver-018) as
`unproven: unsupportedBattle`, with a detail saying an in-game spot check settles them. Collapsing is what keeps real
fights under the cap.

## 3. The engine

The integration point:

```ts
import { showdownEngine, installKaizoDex } from 'src/engine/index.js';
import { buildMoves } from 'src/battle/moves.js';

installKaizoDex(data, buildMoves(data));   // once per thread, before the first createBattle (and before reading .id)
deps.engine = showdownEngine;
```

- `installKaizoDex(data: LoadedData, moves: Map<number, KaizoMove>)` installs the Kaizo mod into Showdown's dex. The
  install is per thread, so the deps module's `createDeps()` must call it in every worker thread (section 8).
  `showdownEngine.id` throws until a mod is installed, and every report lists the engine id.
- Interim behaviour. Until the engine labels its outcomes, every outcome is `unlabelled`. Until its move behaviours are table-driven, `unmodelledIn` flags most battles (`INTERIM_BEHAVIOURS_NOTE`, "engine: move behaviours not yet table-driven"). Real
  verdicts therefore read `unproven: unmodelled` with the line as `best`. That is the correct behaviour: the solver
  never calls a battle safe while the engine says it does not model it. It is not a bug to work around.
- After a double KO at `playerReplacement`, the engine's `expandTurn` wants both sides' choices. The solver never
  continues past `playerReplacement`: reaching it is a death.

The solver relies on these engine properties:

- `carryOut(state)` lists p1 in battle-start order (`BattleInput.player`, lead first), whatever switches happened. The
  solver puts the lead first when it builds the input and maps the carry back by that order (`src/solver/inputs.ts`
  `toCanonicalCarry`). An engine that reorders by party position after switches would scramble gauntlet carries.
- `EngineState.key` is exact: equal keys mean identical futures, including which mon is in which party slot. The
  solver's transposition table and edge cache trust it completely (joined with the AI memory key).
- `EngineState.json` holds no wall-clock value: it is a pure function of the state and the step that made it, so the
  same state gives the same bytes on any thread, in any second. The independent checker never trusts the search's
  key: it remembers states, and finds cycles, by these bytes (`src/solver/check/checker.ts`). Showdown writes the time
  into the battle log on every step (`|t:|<seconds>`, from `Date.now`), and a snapshot keeps the step's log, so the
  engine blanks those lines to `|t:|` in every state it returns, the battle start's included (`src/engine/battle.ts`
  `untimedLog`, as Showdown's own `State.normalizeLog` does; the key already left the log out, so no key changed and
  `ENGINE_REVISION` stayed 14). Before that, the checker's counts depended on which second each state was reached in,
  and the main thread's re-check of a worker's line reported a false verification mismatch (fixed
  2026-11-09). The checker blanks `|t:|<digits>` itself too, as a second guard, but no other clock, counter or random
  value may appear in `json`.
- Each `expandTurn` call's outcome probabilities sum to exactly 1 (the arena throws otherwise). Every `Outcome` with
  `fainted.p1` non-empty is a death, and so is `terminal` with winner p2.
- Errors are recognised by `code`. `UNSUPPORTED_DOUBLE` makes the verdict `unproven: unsupportedBattle`. `LIMIT` (over
  `maxLeaves`) fails that path as an engine limit (unproven, never refuted). `UNMODELLED_ITEM` at battle start is
  unmodelled. `BAD_CHOICE` during checking is a verification mismatch, and during search it is a bug that propagates.
- `CarryState.pp` lists the limited-PP moves in move-slot order, as `MonInfo.fullPp` does.

## 4. The enemy model (AI)

`EnemyModel` (`src/contracts/ai.ts`) gives `support` and `replacementSupport` with exact `Rational` probabilities, each
greater than 0 and summing to exactly 1. The arena and the checker both throw otherwise. Where the cartridge's behaviour
is undefined, the AI throws an `AiError`. The solver treats any error with a string `code` (`'UNDEFINED'`,
`'DIV_ZERO'`, …) as an unlabelled node: the verdict reads unmodelled, with the code and message in the detail. It is
never a crash and never safe. An error without a string code propagates. `AiMemory.key` must be canonical, because the
solver joins it to the state key.

## 5. Oracles

The checker cross-checks every engine step it replays through two oracles (`src/solver/types.ts`):

```ts
export interface StepContext { before: EngineState; choices: { p1?: Choice; p2?: Choice }; outcome: Outcome }
export interface OracleResult { checks: number; mismatches: string[]; skipped?: Record<string, number> }
export interface DamageOracle { readonly id: string; check(step: StepContext): OracleResult }
export interface SpeedOracle { readonly id: string; check(step: StepContext): OracleResult }
```

Any mismatch makes the verdict `unproven: verificationMismatch`, so an oracle must only report real disagreements.
`checks` counts what was actually compared. The report shows the totals.
`skipped` (the damage oracle only): an oracle that passes over a damaging hit, for whatever reason, counts it
here under the move's display name instead of in `checks` (left out when there are none), and the checker sums it per
outcome it walks (every world and branch) into the report's `verification.notCrossChecked`.

- `DamageOracle`: read the outcome's `|-damage|` lines (`Outcome.log`) and compare each with an independent
  calculation: `gen4Damage` or `damage()`
  (`src/calc/calc.ts`). A `damage()` result with `bounded: false` means "cannot verify": count no check for it and
  never compare it as a number. An OHKO move's `koChance` is conditional on hitting.
- `SpeedOracle`: read the `|move|` order in the log and compare it with the sheet's speed code (`src/sheet/speed.ts`:
  `speedOrder`, `effectiveSpeed`, with priority and Quick Claw / Custap first, as the sheet does). Count no check where
  the order genuinely depends on a chance event the outcome's labels name (a speed tie, Quick Claw).

## 6. A `PlanLabeler` naming moves and Pokémon

```ts
export interface PlanLabeler {
  choice(state: EngineState, side: Side, choice: Choice): string;      // "Use Close Combat", "Switch to Staraptor"
  outcome(outcome: Outcome): string;                                    // "If Rock Slide crits"
  killCause(outcome: Outcome, turn: number): string;                    // "enemy crit Rock Slide on turn 3 kills Staravia"
}
```

The plan tree, the refutation lines in `rejectedTeams` and the checker's killers all use the labeler. The rules below
are the contract's label conventions (comment above `PlanNode` in `src/contracts/solver.ts`), plus what the solver
does with the text:

- `choice`, for both sides. It must start with `Use ` (a move or a bag item: "Use Rock Slide", "Use Full Restore") or
  `Switch to ` ("Switch to Staraptor"). For the player's actions the text is the player node's `actionLabel`. For the AI, the
  plan tree strips that prefix and writes "If the AI uses Rock Slide", "If the AI uses a Full Restore", "If the AI
  switches to Golbat", or "If the AI sends in Golbat" for a replacement (and ", then the AI sends in Golbat" after an
  outcome label). The lead at a fight's entry is labelled by the solver itself: "Lead with <MonInfo.label>".
- `outcome` returns the chance branch label exactly as the page shows it, written as a condition: "If Rock Slide
  crits", "If Rock Slide hits, no crit", "If Rock Slide rolls 22–24", "If Staravia moves first (speed tie)". Return `''`
  when the outcome has no labels (a single sure outcome). The solver passes an outcome whose `labels` are every chance
  label on the settled path, so one label can name a whole turn. Branch labels must be unique among siblings. The
  solver adds " (2)" to repeats, but distinct events should read differently in the first place.
- `killCause(outcome, turn)` names the step that kills, where `turn` is the fight's turn number: "enemy crit Rock Slide
  on turn 3 kills Staravia", "Rock Slide on turn 3 kills Staravia". Use the victim's name (from `outcome.fainted.p1` and
  the state) and the killing move (the last p2 label, or the log). The contract's tier-3 form ("<Move> misses on turn
  <n>, then …") cannot be built from these inputs: the labeler sees only the killing step, not the earlier miss.
  Killers are summed per cause text, so two different deaths must not share one.

## 7. An `OrderHint` and `teamScore` from the matchup sheet

```ts
export type OrderHint = (state: EngineState, choices: Choice[]) => Choice[];   // likely-safe first; a permutation of `choices`
teamScore?: (team: MonRef[], fights: FightInfo[]) => number;                   // higher = more promising
```

Both may read the matchup sheet (`src/sheet/sheet.ts` `buildSheet`) to try likely-safe moves first, or likely
teams first. They only change the order of the search: `OrderHint` must return every choice it was given, and
`teamScore` never removes a team. Never treat a `'depends'` turn order, a `'tie'` or an unbounded cell (`bounded: false`)
as a fact, even for ordering decisions that look like pruning. A bad order costs time, and a dropped choice would cost
proofs. The solver's other hint is its history of choices that already won, which it tries first.

## 8. A deps module for workers

With `config.threads > 1`, `createSolver` runs the solve's jobs on worker threads (`src/solver/parallel/`) when it has
somewhere to run them. Otherwise everything runs in-process. The results are the same either way:
`test/unit/solver/parallel.test.ts` checks them on the toy.

- **A pool of its own.** With `config.depsModule` set and no `deps.pool`, the solve opens a pool of `threads`
  workers and closes it when the solve ends. This is the behaviour from before the shared pool.
- **A shared pool.** `createSolverPool({ threads, depsModule, execArgv? })` (exported from `src/solver`) makes a pool
  that outlives solves. Pass it as `SolverDeps.pool`:
  - The solve's jobs run in a lane of their own, at most `min(config.threads, pool.size)` at once. The team search's
    window is that width too.
  - The solver never closes the pool. When the solve ends it closes only its lane: anything of the solve's still
    queued or running is rejected.
  - `config.depsModule` is not used; the pool has its own.
  - A solve with `threads: 1` still runs in-process.
  - Jobs of different solves queue rather than collide. A cancel terminates only the workers busy with that solve's
    jobs; other solves' jobs run on.
  - `pool.warm(context)` starts every worker now, each building its deps for `context` before any job. From then on,
    a worker terminated by a cancel or lost to a crash mid-job is replaced at once. A worker that dies idle (at start,
    or while warming) is replaced only when a job needs one, so a worker that cannot start is never restarted in a
    loop.
  - A replacement warms itself with the last good context: warm's, or that of the latest job that succeeded. A
    context none of whose jobs has succeeded, such as one whose deps build kills the worker, never warms one.
  - A queued job whose signal has aborted is never sent to a worker. Cancelling a solve with queued jobs therefore
    costs no extra warm worker, and aborting a job that only waited in the queue restarts no worker that died idle.
  - `pool.drain()` is for a pool its owner is letting go while a solve still runs on it (`createRealSolver`'s pool of
    an older data version). Nothing refills the pool from then on, its idle workers are terminated at once, and its
    busy ones finish their jobs. A queued job that needs a worker may still start one, as on a pool never warmed.
  - `pool.close()` rejects anything left and resolves once every worker has exited. `pool.size` is the thread count
    and `pool.busy` the workers running a job now.
- **The worker context.** `SolverDeps.workerContext` is `{ key: string; value: unknown }`, a structured-cloneable
  per-solve payload. It travels with every job, so per-solve data never goes in the module URL or the environment:
  - A worker calls the module's `createDeps(value)` once per distinct `key` and keeps the deps of the 2 most recently
    used keys. Two overlapping solves can then share a worker without rebuilding.
  - A build that fails (rejects or throws) fails the jobs waiting on it and is not kept: the next job with that key
    builds again, so a transient error never sticks to a worker.
  - Without a context, a worker calls `createDeps()` once, with no argument, as before.
  - A worker started for a job warms itself with that job's context.

The deps module is a file that exports `createDeps(context?)`:

```ts
// src/integration/workerDeps.ts (the integration's file: createRealSolver's SolverPool's depsModule)
import { DEFAULT_ENGINE_MODE } from '../engines/select.js';
import { contextDeps } from './contextDeps.js';
import { readBaseDeps, solverDeps } from './deps.js';

// createDeps(context?): context = { dataDir, dataVersion, fingerprint, mons, engine, counters } (realSolver.ts).
// readBaseDeps loads the data from dataDir (refusing a folder whose bytes are not the fingerprint's), installs the Kaizo
// dex in this thread (before any createBattle) and makes the trainer AI; contextDeps keeps that base per
// dataDir|dataVersion (the current one only) and builds solverDeps(base, new Map(mons), { mode, counters }) per
// context: the engine (the engine selector's, in the context's mode, counted into the shared counters), AI, resolver,
// oracles, labeler, order hint and team score, as the server's thread builds them.
export const createDeps = contextDeps((dir, _version, fingerprint) => readBaseDeps(dir, fingerprint), (base, mons, context) =>
  solverDeps(base, mons, { mode: context.engine ?? DEFAULT_ENGINE_MODE, ...(context.counters === undefined ? {} : { counters: context.counters }) }));
```

- Each worker imports the module once and calls `createDeps()` once (a promise is awaited), or `createDeps(value)` once
  per context key, so it builds its own engine, AI, resolver and tables. Memory grows with the thread count. Nothing is
  shared with the main thread except the jobs, their contexts and their results.
- The module may keep its own heavy cache across contexts. The integration's module (`src/integration/workerDeps.ts`)
  does:
  - Its context is `{ dataDir, dataVersion, fingerprint, mons, engine, counters }`: `engine` is the engine mode the
    main thread resolved for the solve (absent means `showdown`), and `counters` the real solver's
    step counters, one `SharedArrayBuffer` that a structured clone shares, so every thread adds to the same cells
    (absent means nothing is counted). The key is `<dataVersion>:<mode>:<SHA-256 of mons>`, so a worker builds
    separate deps per mode, and an engine change needs no new pool.
  - It loads the base once per `dataDir|dataVersion`, keeping only the current one: the data, the dex install and the
    trainer AI, 2–8 s and about 140–250 MB per thread.
  - It builds `solverDeps(base, new Map(mons), { mode, counters })` per context; `contextDeps` hands the whole
    context to the builder as its third argument.
  - `createRealSolver` owns one shared pool per data version and warms it on `warm()`, which the split bench calls
    before it times anything.
- The module must not rely on main-thread state. A worker inherits `process.env` as it was when the worker started
  (the toy's `createDeps()` reads `SOLVER_TOY_SCENARIO` this way, so it serves only a pool of its own). Which save to
  read must come from the worker context, the module itself or the environment. With a shared pool, only the context
  changes per solve.
- Every thread must build the same deps. Workers rebuild a job's fights from its request and team refs with their own
  resolver, and the main thread re-checks their lines with its own deps, so the resolver, engine, AI and oracles must
  give the same answers for the same refs and specs in every thread. The save and data the main thread was built from
  must be the ones the workers load.
- The main thread's resolved config travels with every job, so the worker's `deps.config` is ignored. Its `now` is used
  for the job's deadlines, which arrive as time left.
- `config.depsModule` is an absolute path, a path relative to the working directory, or a `file:` URL.
  `config.workerExecArgv` defaults to `['--import', 'tsx']`, so workers can load `.ts` (the pool starts `worker.ts`, or
  `worker.js` once built; built code can pass `[]`). A worker that cannot load the module, or a `createDeps()` that
  throws, makes `solve` reject with that error. It never produces a verdict.
- `config.threads` defaults to `os.availableParallelism()` (12 on the player's machine). Workers start lazily, about
  0.1–0.15 s each on the toy with tsx, and only as many as the jobs need, unless a shared pool was warmed.
- A worker that crashes or exits fails its job, which fails the solve. The pool starts a fresh worker when the next
  job needs one, or at once on a warmed pool.

What runs where:

- Fixed team: one job per lead, with `restrictRoot` set to that lead (at most 6 jobs). The main thread re-checks the
  leads' lines with the checker, best first, until one passes, which is the line shown (a lead with no line, or a line
  ranked below it, is not re-checked). Each re-check compares its result with the worker's own check, which the job
  sends back (`JobResult.check`): a difference in a verdict-relevant result or in the (deterministic) counts is a
  disagreement; a check cut short on either side is a timeout, never compared; each re-check gets its own time allowance (at least 2 s, or twice the worker's
  check time). A line whose re-check is cut short or disagrees is never chosen (`docs/solver-design.md`, item 21).
  The best lead is chosen by the in-process rules, with ties going to the lower lead index. The main thread also makes
  the root's `unmodelledIn()` check over every lead. A lead plus a first move is not split: `restrictRoot` applies only
  at the entry node, so a first-move split needs the restriction applied below it (follow-up). A single lead therefore
  gets no speed-up.
- Team search: up to the solve's width of candidates in flight (`threads`, or `min(threads, pool.size)` on a shared
  pool), handled in candidate order, so the shown team and
  `rejectedTeams` match in-process. A proven team's full solve runs on the main thread. Each Phase B run from a worker
  that has a line to show is re-checked on the main thread before it is compared, by the same rules (one that fails is
  that team's unproven run). The pre-status
  variants are root splits.
- A job that fails (a worker crash, a `createDeps()` that throws, a result that cannot be sent back) cancels every other
  job of the solve at once, and `solve` rejects with that error.
- The main thread's event loop. In-process mode blocks it for the whole solve: progress callbacks still fire (from
  inside the search), but an HTTP cancel cannot be handled until the solve returns. Aborting from inside `onProgress`
  does work. In parallel mode the main thread waits while workers search, so cancels land at once: the workers
  running the solve's jobs are terminated (on a shared pool, only those) and the verdict is `unproven: timeout` with
  detail `cancelled`. The server should therefore run real solves
  in parallel mode. The exceptions are the main-thread steps, during which a cancel waits:
  - The root check (`unmodelledIn()` of each lead's first states): short.
  - A team search's full solve of a proven team: as long as that solve.
  - The re-checks, which are not always short. Each re-check of a line can run until the later of the checker's
    deadline and its start plus its allowance (the larger of 2 s and twice the worker's own check time, which is about
    one worker check: 2–3 s on the real engine for Youngster Tristan). In a root split the re-checks stop after the
    first that passes, disagrees, or is cut short past the checker's deadline, so at most one runs out its allowance:
    the split's re-checks end by max(checker deadline, that re-check's start + its allowance). The team search
    re-checks each Phase B run from a worker as it settles, each with that bound of its own (at most the solve's width
    of runs are in flight at once).

## 9. The horizon against the measured throughput

Measured 2026-11-08 on the toy, in-process, one thread (AMD Ryzen 5 3600X, Node 22.23.2 in WSL2). Two runs each; nodes
are the search's decision beliefs and leaves are the engine outcomes generated (`report.turnExecutions`):

| Toy fight | Horizon | Nodes/s | Leaves/s | Notes |
|---|---|---|---|---|
| `slowStall` (no chance, one 1,000-turn line) | 1,000 | 74,000–78,000 | 220–230 | nearly every expansion is an edge-cache hit |
| a branching 1v1 (four rolls, crits and misses on both sides, two moves) | 12 and 25 | 300–390 | 12,700–14,700 | about 50 leaves per node |

The toy engine is trivial, so about 70 µs per leaf is the solver's own overhead (beliefs, hashing, exact rationals).
Early estimates put Showdown at 300–2,200 leaves/s per thread (unmeasured), so on the
real engine the engine dominates, and a fight costs roughly `N · w · s · L` leaves.

The server sent `horizonTurns: 50`, and the split bench still does (`DEFAULT_HORIZON_TURNS` in
`src/integration/planRequest.ts`), while the solver's own default is 25. The horizon is a cap:

- Tier 1 deepens one turn at a time and stops at the first horizon that proves, so a fight won in 6 turns costs the same
  at 50.
- A fight that fails only on the horizon (a stall, a heal loop) deepens all the way to 50. Each deeper step searches
  again: a horizon failure is reused only at a horizon no larger than its own.
- Ranking works within the request's horizon, and so do tiers 2 and 3, so their cost grows with it.

50 is reasonable as a cap. Expect "unproven: timeout" rather than wrong answers when it is too costly. Very long lines
(hundreds of turns) can overflow the stack in plan rendering: the 1,000-turn `slowStall` line does. 50 turns per fight
is far from that.

## 10. Contract additions

Accepted additions to the contracts, used by the solver:

- `guaranteeDeathProbability?: Rational` on tier 2 and 3 verdicts: the worst case over the AI's support, maximised over
  worlds.
- `VerdictBase.preStatusBaseline?` (the result without the proposed pre-status) and `VerdictBase.entries?` (a gauntlet's
  entry ranges).
- `PlanLeaf.result` `'truncated'` (a display cut, separate from the horizon's `'cutoff'`), and the `PlanNode` label
  conventions.
- `createSolver(deps: SolverDeps): Solver` exported from `src/solver/index.ts`, with `SolverDeps` in
  `src/solver/types.ts`.
- `FightSpec.variant` indexing and `horizonTurns: 50` from the server. `Choice` items gain `consumeSlots?` (no solver
  impact).
- The `AiError` note (main 9dd9938): any error code is unproven.

Open points from this plan:

- `KillBranch.cause`'s tier-3 form ("<Move> misses on turn <n>, then …") needs more than `killCause(outcome, turn)`
  receives (section 6). Either the labeler gets the path, or the contract comment drops that form.
- `Progress` carries one node count. In parallel mode it adds up every worker's nodes, but it has no field for how many
  jobs are in flight.

## 11. Known limitations

- **No level-2 badge in RAM mode.** Level-1 and level-2 observation keys differ there, so no certificate passes both.
- **Worlds are weighed evenly in tiers 2 and 3.** With more than one world, a tier-3 line is "best found", not proven
  optimal. The checker's figures still take the worst world.
- **No-goods prune nothing yet.** A bench-monotone search tries only full-size teams. The code is there for a later
  search over participant sets.
- **No mid-fight level-ups and no experience between fights.** This can only underrate the team.
- **Doubles are refused** (`unproven: unsupportedBattle`), and so are fights with more than `maxWorlds` worlds.
- **The crit budget is counted in steps.** A step with several enemy crits counts as one.
- **Plan trees are cut at 20,000 nodes** for display (`truncated`). The certificate still covers every branch.
- **The root split is by lead only** (section 8). A one-lead fight runs as one job.
- **A split lead may be more cautious than in-process.** In-process merges the tier-1 failure reasons of all leads.
  The split judges each lead alone, so a lead whose own failure was no refutation (only something unmodelled or an
  engine limit) stays unproven even when another lead's failure was a refutation. The split never claims more than
  in-process.
- **Report counts differ in parallel mode.** Nodes, turn executions and the AI-support count add up every lead's
  search, which repeats some work, and the table counts are the chosen lead's. Everything else in the verdict is the
  same as in-process.
- **Very deep lines** (hundreds of turns) can overflow the stack in plan rendering (section 9).
