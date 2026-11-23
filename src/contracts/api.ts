// HTTP contract between the server (`src/server`) and the page (`web/`). Types only.
//
// JSON rules: a `Rational` travels as the string "num/den"; bigint never appears in JSON. Errors are
// `{ error: string }` with a 4xx/5xx status. All routes are under /api.
//
// Local only: every /api request needs `Host: 127.0.0.1:<port>` or `localhost:<port>` (else 403; the Vite dev proxy
// sends it with `changeOrigin`), and a PUT or POST needs `Content-Type: application/json` (else 415; `fetch` sends a
// string body as text/plain unless the header is set).

import type { Stats } from '../rom/types.js';
import type { Choice } from './engine.js';
import type { MonRef } from './solver.js';

/**
 * A stable reference to one of the player's Pokémon: 'party:<slot>' or 'box:<box>:<slot>' (`monRef` in `src/server/box.ts`).
 * The solver contract's own alias, passed on rather than declared again: `src/contracts/index.ts` re-exports this file
 * and `solver.ts` both, and two declarations of one name there do not compile. A type only: nothing of the solver loads.
 */
export type { MonRef };

export type RationalJson = string;                                   // "num/den"

/**
 * GET /api/settings, PUT /api/settings (same shape back). Stored in ~/.config/plat-kaizo-planner/settings.json.
 * PUT takes every key. PUT gives 400 `{ error }` when the body fails validation, and, once the extract is present, 400
 * `{ error: "Cannot read <path>: <message>" }` when a new `savePath` does not read as a save.
 */
export interface SettingsJson {
  romPath: string | null;
  savePath: string | null;
  graveyardBox: number | null;                                       // 1-based box number
  levelCapOverride: number | null;
}

/** GET /api/setup */
export interface SetupJson {
  data: { state: 'ready' | 'missing' | 'extracting' | 'error'; message: string | null; trainers: number | null };
  romPath: string | null; savePath: string | null;
  saveCandidates: SaveCandidateJson[];                                // newest first
}
export interface SaveCandidateJson { path: string; modifiedAt: string; sizeBytes: number; summary: string | null; error: string | null }

/** POST /api/setup/extract, body ExtractRequestJson: SSE `progress` ({ message }), then `done` (SetupJson) or `error` ({ error }). */
export interface ExtractRequestJson { romPath: string }

/**
 * GET /api/box — the save as the planner sees it; re-read whenever the save file changes. `graveyardBoxes` are the boxes
 * whose Pokémon count as dead (`graveyardBox` to 18, or 15–18 while it is null). `run` is where the save is in the game.
 */
export interface BoxJson {
  savePath: string; savedAt: string; badges: number; levelCap: number; graveyardBoxes: number[];
  mons: BoxMonJson[];
  run: RunJson;
}

/**
 * Where the save is in the game. `splits` is every split in game order (the docs' tab order, each once). `split` is
 * `splits[splitIndex]`: the badge count's split, so N badges are split N, up to the eighth split (index 8, the Galactic
 * split) and never past the last split; '' when there are no splits. From 8 badges on, `alsoPossible` holds the splits
 * after the ninth (the Elite Four), else it is empty.
 * - `fights` are the fights of `split` (not of `alsoPossible`), in game order (the docs' order, which
 *   `TrainerSummaryJson.order` follows), player partners left out; each is a `RunFightJson`. It also lists a docs trainer
 *   the ROM data has no trainer for, which GET /api/trainers leaves out; that one is never defeated.
 * - `next` is the `id` of the first single battle in `fights` after the last defeated fight (from the start when none
 *   is defeated), so itself not defeated; null when there is none. Not the first fight that is not defeated: `defeated`
 *   false only means no flag is set, and a fight before a defeated one was most likely won or skipped. A single battle
 *   is one GET /api/trainers lists with `battleType` 'single', which a docs trainer with no ROM trainer never is, so it
 *   is never `next`.
 */
export interface RunJson { split: string; splitIndex: number; splits: string[]; alsoPossible: string[]; fights: RunFightJson[]; next: string | null }

/**
 * One fight of the run's split. `id` is the trainer's, as GET /api/trainers gives it. `defeated` is whether the save's
 * trainer-defeated flag is set for its ROM trainer, or for any of them when it has several copies (the rival's for each
 * player gender, say). The game sets that flag when the player beats a trainer who spots them. Scripted battles (the gym
 * leaders, the rival, some story fights) never set a trainer flag, so `defeated: false` means "no flag set": the fight
 * may still have been won. That is why `RunJson.next` looks after the last defeated fight.
 */
export interface RunFightJson { id: string; defeated: boolean }

/**
 * What the draft editor needs of one Pokémon: its save's total `exp`, its species' `growthRate` (a ROM growth table, the
 * species' own row's, as the engine reads it) and `baseStats` (its form's row, as the stats are computed), its `nature`
 * (0–24) and its `item` (a ROM item id, 0 = none). `moves` lines up with `BoxMonJson.moves`, each with its id and PP Ups.
 * `learnset` is its level-up moves in ROM order, each with the move's name ("(move <id>)" when unknown) and base PP.
 */
export interface BoxDraftJson {
  exp: number; growthRate: number; baseStats: Stats; nature: number;
  item: number;
  moves: { id: number; ppUps: number }[];
  learnset: { level: number; id: number; name: string; pp: number }[];
}
/** A stat a nature can raise or lower: any but HP. */
export type NatureStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe';

/**
 * One party or box Pokémon. `key` follows it wherever it moves: "pid:" and its PID as 8 lowercase hex digits, an
 * unreadable record's included (the PID is its unencrypted first word). `ivs` and `evs` are as the save stores them;
 * `hiddenPower` is the type (by name, "Steel") and power (30–70) the IVs give; `natureEffect` names the stats the nature
 * raises and lowers, and is null for a neutral nature. All four are null for an unreadable record.
 * - `types` are its form's types in the ROM, by name ("Fire", "Fighting"): one or two, once when both are the same. It is
 *   empty for an unreadable record and a species the ROM lacks.
 * - `showdown` is its Showdown import text, the same text the sheet gives it (`SheetMonJson.showdown`). It is null for an
 *   egg, an unreadable record, and a Pokémon whose species or moves the data cannot name.
 * - `speciesId` is its species' number (the national dex's: the key of `GET /api/sprites/{kind}/{species}.png`, which has
 *   1–493), whatever its form; 0 for an unreadable record. Optional in the type only; the server always sends it.
 * - `formId` is its form (the save's form bits) when that form has a sprite of its own and is not 0 (Rotom-Wash 2,
 *   Giratina-Origin 1, Unown-B 1): the sprite is `{species}-{form}.png`. Left out, the species' own sprite.
 * - `shiny` is true when it is shiny (its PID against its original trainer's IDs, as the game decides) and not an egg:
 *   the sprite is `…-shiny.png`. Left out otherwise.
 * - `draft` is what a draft may change of it. It is non-null exactly when `ineligibleReasons` is empty or `['over cap']`:
 *   a Pokémon over the level cap may still join a draft. null means it cannot join one.
 */
export interface BoxMonJson {
  ref: MonRef; key: string; nickname: string; species: string; speciesId?: number; formId?: number; shiny?: true; level: number; nature: string | null; ability: string; item: string | null;
  moves: { name: string; pp: number; maxPp: number }[]; hp: number; maxHp: number; status: string | null;
  location: 'party' | 'box'; box: number | null; slot: number;
  eligible: boolean; ineligibleReasons: string[]; notes: string[];
  ivs: Stats | null; evs: Stats | null; hiddenPower: { type: string; power: number } | null;
  natureEffect: { up: NatureStat; down: NatureStat } | null;
  types: string[];
  showdown: string | null;
  draft: BoxDraftJson | null;
}

/**
 * GET /api/draft/options — what the draft editor offers every Pokémon; 409 without the data. `items` are the items a
 * Pokémon may hold in a draft (ROM id and name, sorted by name; no item, 0, is not listed): every item the data names,
 * plus the hack's held items it cannot (Lava Cookie, Old Gateau, Shoal Salt, Shoal Shell) and the EXP items the engine
 * pays for (Exp. Share, 216, and Lucky Egg, 231). `growth` is the ROM's EXP
 * tables: `growth[rate][level]` is the total EXP at that level, levels 0–100 (`BoxDraftJson.growthRate` picks the row).
 */
export interface DraftOptionsJson { items: { id: number; name: string }[]; growth: number[][] }

/**
 * GET /api/events: SSE `box` (BoxJson) after the watched save changes and is re-read, or a settings change rebuilds it;
 * `boxError` ({ error }) when a read fails.
 */
export type ServerEvent = { name: 'box'; data: BoxJson } | { name: 'boxError'; data: { error: string } };

/** GET /api/trainers?search=<text> — opponents in game order. */
export interface TrainerSummaryJson {
  id: string; name: string; split: string; location: string; order: number; battleType: 'single' | 'double';
  tags: string[]; variants: number;
}

/**
 * POST /api/sheet with a `SheetRequestJson` — the matchup `Sheet` for the team as drafted, serialised by the server.
 * - Each of the player's Pokémon is as drafted: a field its draft entry gives (`DraftMonJson`: level, HP, status, item, moves
 *   and the rest) is the entry's, else the save's, with its stats and max HP at its level. The numbers use the HP each
 *   carries; a level or HP before the fight is set in the draft, which the sheet, its AI odds and a line start all read
 *   through one path. "All to full HP" in the team is the full-HP sheet.
 * - `trainer.field` is the docs' field note ("PERMANENT RAIN"), or null; `variant` and `variants` as in TrainerSummaryJson.
 * - `notes` are the sheet's, on the whole battle (a double's says it can't be built yet).
 * - `enemies` are in the trainer's party order, keyed "enemy:<index>" (from 0); `players` in team order, keyed by MonRef.
 * - `pairs` holds one entry per (player, enemy), players outer.
 * - `savedAt` and `savePath` are the box read the sheet was built from (`BoxJson`'s): the AI odds for the sheet are the
 *   ones whose stream's `start` has the same `savedAt` and `savePath`, for the same body.
 */
export interface SheetJson {
  trainer: { id: string; name: string; location: string; battleType: 'single' | 'double'; variant: number; variants: number; field: string | null };
  savedAt: string; savePath: string;
  notes: string[];
  enemies: SheetMonJson[];
  players: SheetMonJson[];
  pairs: SheetPairJson[];
}
/**
 * POST /api/sheet and POST /api/sheet/ai/stream: a trainer copy against the team in order, each Pokémon as drafted. These
 * are the sheet's only routes: a GET on either is a 405, and /api/sheet/ai is no route.
 * - `team` is MonRefs in the order to show them, each a Pokémon whose `BoxMonJson.draft` is non-null, over the level cap
 *   included; an empty team gives the trainer's Pokémon and no pairs. `variant` defaults to 0.
 * - `draft` is required and read as a line start reads it (`LineStartRequestJson.draft`): each Pokémon is on its entry's
 *   values, its HP the entry's `hp`, else the save's lost HP kept; an empty array is the team as the save has it.
 * - Any other key ("hp", "levels") is a 400, "<key> is not part of a sheet request". A refused draft is a 400 with the
 *   draft's own words, as a line start gives them; 404 for an unknown trainer, 409 without the data or a save.
 * - POST /api/sheet answers `SheetJson`; POST /api/sheet/ai/stream answers `SheetAiEvent`, for the sheet the same body
 *   gives.
 */
export interface SheetRequestJson { trainer: string; variant?: number; team: MonRef[]; draft: DraftMonJson[] }
/**
 * One Pokémon on the sheet. `nickname` is null for a trainer's. `nature` is null when no source gives one, and `stats`
 * then use a neutral nature. `showdown` is its Showdown import text.
 * - `hp` and `status` are what the sheet's numbers use: one of the player's on the HP it carries as drafted (`stats.hp` is its
 *   max) and its status as `BoxMonJson.status` gives one ("burn", "sleep:2"), null for none; a trainer's at full HP with
 *   no status. `item` is the item it holds in the numbers, drafted for one of the player's.
 * - `disputed` lists the nature and/or the ability an in-game check should settle. `options` names every candidate, the
 *   one the numbers use first ("Hardy", "Adamant"); a null nature has every nature as an option, and a docs nature that
 *   nothing contradicts has only itself.
 */
export interface SheetMonJson {
  /**
   * `speciesId` is its species' number (the national dex's) and `formId` its form when that has a sprite of its own and
   * is not 0 (a trainer's from the ROM's trainer data, his from the save): the keys of
   * `GET /api/sprites/{kind}/{speciesId}[-{formId}].png`. Optional in the type only; the server always sends `speciesId`.
   */
  speciesId?: number; formId?: number;
  key: string; name: string; nickname: string | null; level: number; nature: string | null; ability: string; item: string | null; moves: string[]; stats: Stats;
  hp: number; status: string | null;
  disputed: { field: 'nature' | 'ability'; options: string[] }[]; showdown: string;
}
/**
 * One player Pokémon (`player`, a MonRef) against one trainer Pokémon (`enemy`, "enemy:<index>"); `order` is who moves
 * first, 'depends' when it can go either way (the moves' priorities, the weather, or a Quick Claw or Custap Berry: the
 * notes say why).
 * - `field` describes the field the pair is worked out on, weather first ("Rain", "No weather, Trick Room"); null when
 *   the weather is not settled. Then `weatherCases` holds the pair worked out in each case, every move is the worse case
 *   for the player (`weatherDepends`), and the speeds are the player's lower and the trainer's higher.
 * - `weatherMayPersist`: another Pokémon of the battle can set weather, which may still be up when this pair meets; the
 *   numbers leave it out.
 */
export interface SheetPairJson {
  player: string; enemy: string; field: string | null; order: 'player' | 'enemy' | 'tie' | 'depends'; playerSpeed: number; enemySpeed: number; notes: string[];
  playerMoves: SheetMoveJson[]; enemyMoves: SheetMoveJson[]; weatherCases?: SheetPairCaseJson[]; weatherMayPersist: boolean;
}
/**
 * One way an unsettled weather can turn out, and the pair worked out that way. `enemyAbility` is the trainer Pokémon's
 * ability in this case (its own, or a disputed alternative that sets weather); `lastIn` is who came in last when both
 * set a different weather, else null; `when` says the case in words ("Mon came in last"); `field` as in SheetPairJson.
 */
export interface SheetPairCaseJson {
  enemyAbility: string; lastIn: 'player' | 'enemy' | null; when: string; field: string; order: 'player' | 'enemy' | 'tie' | 'depends';
  playerSpeed: number; enemySpeed: number; playerMoves: SheetMoveJson[]; enemyMoves: SheetMoveJson[];
}
/**
 * One move against one defender. `hitChance` and each `koChance` entry's `chance` are plain numbers from 0 to 1, not
 * Rationals. `damage` is null for a status or 0-power move. `weatherDepends` marks the worse of a pair's weather cases.
 * - `damage.koExact` holds 1 to 4 uses (`hits`), sorted by `hits`, with no crits, each conditional on hitting: the chance
 *   those uses KO from the defender's HP, as the calc's exact reduced fraction (`num` and `den` decimal strings). It is
 *   null when `bounded` is false: nothing bounds the damage (an effect the calc leaves out), so the rolls, range and
 *   percent bound nothing either.
 * - `damage.koChance` is the same chances as plain numbers, rounded by floating point. Not printed: the page prints
 *   `koExact`. Null exactly when `koExact` is.
 * - `damage.ohko` marks an OHKO move: its damage is the defender's HP when it hits, so it KOs whenever it hits.
 */
export interface SheetMoveJson {
  name: string; type: string; category: 'Physical' | 'Special' | 'Status'; power: number; hitChance: number; inaccurate: boolean; unmodelled: string | null;
  weatherDepends: boolean;
  damage: {
    rolls: number[]; critRolls: number[]; min: number; max: number; percent: [number, number]; koChance: { hits: number; chance: number }[] | null;
    koExact: { hits: number; num: string; den: string }[] | null;
    bounded: boolean; ohko: boolean; desc: string;
  } | null;
}

/**
 * The trainer AI's odds for each pair of a sheet, in the sheet's pair order: the AI's odds in that situation, not a proof.
 * It is a batch's whole answer, which no route sends: its pairs are POST /api/sheet/ai/stream's `pair` events.
 * - `savedAt` and `savePath` are the box's (`BoxJson`'s) when the request came in: the odds are for that save's team,
 *   as drafted, and go with the sheet of the same save and body (`SheetJson.savedAt` and `savePath`).
 * - The situation: turn 1 with the pair's two Pokémon in front. The player's as drafted (its HP, status, item, level and moves
 *   the draft's, else the save's), and the rest of the team behind in team order, as drafted too; the trainer's party with
 *   the pair's Pokémon swapped into slot 0, all at full HP; the pair's own field (`SheetPairJson.field`), its weather
 *   permanent.
 * - `next` is the AI's next action. `ifFaints` is whom it sends in if its Pokémon faints while the player's is in.
 * - The pairs take a while: one batch per trainer copy, drafted team and save, then cached. `POST /api/sheet` answers
 *   meanwhile.
 */
export interface SheetAiJson { savedAt: string; savePath: string; pairs: SheetAiPairJson[] }
/** One pair of `SheetAiJson`: the player's Pokémon (`player`) against the trainer's (`enemy`, "enemy:<index>"), and the AI's two answers. */
export interface SheetAiPairJson { player: MonRef; enemy: string; next: AiOddsJson; ifFaints: AiOddsJson }

/**
 * POST /api/sheet/ai/stream with a `SheetRequestJson`: SSE `start` ({ savedAt, savePath, total }) first, then one `pair`
 * (`SheetAiPairJson`) per pair as it is worked out (those already done at once, in sheet order), then `done` ({}), or
 * `error` ({ error }). Streams of the same body and save share one batch; it stops once no stream waits on it.
 * - `total` is the sheet's number of pairs; `savedAt` and `savePath` are as in SheetAiJson.
 * - A bad body gets its JSON answer before the stream opens, as POST /api/sheet gives it: 400, 404, 409, 422, or 501
 *   without the AI odds.
 * - `error` is the batch failing as a whole (the AI's data failing to load, say), and may come before `start`. A pair
 *   the AI can't decide is that pair's own `unproven`, never an `error`.
 * - Closing the stream (the page moved on) leaves it as a waiter no more: a batch no stream waits on stops, unkept.
 */
export type SheetAiEvent =
  | { name: 'start'; data: { savedAt: string; savePath: string; total: number } }
  | { name: 'pair'; data: SheetAiPairJson }
  | { name: 'done'; data: Record<string, never> }
  | { name: 'error'; data: { error: string } };

/**
 * How much of the trainer AI's odds a server sends, and so its page shows (`PKP_AI_ODDS`, read once at start, both modes). Damage, KO chances, crit figures, speed order and notes are the same at every level.
 * - `full`: every probability, exact, as the AI gives them (the default).
 * - `likeliest`: the likeliest action by name, every one tied for it, each with `rank` 1 and no probability. A plan
 *   step's send-out names every Pokémon of theirs still standing, in party order, the likeliest marked `likeliest`.
 * - `ranked`: every action in order of likelihood with its `rank` (1 the likeliest; ties share a rank, and the next
 *   counts them: 1, 2, 2, 4), and no probability.
 * - `off`: none of the AI's answer: no odds, no AI error, no send-out; the sheet's AI stream is a 501.
 */
export type AiOddsLevel = 'full' | 'likeliest' | 'ranked' | 'off';

/**
 * One of the AI's choices in an answer. `probability` (exact) at the `full` AI odds level only; `rank` at `likeliest` and
 * `ranked` only (`AiOddsLevel`).
 */
export interface AiChoiceJson { label: string; kind: 'move' | 'switch' | 'item'; probability?: RationalJson; rank?: number }

/**
 * One of the AI's answers on a sheet pair.
 * - `ok`: the choices, sorted by probability (highest first), then label; exact Rationals that sum to exactly 1, with
 *   choices of the same label summed. A move reads as its hack name ("Tackle"), a switch as "Switches to <species>" (in
 *   `ifFaints`, the species alone), a bag item as its name ("Full Restore"). Two Pokémon of one species in one answer
 *   get their party slot, as the sheet numbers it, from 1: "Zigzagoon (slot 3)".
 * - `depends`: the odds differ over the trainer's disputed natures and abilities, and one disputed value
 *   alone decides them. `on` names it, "Forretress's nature" (with its party slot for two of one species, "Zigzagoon
 *   (slot 3)'s ability"); one case per group of its candidates that give the same odds, the group holding the listed
 *   value first, then the others in candidate order. A case's `when` lists its values, "Hardy" or "Hardy or Bold", and
 *   its `choices` are as `ok`'s.
 * - `unproven`: the AI can't decide exactly here (an AiError in one candidate world or more: the first one's code and
 *   message), the odds differ over the trainer's disputed natures and abilities and no single one decides them (`DISPUTED`:
 *   "Depends on Forretress's nature (Hardy or Sassy); Forretress's ability (Sturdy or Overcoat)", or more than 16
 *   combinations to check), or the situation could not be built (another code: an engine error's, or the failure's
 *   own). Never a guess.
 * - `unsupported`: a double battle ("The AI odds are for single battles only"), or a pair whose weather is not settled
 *   ("The weather is not settled for this pair").
 * - `none`: the trainer has no other Pokémon ("Nothing left to send in").
 */
export type AiOddsJson =
  | { status: 'ok'; choices: AiChoiceJson[] }
  | { status: 'depends'; on: string; cases: { when: string; choices: AiChoiceJson[] }[] }   // one disputed value decides
  | { status: 'unproven'; code: string; reason: string }       // an AiError
  | { status: 'unsupported'; reason: string }                  // a double battle; an unsettled weather
  | { status: 'none'; reason: string };                        // nothing left to send in

// ---- The line builder (docs/line-builder.md) --------------------------------------------------------------
// A hand-driven walk over the engine and the trainer AI: the player picks every decision of his and which chance outcome to
// follow; the server answers each step with the AI's exact odds and every outcome's exact probability. Nothing is proven.
// A probability here is `{ num, den }`, both decimal strings of a reduced fraction (bigint never appears in JSON).

/** An exact fraction as two decimal strings, reduced, `den` above 0. */
export interface LineRationalJson { num: string; den: string }

/** One Pokémon of a battle as the line builder shows it. */
export interface LineMonJson {
  /** The battle's own name for it, as `Outcome.log` reads it ("Zubat 2"). */
  ident: string;
  /** What the page calls it: the player's by his page name, the trainer's by its battle name. */
  name: string;
  species: string;
  /**
   * The species' number in the battle (the national dex's: the key of `GET /api/sprites/{kind}/{species}.png`, which
   * has 1–493), whatever its form. Optional in the type only; the server always sends it.
   */
  speciesId?: number;
  /**
   * Its form in the battle when that has a sprite of its own and is not 0, from the battle's species (the trainer data's
   * or the save's form, or a form the battle gives it: Castform's weather, Cherrim's sunshine, and Arceus's Plate type
   * once it has switched in, as Showdown's Gen 4 Arceus changes form then): the sprite is `{species}-{form}.png`. Left out, the species' own sprite. Shininess is not here: his Pokémon's is the
   * box's (`BoxMonJson.shiny`, by ref), and a trainer's Pokémon is never shiny.
   */
  formId?: number;
  level: number; hp: number; maxHp: number;
  /** HP as a percent of max HP, one decimal. For the trainer's: the HP bar's percent (48 pixels), which is all the player sees of it. */
  percent: number;
  status: string | null;
  /** The stat stages that are not 0, "+2" or "-1", by stat name. */
  boosts: Record<string, string>;
  item: string | null; ability: string;
  fainted: boolean; active: boolean;
  /** The player's active Pokémon only: its moves in request order (the `slot` of a `Choice`), with their PP. */
  moves?: { name: string; pp: number; maxPp: number }[];
  /**
   * The player's party only, when the server can work it out: the EXP still to go to the next level in this state (the
   * engine's own EXP, the species' growth table). Null at level 100 or when unknown.
   */
  expToNext?: number | null;
}

/** One side: its active Pokémon (null when none is out) and its whole party in the battle's team order. */
export interface LineSideJson { active: LineMonJson | null; party: LineMonJson[] }

/** What the page shows of a battle state. Conditions are words ("Rain", "Trick Room", "Spikes x2"). */
export interface LineViewJson {
  player: LineSideJson; enemy: LineSideJson;
  field: { weather: string | null; conditions: string[]; player: string[]; enemy: string[] };
}

/**
 * One of the trainer AI's actions; `label` reads "Rock Slide", "Switch to Onix", "Full Restore". `probability` (exact)
 * and `percent` at the `full` AI odds level only, which the line builder always is; `rank` at `likeliest` and `ranked`
 * only (`AiOddsLevel`).
 */
export interface LineAiChoiceJson { label: string; probability?: LineRationalJson; percent?: number; rank?: number }

/**
 * The AI's odds for its next action. `turn` is its action at the player's turn; `replacement` is whom it sends out (after a KO
 * or a U-turn): its labels are the Pokémon's names.
 */
export interface LineAiOddsJson { kind: 'turn' | 'replacement'; choices: LineAiChoiceJson[] }

/** One of the player's legal choices: the `Choice` to send back, and its label ("Use Scratch", "Switch to Staraptor"). */
export interface LineChoiceJson { choice: Choice; label: string }

/** A disputed-values world of the fight (when the trainer's natures or abilities are disputed): `label` reads "Geodude: Jolly". */
export interface LineWorldJson { index: number; label: string }

/**
 * A step's node (`POST /api/line/start`, `POST /api/line/next`, `GET /api/line/node`).
 * - `phase` is the engine's phase kind. `dead`: one of the player's Pokémon fainted on the path to here (a nuzlocke death);
 *   reaching `playerReplacement` counts.
 * - `aiOdds` is present at `turnChoice`, `enemyMidTurnSwitch` and `enemyReplacement`; `aiError` instead when the AI's
 *   behaviour is undefined there (the node cannot be expanded). `choices` is present where the player decides: `turnChoice`,
 *   `playerMidTurnSwitch`, `playerReplacement`. `terminal` is present at the end.
 * - `pathProbability`/`pathPercent` are the whole path's probability so far. `unmodelled` is the engine's list, said in plain words (engine/notes.ts `plainUnmodelled`).
 * - `world` is the world index the line runs in; `worlds` lists them when there is more than one.
 * - `carried` is on the root of a carried line only (`POST /api/line/next`): where its team came from.
 */
export interface LineNodeJson {
  line: string; node: string; turn: number;
  phase: 'turnChoice' | 'playerMidTurnSwitch' | 'enemyMidTurnSwitch' | 'enemyReplacement' | 'playerReplacement' | 'terminal';
  dead: boolean;
  view: LineViewJson;
  aiOdds?: LineAiOddsJson; aiError?: string;
  choices?: LineChoiceJson[];
  /** At `turnChoice`, when the server can read the state: the damage of each move (see `LineDamageJson`). */
  damage?: LineDamageJson;
  terminal?: { winner: 'p1' | 'p2' };
  unmodelled: string[];
  pathProbability: LineRationalJson; pathPercent: number;
  world: number; worlds?: LineWorldJson[];
  /** The root of a carried line only. */
  carried?: LineCarriedJson;
}

/**
 * One Pokémon of the draft team: the player's edits for planning, never written to the save. Only `ref` is required; a field
 * left out is the save's value. The server checks each with the save reader's rules (a 400 names the Pokémon and why).
 * - `level` 1–100, below the save's too. `exp` is the total EXP and must fit `level` on the species' growth table; left
 *   out with a changed level, it is that level's own total.
 * - `hp` 1 to the max HP at the draft's level, IVs, EVs and nature. Left out: the save's lost HP is kept, at least 1.
 * - `status` 'none', 'sleep:1' to 'sleep:7', 'poison', 'toxic', 'burn', 'freeze' or 'paralysis'.
 * - `item` a ROM item id: 0 (none), the save's own item, or one of `DraftOptionsJson.items`.
 * - `moves` 1 to 4, none twice, each the save's or a level-up move learned at or below `level`. A save move keeps its PP
 *   Ups and, without `pp`, its PP; a new one has 0 PP Ups and full PP. `pp` is 0 to the move's max PP.
 * - `ivs` 0–31 each, `evs` 0–255 each and 510 in all at most, `nature` 0–24.
 */
export interface DraftMonJson {
  ref: MonRef;
  level?: number;
  exp?: number;
  hp?: number;
  status?: string;
  item?: number;
  moves?: { id: number; pp?: number }[];
  ivs?: Stats; evs?: Stats; nature?: number;
}

/**
 * POST /api/line/start. `team` is the lead first (1 to 6 MonRefs), each a Pokémon whose `BoxMonJson.draft` is non-null,
 * over the level cap included; `world` defaults to 0, the listed values.
 * - `draft` is required: each entry's `ref` is in `team`, once, and that Pokémon starts with its edits (`DraftMonJson`); a
 *   team member with no entry starts as the save has it, so an empty array starts the whole team as the save has it. A
 *   level, HP or status before the fight is set in the draft: each Pokémon starts on its entry's `hp`, else the save's
 *   lost HP kept. The draft is never written to the save.
 * - A body that still has `hp`, `levels` or `startStatus` (a page from an older version) is a 400 saying to reload the page.
 */
export interface LineStartRequestJson { trainerId: string; variant?: number; team: MonRef[]; world?: number; draft: DraftMonJson[] }

/** `POST /api/line/next`: the next trainer's line from a won node, with the team as that node's battle left it. */
export interface LineNextRequestJson { line: string; node: string; trainerId: string; variant?: number; world?: number; lead?: MonRef; heal?: boolean }

/** Where a carried line's team came from. `dropped`: the fainted Pokémon left behind, by page name, in the won fight's order. */
export interface LineCarriedJson { fromLine: string; fromNode: string; dropped: string[] }

/** POST /api/line/expand. `choice` is the player's, required where he decides (`LineNodeJson.choices`), left out elsewhere. */
export interface LineExpandRequestJson { line: string; node: string; choice?: Choice }

/** An HP at the end of a step. `percent` as `LineMonJson.percent`. */
export interface LineEndHpJson { name: string; hp: number; maxHp: number; percent: number }

/**
 * One Pokémon's EXP from the knockout in this outcome. `index` is the player's team index, lead first; `name` its page name.
 * `boosted`: a traded Pokémon's 1.5 or 1.7 times. `fromLevel` is its level before the step, `toLevel` after it (the same
 * when it did not grow); `learned` are moves it learned into a free slot, `offered` moves it could learn with four known.
 */
export interface LineExpGainJson {
  index: number; name: string; gained: number; boosted: boolean;
  fromLevel: number; toLevel: number; learned: string[]; offered: string[];
}

/**
 * One damage roll the outcome fixed. `damage` null: at least the target's HP left. `rollValue` as `ChanceLabel.rollValue`
 * ('final': the hit's damage; 'base': the roll before STAB, type and items), null when the engine did not say.
 */
export interface LineRollJson { side: 'p1' | 'p2'; move: string; damage: number | null; rollValue: 'final' | 'base' | null }

/**
 * One outcome of a step: `id` is a short hash of the outcome and the AI's action (stable between runs), `node` the child
 * node it leads to. `probability` is the AI action's times the outcome's. `aiAction` is null when the AI did not act.
 * `summary` reads what happened, in order. `faints` are names. `death`: one of the player's Pokémon fainted in it.
 */
export interface LineOutcomeJson {
  id: string; node: string; probability: LineRationalJson; percent: number; aiAction: string | null;
  summary: string[]; endHp: { p1: LineEndHpJson | null; p2: LineEndHpJson | null };
  faints: { p1: string[]; p2: string[] }; death: boolean; enemyCrit: boolean; unlabelled: boolean;
  /**
   * Everything the player sees of the outcome as one string: the AI's action, the summary, who fainted on both sides (names), who
   * landed a crit, and whether it was a death. Not the probability, and no state: it is the same for the same outcome over
   * another team, where `id` and `node` differ, so a line rebuilt over a changed team (docs/line-team-change.md) finds its steps by it.
   */
  signature: string;
  /** `next` is the phase of the node this outcome leads to, `winner` who won when `next` is `terminal`. */
  next: LineNodeJson['phase'];
  winner?: 'p1' | 'p2';
  /**
   * The EXP the outcome paid the player's party, read from the engine's log: one entry per paid Pokémon, in party order, empty
   * when nobody was paid. Neither in `summary` nor in `signature` (signatures match across teams).
   */
  exp: LineExpGainJson[];
  /** The damage rolls the outcome fixed, in order. Neither in `summary` nor in `signature`. */
  rolls: LineRollJson[];
}

/** POST /api/line/expand's answer: the step's outcomes grouped by AI action (largest first), and the totals over all of them. */
export interface LineExpandJson {
  line: string; node: string; choice: Choice | null;
  groups: { aiAction: string | null; probability: LineRationalJson; percent: number }[];
  outcomes: LineOutcomeJson[];
  totals: { enemyFaints: LineRationalJson; death: LineRationalJson; enemyCrit: LineRationalJson };
}

/**
 * Line builder errors, as `{ error, code? }`: 404 with code `LINE_LOST` for a line or node the server no longer holds
 * (a restart, a data reload, or eviction: the page replays its saved path); 422 with the engine's own code for an engine
 * error (`BAD_CHOICE`, also for a choice that is not legal at the node; `UNSUPPORTED_DOUBLE`, `UNMODELLED_ITEM`, `LIMIT`),
 * `AI_UNDEFINED` where the trainer AI's behaviour is undefined (at an unexpandable node, or at the start), `BAD_START`
 * for a battle the engine will not build (its `RangeError`) and `TOO_BIG` for a line that alone would outgrow the server's
 * store; 400 for a bad request. The page says each code in its own words; the message is the server's,
 * which the page shows only behind "Details".
 */
export type LineErrorCode = 'LINE_LOST' | 'BAD_CHOICE' | 'UNSUPPORTED_DOUBLE' | 'UNMODELLED_ITEM' | 'LIMIT' | 'AI_UNDEFINED' | 'BAD_START' | 'TOO_BIG';

// ---- Damage numbers on the line builder's nodes (docs: line damage) ------------------------------------------
// At a node where the player picks a move (`turnChoice`), each of his moves against the enemy's active Pokémon and each of the
// enemy's moves against his, worked out by the matchup sheet's calc (`damage()`) on the node's own battle state: stat
// stages, HP, status, weather, screens and the draft's edits (each of his Pokémon as drafted) all count.

/**
 * One move's numbers against the other side's active Pokémon, as the sheet has them. `percent` and `critPercent` are the
 * lowest and highest damage of one hit as a percent of the defender's max HP (the crit's own range). The KO chances are
 * the calc's exact fractions (`koExact`, `koCritExact`), conditional on the move hitting (`hitChance`). `ko` is the chance
 * this one hit takes the defender from its current HP to 0 with no crit, `koCrit` the same when the hit is a crit: both
 * between 0 and 1, as plain numbers rounded by floating point, and not printed (the page prints the exact fractions).
 * `note` is the short reason there are no numbers: "can't calculate here: …". A status move has `status` true and
 * nothing else.
 */
export interface LineMoveDamageJson {
  name: string;
  /** The player's moves only: the `slot` of the `Choice` that uses it. */
  slot?: number;
  hitChance: number;
  status: boolean;
  percent: [number, number] | null; critPercent: [number, number] | null;
  /** `koExact[0]` and `koCritExact` as plain numbers. Not printed: the page prints the exact fractions. */
  ko: number | null; koCrit: number | null;
  /** The chance that 1, 2, 3 and 4 hits in a row KO from the HP now, no crit: the calc's `koExact`, in that order. Null where there are no numbers. */
  koExact: LineRationalJson[] | null;
  /**
   * The chance one hit KOs when it is a crit. Null, as `critPercent`, `koCrit` and `critHp` are, where no crit can land: a
   * fixed-damage move, a move whose damage the engine sets before its crit (Counter, Mirror Coat, Metal Burst), a
   * defender with Battle Armor or Shell Armor and an attacker without Mold Breaker, or Lucky Chant on the defender's side.
   */
  koCritExact: LineRationalJson | null;
  /** One hit's lowest and highest damage in HP (the calc's `min`/`max`), and the crit's (every hit of the use a crit). */
  hp: [number, number] | null; critHp: [number, number] | null;
  note: string | null;
  /** The move's priority from the dex; 0 for a move the dex does not know, and for Struggle. */
  priority: number;
  /**
   * The held item that keeps the defender at 1 HP from this one hit, or null. It is 'Focus Sash' when the defender is at
   * full HP (its current HP is the calc's max HP) and holds a Focus Sash: matched by its hold effect in the ROM's item
   * data (103, the hack's Focus Sash's), and none under Klutz, as `heldEffect` (src/calc/battler.ts) reads a held item.
   * Null for a move that hits more than once in a use (the calc's `hits`, and Beat Up and Triple Kick, whose hits the calc
   * does not count): a second hit breaks the Sash. Null for every move without numbers. Set on both sides: his moves
   * against their active, their moves against his. The server always sends it (null included); it is optional only for
   * callers that build these objects without it, and absent reads as null: no Sash.
   */
  survives?: string | null;
  /**
   * Whether the move hits more than once in a use: the calc's `hits` above 1, or Beat Up and Triple Kick. Its `critHp` is
   * then the top roll with every hit a crit. The server always sends it; it is optional only for callers that build these
   * objects without it, and absent reads as false.
   */
  multiHit?: boolean;
  /*
   * The four below are what a move button and a crit split show. The server always sends them (null included), on both
   * sides and on the lists without numbers; they are optional only for callers that build these objects without them, and absent reads as null.
   */
  /** The move's type by name ("Water", "Rock"), from the ROM's type table; null for a move the dex does not know. */
  type?: string | null;
  /** 'physical', 'special' or 'status'; null for a move the dex does not know. */
  category?: 'physical' | 'special' | 'status' | null;
  /**
   * The move's base power; null for a status move, a move the dex does not know, and a move with no single power: a
   * fixed-damage move (Seismic Toss, Dragon Rage), a variable-power move (Flail, Low Kick, Gyro Ball, Hidden Power), a
   * one-hit KO move and Counter, Mirror Coat and Metal Burst, whose ROM power is the placeholder 1. A move whose power
   * only doubles on a condition (Payback, Stomp) sends its base power.
   */
  power?: number | null;
  /**
   * The chance one hit of this move is a crit on this node's state: 1/16, 1/8, 1/4, 1/3 or 1/2 by the gen 4
   * crit stage (the move's own, Scope Lens or Razor Claw, Super Luck, Focus Energy, Stick or Lucky Punch on its user),
   * and 0/1 where no crit can land (a fixed-damage or one-hit KO move, a move whose damage the engine sets such as
   * Counter, Battle Armor or Shell Armor without Mold Breaker, Lucky Chant on the defender's side), where the crit
   * figures (`critPercent`, `koCrit`, `koCritExact`, `critHp`) are null too. Null for a status move, a move the dex or
   * the installed engine dex does not know, and a side the server cannot read.
   */
  critChance?: LineRationalJson | null;
}

/**
 * Who moves first at equal priority, by the sheet's rules (src/sheet/speed.ts) on the node's two sides and field.
 * `player` and `enemy` are their effective Speeds; `first` is `speedOrder`'s answer (Lagging Tail and Full Incense, Stall,
 * Trick Room, then Speed; 'tie' is a 50/50). `changers` names each held "Quick Claw" or "Custap Berry" (after Klutz) on a
 * side that would not surely move first at equal priority (on a tie, both sides), player first, no repeats.
 */
export interface LineOrderJson { player: number; enemy: number; first: 'player' | 'enemy' | 'tie'; changers: string[] }

/**
 * `yours` against their active Pokémon, `theirs` (every move they know) against yours (`against` is its name). `order` is
 * null when either side's state is not one the calculator reads, or the weather is one it does not know.
 */
export interface LineDamageJson { yours: LineMoveDamageJson[]; theirs: LineMoveDamageJson[]; against: string; order: LineOrderJson | null }

// ---- The plan step ----------------------------------------------------------------
// A fight is a plan the player writes, one step per turn. A step answers one battle state with the line node's own pieces:
// the damage both ways, the trainer AI's exact reply odds, his choices and, when their active is marked fainted, their
// send-out odds. HP never changes: his Pokémon are on the draft's HP, theirs full. Nothing beyond the one state is worked
// out, and the server keeps no battle between steps (it answers a step it answered before, over the same save read and
// data, from a cache of the last 64 answers).

/** The weather the player sets for a step. */
export type PlanWeather = 'none' | 'sun' | 'rain' | 'sand' | 'hail';
/** A stat with a stage. */
export type PlanStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva';
/**
 * Stat stages, whole numbers from -6 to +6; a stat left out is 0. POST /api/plan/step clamps a whole number outside -6..6
 * to it (and echoes the clamped value); a direct caller of the plan service gets a 400 for one.
 */
export type PlanStages = Partial<Record<PlanStat, number>>;
/** Their active Pokémon's status. */
export type PlanStatus = 'none' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';

/**
 * A step's field and boosts, set by the player like a damage calc's. `rocks.player` is Stealth Rock on his side (hurting
 * his switch-ins). `stages` are the two active Pokémon's; `enemyStatus` their active Pokémon's status. A weather set by
 * the step (one that is not the battle start's own) never ends, as a permanent weather.
 */
export interface PlanFieldJson {
  weather: PlanWeather; trickRoom: boolean;
  rocks: { player: boolean; enemy: boolean };
  screens: { player: { reflect: boolean; lightScreen: boolean }; enemy: { reflect: boolean; lightScreen: boolean } };
  stages: { player: PlanStages; enemy: PlanStages };
  enemyStatus: PlanStatus;
}

/**
 * The field a step asks for: `weather` left out is the battle start's (the abilities on the field, the trainer's field),
 * and `trickRoom` left out is the battle start's too (the trainer's field: a permanent Trick Room). An explicit
 * `false` is off.
 */
export type PlanStepFieldJson = Omit<PlanFieldJson, 'weather' | 'trickRoom'> & { weather?: PlanWeather; trickRoom?: boolean };

/**
 * A step's state. `player.active` is `team[0]`; `player.fainted` are refs of the team. `enemy.active` and `enemy.fainted`
 * are the trainer's party indices (the copy's own order, as the sheet's `enemy:<index>`). An active in its own side's
 * `fainted` is marked fainted.
 */
export interface PlanStepStateJson {
  player: { active: MonRef; fainted: MonRef[] };
  enemy: { active: number; fainted: number[] };
  field: PlanStepFieldJson;
}

/**
 * POST /api/plan/step. `team` is his party, the active first, 1 to 6: any eligible box Pokémon may be in it.
 * `team` and `draft` are read exactly as `POST /api/line/start` reads them.
 */
export interface PlanStepRequestJson {
  trainerId: string; variant?: number; world?: number;
  team: MonRef[];
  draft: DraftMonJson[];
  state: PlanStepStateJson;
}

/**
 * One of the trainer's send-outs: the AI's odds in the line node's shape, with the Pokémon's party `index` (the copy's
 * own). At the `likeliest` AI odds level `likeliest` marks the likeliest (each tied for it), and the others have no mark.
 */
export type PlanSendOutChoiceJson = LineAiChoiceJson & { index: number; likeliest?: true };

/**
 * POST /api/plan/step's answer: the line node's pieces for the step's one state (`phase`, `view`, `choices`, `damage`,
 * `aiOdds`, `aiError` as `LineNodeJson` has them), and:
 * - `phase` 'turnChoice', or 'playerReplacement' when his active is marked fainted: `choices` are then his replacements,
 *   the Pokémon not marked fainted (never limited by a trapping ability). A switch's `index` is the Pokémon's position in
 *   the request's `team`.
 * - `view` is the line node's without `expToNext` (left out on every Pokémon). A bench Pokémon marked fainted shows HP 0
 *   and fainted; an active marked fainted keeps its HP (the mark is after a move).
 * - `damage` and `aiOdds` (kind 'turn') are the pair's either way (a mark is after a move).
 * - `field`: the request's field, with `weather` resolved (the battle start's when it was left out). `enemyStatus` echoes
 *   the status asked for even when the state could not take it (sleep or bad poison whose unknown counter changes the
 *   figures): `unmodelled` then says the status was left out.
 * - `startStages`: the stat stages the battle start gives the two actives (his `player`, theirs `enemy`), the nonzero ones
 *   only, such as `{ player: { atk: -1 }, enemy: {} }` after their lead's Intimidate. The step's own `stages` replace them
 *   in the state (a stage left out is 0), so the page seeds turn 1's stages from this; later steps can ignore it.
 * - `sendOut`: when their active is marked fainted and one of theirs is left, the AI's replacement odds; `sendOutError`
 *   instead when the AI's behaviour is undefined there.
 * - `unmodelled`: the engine's list in plain words, and a sentence for any of the step's fields the state could not take.
 * - Below the `full` AI odds level (`AiOddsLevel`), `aiOdds` and `sendOut` carry what the level allows: at `likeliest`
 *   `aiOdds` holds only the likeliest actions and `sendOut` every one of theirs still standing, in party order, the
 *   likeliest marked; at `ranked` both hold every action with its rank; at `off` none of `aiOdds`, `aiError`, `sendOut` and
 *   `sendOutError` is sent.
 */
export interface PlanStepJson {
  phase: 'turnChoice' | 'playerReplacement';
  view: LineViewJson;
  choices: LineChoiceJson[];
  damage?: LineDamageJson;
  aiOdds?: LineAiOddsJson; aiError?: string;
  field: PlanFieldJson;
  startStages?: { player: PlanStages; enemy: PlanStages };
  sendOut?: { kind: 'replacement'; choices: PlanSendOutChoiceJson[] };
  sendOutError?: string;
  unmodelled: string[];
  world: number; worlds?: LineWorldJson[];
}

// ---- Hosted mode (docs/deploy.md) ----
// In hosted mode `BoxJson.savePath` is the uploaded file's name, never a path, and `BoxJson.savedAt` is the file's
// last-modified time as the browser gave it.

/**
 * GET /api/config, both modes: which mode the server runs in. The page asks it first. Hosted: `maxSaveBytes` is the
 * largest save `PUT /api/save` takes, `pollMs` how often a connected save file is looked at. `aiOdds`, both modes: how
 * much of the trainer AI's odds the server sends (`AiOddsLevel`). Optional in the type only (an older server, which the
 * page reads as `full`); the server always sends it.
 */
export type ConfigJson =
  | { mode: 'local'; aiOdds?: AiOddsLevel }
  | {
    mode: 'hosted'; version: string; maxSaveBytes: number; pollMs: number; aiOdds?: AiOddsLevel;
    /**
     * `passwordRequired`: the site has a password, so the page signs in first (`POST /api/login`). `signedIn`: this
     * request carried a valid sign-in (the cookie, or Basic); always true on a public site. Optional in the type only;
     * the hosted server always sends both.
     */
    passwordRequired?: boolean; signedIn?: boolean;
  };

/** GET /api/health, both modes. Hosted: no password, no session, never rate limited. */
export interface HealthJson { ok: true; mode: 'local' | 'hosted'; version: string; uptimeSeconds: number }

/** The settings left in hosted mode. They live in the browser and ride with each upload. */
export type HostedSettingsJson = Pick<SettingsJson, 'graveyardBox' | 'levelCapOverride'>;

/** The `code` beside `error` on a hosted failure. */
export type HostedErrorCode =
  | 'NO_SAVE'            // 409: no box for this session (never loaded, expired, or the server restarted)
  | 'SESSION_REQUIRED'   // 400: the session header is missing or malformed
  | 'BAD_SAVE'           // 422: the upload does not read as a save
  | 'TOO_LARGE'          // 413
  | 'RATE_LIMITED'       // 429, with Retry-After
  | 'BUSY'               // 503 (queue full, Retry-After) or 429 (this session has too much running)
  | 'TIMEOUT'            // 503
  | 'INTERNAL';          // 500
