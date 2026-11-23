# What-if levels

The player, 2026-11-09: "In plan mode I want to be able to add levels to my Pokémon to check the line if they are higher
level."

A what-if level raises one of the player's Pokémon to a higher level for planning only, and nothing touches the save.

## Where it stands

- The page has no level controls. It clears the old Fight view's browser key (`pkp.whatIfLevels`), and
  a line kept with what-if levels no longer opens.
- No route takes a `levels` parameter: the line start and the sheet's routes dropped it. A level
  before a fight is set in the draft, which the sheet, its AI odds and the line start all read through one path.

## The rule

At a what-if level L, a Pokémon is `toPlayerMon`'s Pokémon with:
- `level` L, and every stat recomputed with `computeStats` (src/rom/stats.ts) from its own base stats, IVs, EVs and
  nature at L (EVs stay the save's; real level-ups would usually add some, so the what-if is slightly pessimistic);
- max HP the new formula value, and current HP raised by the max HP gained (as the cartridge does on a level-up); a
  starting HP of "full" still means full;
- the same moves, PP, item, ability, status and friendship: no level-up moves are learned and nothing evolves.

One pure function, `atLevel(mon: PlayerMon, level: number, …): PlayerMon` in `src/battle/playerMon.ts`, with whatever
it needs from the data passed in, is the only place this rule lives; every route uses it.

## Server

- The draft: a team entry's `level` is applied with `atLevel` (`applyDraft`, src/server/draft.ts), with the draft's own
  checks. `POST /api/sheet` and `POST /api/sheet/ai/stream` take `{ trainer, variant?, team, draft }`, and
  `POST /api/line/start` `{ trainerId, variant?, team, world?, draft }`; all three read it through one
  function, `draftedFight` (src/server/app.ts), so the sheet, its AI odds and the line start fight the same Pokémon. A
  level, HP or status before the fight is set in the draft; none of the three takes `levels`.
- A sheet body with `levels` (or `hp`) is a 400, "levels is not part of a sheet request"; a line start body with
  `levels`, `hp` or `startStatus` is a 400 saying to reload the page. The `GET` sheet routes, which took `levels` in the
  query string, are gone (a 405 naming `POST`; `/api/sheet/ai` is no route).
- The sheet AI's cache key holds each drafted team member whole, so an answer for another level is never reused.
- The split bench's plan request (`src/integration/planRequest.ts`, no route now) carries `levels` for refs
  of its team or pool, read and checked by `src/server/levels.ts`: a level outside the save's level to 100, a ref not
  in the team or pool, or a ref twice is refused with the reason. The real solver builds the solve's `mons` map with the
  levelled Pokémon (`levelledMons`), which reach every worker through the solve's worker context
  (src/integration/contextDeps.ts).

## Tests

- Unit: `atLevel` against `computeStats` and against a real save Pokémon whose stats at its own level match the save
  (`atLevel(mon, mon.level)` returns equal stats), HP gained on a level-up, `full` HP mode.
- Unit: a draft's level changes the sheet (app.test.ts) and misses the sheet AI's cache (sheetAi.test.ts and the
  stream in app.test.ts); the sheet's routes and the line start refuse a body with `levels`; the plan request's
  `levels` (levels.test.ts).
- Real: one sheet and one line start for Youngster Tristan over the frozen save with a team Pokémon two levels up,
  its stats equal to `computeStats` at that level.
- No e2e test.
