// Our damage rolls against PKCalc's own damage calc, for the real-data check. PKCalc is a fork of the Smogon
// damage calc with the hack's species and move data. Its page loads the fork as plain scripts that define the global
// `calc` (calc/index.js and the files before it, with a `require` shim in index.html), and its dex tables as the globals
// SPECIES, MOVES, ITEMS and ABILITIES (js/data/dex/*.js). Its code only ever runs in its own page in headless Chromium,
// opened by `openPkcalcOffline`, never in Node.
//
// Each calc is fed explicit, identical inputs: the species, level, gender, nature, IVs, EVs, item, ability, move and
// field we use, by PKCalc's names. Base stats and types, and the move's power, type and category, go in as overrides,
// as PKCalc's own page does from its editable fields, so PKCalc runs its mechanics on the ROM's numbers.

import type { Browser, Page, Request } from 'playwright';
import { hiddenPower, type KaizoMove } from '../battle/moves.js';
import type { BattleMon, LoadedData, ResolvedMon, ResolvedTrainer, TrainerCatalog } from '../battle/types.js';
import { isOhko } from '../calc/accuracy.js';
import { type CalcField, type CalcSide, damage, fieldFromNote, moveFlags, smogonTarget } from '../calc/calc.js';
import { personalRowFor } from '../rom/forms.js';
import { NATURES } from '../rom/natures.js';
import { calcHp } from '../rom/stats.js';
import { TYPE_NAMES } from '../rom/tables.js';
import type { Stats } from '../rom/types.js';
import type { Diff } from './diff.js';
import { type DexTables, PKCALC_URL } from './pkcalc.js';

// ---------------------------------------------------------------------------------------------------------------------
// The page, offline.

/** PKCalc's page, loaded in a fresh context whose network is cut (`openPkcalcOffline`). */
export interface OfflinePkcalc {
  page: Page;
  /** The messages of the alerts the page raised, each dismissed. PKCalc greets a new visitor with its changelog. */
  alerts: string[];
  /** Every request the page made after the cut ("GET https://…", "WebSocket wss://…"). */
  attempted(): string[];
  /** The requests made after the cut that got a response, which left the machine: empty while the cut holds. */
  escaped(): string[];
}

/** Requests the browser answers itself, which never leave the machine. */
const LOCAL_URL = /^(data|blob|about):/;

/**
 * Opens PKCalc's page in a fresh context of `browser` and cuts the network once it has loaded, as the save check
 * does. A service worker's requests would bypass the context's routes, so none may start. After the load the context
 * goes offline, every request is aborted and every WebSocket is closed here, and a fetch from the page checks the cut.
 * From then on every request is recorded; any that gets a response has left the machine (`escaped`).
 */
export async function openPkcalcOffline(browser: Browser): Promise<OfflinePkcalc> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const alerts: string[] = [];
  page.on('dialog', (dialog) => {
    alerts.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(PKCALC_URL);
  await page.waitForSelector('#saveFile', { state: 'attached' });
  await page.waitForFunction('typeof calc === "object" && typeof calc.calculate === "function" && typeof MOVES === "object"');

  const sockets: string[] = [];
  await context.setOffline(true);
  await context.route('**/*', (route) => route.abort());
  await context.routeWebSocket(/.*/, (socket) => {
    sockets.push(socket.url());
    socket.close();
  });
  const cut = await page.evaluate('fetch(location.href).then(() => "reached", () => "blocked")');
  if (cut !== 'blocked') throw new Error('The network cut did not hold: the page reached PKCalc after it');

  const attempted = new Set<Request>();
  const reached = new Set<string>();
  const describe = (request: Request) => `${request.method()} ${request.url()}`;
  const answered = (request: Request) => {
    if (attempted.has(request) && !LOCAL_URL.test(request.url())) reached.add(describe(request));
  };
  context.on('request', (request) => attempted.add(request));
  context.on('response', (response) => answered(response.request()));
  context.on('requestfinished', answered);
  return {
    page, alerts,
    attempted: () => [...[...attempted].map(describe), ...sockets.map((url) => `WebSocket ${url}`)],
    escaped: () => [...reached],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// PKCalc's calc, with explicit inputs.

/** One side of a PKCalc calc, by PKCalc's names. `types` has '' second for one type, as its page passes it. */
export interface PkcalcMonInput {
  species: string; level: number; gender: 'M' | 'F' | 'N'; nature: string; ability: string; abilityOn: boolean; item: string;
  ivs: Stats; evs: Stats; baseStats: Stats; types: [string, string];
}

/**
 * The move of a PKCalc calc: PKCalc's move by name, with the ROM's power, type and category. Only one hit is calculated
 * (a multi-hit move's first). `hiddenPower` has PKCalc work out the type and power from the attacker's IVs, as its page
 * does for Hidden Power. `flags` and `target` replace PKCalc's own punch and sound flags and target, to test a cause.
 */
export interface PkcalcMoveInput {
  name: string; basePower: number; type: string; category: 'Physical' | 'Special'; isCrit: boolean; hiddenPower: boolean;
  flags?: { punch: boolean; sound: boolean }; target?: string;
}

export interface PkcalcFieldInput {
  gameType: 'Singles' | 'Doubles'; weather?: 'Rain' | 'Sun' | 'Sand' | 'Hail'; isGravity: boolean; isReflect: boolean; isLightScreen: boolean;
}

export interface PkcalcCalcInput { attacker: PkcalcMonInput; defender: PkcalcMonInput; move: PkcalcMoveInput; field: PkcalcFieldInput }

/**
 * Run in PKCalc's page: each input's 16 damage rolls from PKCalc's `calc.calculate` in Gen 4, its hack data's gen. A
 * fixed damage (a number) fills all 16. The move's `multihit` is overridden to 0 so that only one hit is calculated.
 */
const PAGE_CALC = `(inputs) => {
  const gen = calc.Generations.get(4);
  const mon = (m) => new calc.Pokemon(gen, m.species, {
    level: m.level, gender: m.gender, nature: m.nature, ability: m.ability, abilityOn: m.abilityOn, item: m.item,
    ivs: m.ivs, evs: m.evs, overrides: { baseStats: m.baseStats, types: m.types },
  });
  return inputs.map((input) => {
    const attacker = mon(input.attacker);
    const defender = mon(input.defender);
    const own = input.move.hiddenPower ? calc.Stats.getHiddenPower(gen, input.attacker.ivs) : null;
    const overrides = { basePower: own ? own.power : input.move.basePower, type: own ? own.type : input.move.type, category: input.move.category, multihit: 0 };
    if (input.move.flags) overrides.flags = { punch: input.move.flags.punch ? 1 : 0, sound: input.move.flags.sound ? 1 : 0 };
    if (input.move.target) overrides.target = input.move.target;
    const move = new calc.Move(gen, input.move.name, { ability: input.attacker.ability, item: input.attacker.item, isCrit: input.move.isCrit, overrides });
    const f = input.field;
    const field = new calc.Field({ gameType: f.gameType, weather: f.weather, isGravity: f.isGravity, defenderSide: { isReflect: f.isReflect, isLightScreen: f.isLightScreen } });
    const dealt = calc.calculate(gen, attacker, defender, move, field).damage;
    if (typeof dealt === 'number') return Array(16).fill(dealt);
    if (!Array.isArray(dealt) || dealt.length !== 16 || !dealt.every((roll) => typeof roll === 'number')) throw new Error('PKCalc gave no 16 rolls for ' + input.move.name + ': ' + JSON.stringify(dealt));
    return dealt.slice();
  });
}`;

/** Each input's 16 rolls from PKCalc's own calc, in one call into the page. */
export async function pkcalcRollsAll(page: Page, inputs: PkcalcCalcInput[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  return await page.evaluate(`(${PAGE_CALC})(${JSON.stringify(inputs)})`) as number[][];
}

/** One input's 16 rolls from PKCalc's own calc. */
export async function pkcalcRolls(page: Page, input: PkcalcCalcInput): Promise<number[]> {
  return (await pkcalcRollsAll(page, [input]))[0]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Our inputs as PKCalc names them.

/** PKCalc's names for Gen 4 IDs: species and form, then the calc names of moves, items and abilities. Throws for an unknown ID. */
export interface PkcalcNames {
  species(id: number, form: number): string;
  move(id: number): string;
  item(id: number): string;
  ability(id: number): string;
}

/**
 * Names from PKCalc's dex tables (`PAGE_DEX_TABLES`). A form is its place in the base species' `formes`, which list the
 * base first; a species without `formes` (Burmy, Unown) is the base species whatever its form.
 */
export function pkcalcNames(tables: DexTables): PkcalcNames {
  const bases = new Map(Object.values(tables.SPECIES).filter((entry) => !entry.baseSpecies).map((entry) => [entry.num, entry]));
  const byNum = (what: string, table: DexTables['MOVES']) => {
    const names = new Map(Object.values(table).map((entry) => [entry.num, entry.calcName]));
    return (id: number) => {
      const name = names.get(id);
      if (name === undefined) throw new Error(`PKCalc has no ${what} ${id}`);
      return name;
    };
  };
  return {
    species(id, form) {
      const base = bases.get(id);
      if (base === undefined) throw new Error(`PKCalc has no species ${id}`);
      if (!base.formes?.length) return base.name;
      const entry = tables.SPECIES[base.formes[form] ?? ''];
      if (entry === undefined) throw new Error(`PKCalc has no form ${form} of ${base.name}`);
      return entry.name;
    },
    move: byNum('move', tables.MOVES), item: byNum('item', tables.ITEMS), ability: byNum('ability', tables.ABILITIES),
  };
}

function pkcalcMon(side: CalcSide, names: PkcalcNames): PkcalcMonInput {
  const { mon } = side;
  const [first, second] = mon.types;
  return {
    species: names.species(mon.species, mon.form), level: mon.level, gender: mon.gender ?? 'N',
    nature: NATURES[mon.nature.value ?? 0]!, ability: names.ability(mon.ability.value), abilityOn: !!side.abilityOn,
    item: mon.item === 0 ? '' : names.item(mon.item), ivs: { ...mon.ivs }, evs: { ...mon.evs }, baseStats: { ...mon.baseStats },
    types: [TYPE_NAMES[first]!, first === second ? '' : TYPE_NAMES[second]!],
  };
}

const WEATHERS = { rain: 'Rain', sun: 'Sun', sand: 'Sand', hail: 'Hail' } as const;

/**
 * The PKCalc calc for one of ours: the same Pokémon, move and field. Sides must be at full HP with no status or stat
 * stages, which `PkcalcMonInput` has no place for.
 */
export function pkcalcInput(attacker: CalcSide, defender: CalcSide, move: KaizoMove, field: CalcField, names: PkcalcNames, isCrit: boolean): PkcalcCalcInput {
  for (const side of [attacker, defender]) {
    if (side.curHp !== undefined || side.status !== undefined || side.boosts !== undefined || 'currentHp' in side.mon) {
      throw new Error('pkcalcInput takes only Pokémon at full HP with no status or stat stages');
    }
  }
  return {
    attacker: pkcalcMon(attacker, names), defender: pkcalcMon(defender, names),
    move: {
      name: names.move(move.id), basePower: move.power, type: TYPE_NAMES[move.type]!, category: move.category === 'physical' ? 'Physical' : 'Special',
      isCrit, hiddenPower: move.calc.baseMove === 'Hidden Power',
    },
    field: {
      gameType: field.doubles ? 'Doubles' : 'Singles', ...(field.weather !== undefined && { weather: WEATHERS[field.weather] }),
      isGravity: !!field.gravity, isReflect: !!field.reflect, isLightScreen: !!field.lightScreen,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The grid.

/** The level cap of each split: the next gym's, and 100 for the Galactic (Mt. Coronet) and Elite Four Splits. */
export const SPLIT_LEVEL_CAPS: Record<string, number> = {
  'Roark Split': 16, 'Gardenia Split': 28, 'Fantina Split': 38, 'Maylene Split': 47, 'Wake Split': 54, 'Byron Split': 65,
  'Candice Split': 74, 'Volkner Split': 84, 'Galactic Split': 100, 'Elite Four Split': 100,
};

/** A player Pokémon to calc with at any level: everything but the level, as the save holds it. Its base stats and types come from the ROM. */
export interface AttackerProfile {
  label: string; species: number; form: number; gender: 'M' | 'F' | null; nature: number; ability: number; item: number;
  ivs: Stats; evs: Stats; moves: number[];
}

const ivs = (hp: number, atk: number, def: number, spa: number, spd: number, spe: number): Stats => ({ hp, atk, def, spa, spd, spe });
const NO_EVS = ivs(0, 0, 0, 0, 0, 0);

/**
 * The player's first three party Pokémon in his save on 2026-11-08, one per type pair: Monferno (Fire/Fighting, Blaze),
 * Delibird (Ice/Flying, Adaptability) and Phanpy (Ground, Dry Skin). Pinned, so that the grid does not change as he plays.
 */
export const DERI_PROFILES: AttackerProfile[] = [
  { label: 'Monferno', species: 391, form: 0, gender: 'M', nature: 8, ability: 66, item: 0, ivs: ivs(0, 26, 12, 10, 7, 24), evs: NO_EVS, moves: [10, 52, 2, 290] },
  { label: 'Delibird', species: 225, form: 0, gender: 'F', nature: 4, ability: 91, item: 0, ivs: ivs(20, 21, 5, 12, 11, 17), evs: NO_EVS, moves: [217, 181, 16] },
  { label: 'Phanpy', species: 231, form: 0, gender: 'M', nature: 2, ability: 87, item: 0, ivs: ivs(25, 11, 3, 12, 23, 29), evs: NO_EVS, moves: [175, 55, 88, 91] },
];

/** A profile at `level`, as a battle Pokémon at full HP. */
export function profileMon(profile: AttackerProfile, level: number, data: LoadedData): ResolvedMon {
  const row = personalRowFor(profile.species, profile.form);
  const record = data.rom.species[row];
  if (record === undefined) throw new Error(`The ROM has no species record ${row}`);
  return {
    species: profile.species, form: profile.form, name: data.names.species(profile.species, profile.form), level, gender: profile.gender,
    ivs: { ...profile.ivs }, evs: { ...profile.evs }, nature: { value: profile.nature, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: profile.ability, source: 'rom', disputed: false, alternatives: [] }, item: profile.item, moves: [...profile.moves],
    baseStats: { ...record.baseStats }, types: [...record.types], friendship: record.baseFriendship,
  };
}

/**
 * Three opponents of each split with a level cap, in docs order: its first, its first double battle (its middle
 * trainer if it has none), and its last.
 */
export function gridTrainers(catalog: TrainerCatalog): ResolvedTrainer[] {
  return Object.keys(SPLIT_LEVEL_CAPS).flatMap((split) => {
    const own = catalog.trainers.filter((trainer) => trainer.split === split);
    const double = own.findIndex((trainer) => trainer.battleType === 'double');
    const picks = [...new Set([0, double >= 0 ? double : Math.floor((own.length - 1) / 2), own.length - 1])].filter((i) => i >= 0);
    return picks.sort((a, b) => a - b).map((i) => own[i]!);
  });
}

/** A Pokémon's first `count` moves that deal damage, in move order. Psywave is left out: its rolls are not equally likely. */
export function damagingMoves(mon: BattleMon, moves: Map<number, KaizoMove>, count = 2): KaizoMove[] {
  return mon.moves.map((id) => moves.get(id))
    .filter((move): move is KaizoMove => move !== undefined && move.category !== 'status' && move.power > 0 && move.calc.fixedDamage !== 'psywave')
    .slice(0, count);
}

/** One calc of the grid. `key` names it as a diff key does. */
export interface CalcCase { key: string; attacker: CalcSide; defender: CalcSide; move: KaizoMove; field: CalcField }

/**
 * Every trainer Pokémon against every profile at its split's level cap, both ways, with each attacker's first two
 * damaging moves, on the trainer's field (its docs field note, and doubles for a double battle). Keys read "Roark Split:
 * Leader Roark [ROM 246] mon 3 (Cranidos) Headbutt vs. Monferno L16" for the trainer's move, and "… mon 3 (Cranidos) hit
 * by Monferno L16 Ember" for the profile's.
 */
export function calcGrid(trainers: ResolvedTrainer[], profiles: AttackerProfile[], data: LoadedData, moves: Map<number, KaizoMove>): CalcCase[] {
  return trainers.flatMap((trainer) => {
    const level = SPLIT_LEVEL_CAPS[trainer.split];
    if (level === undefined) throw new Error(`No level cap for ${trainer.split}`);
    const field: CalcField = { ...fieldFromNote(trainer.field), ...(trainer.battleType === 'double' && { doubles: true }) };
    return trainer.party.flatMap((mon, slot) => profiles.flatMap((profile) => {
      const player = profileMon(profile, level, data);
      const at = `${trainer.split}: ${trainer.name} [ROM ${trainer.romIndex}] mon ${slot + 1} (${mon.name})`;
      const theirs = damagingMoves(mon, moves).map((move): CalcCase => ({ key: `${at} ${move.name} vs. ${profile.label} L${level}`, attacker: { mon }, defender: { mon: player }, move, field }));
      const ours = damagingMoves(player, moves).map((move): CalcCase => ({ key: `${at} hit by ${profile.label} L${level} ${move.name}`, attacker: { mon: player }, defender: { mon }, move, field }));
      return [...theirs, ...ours];
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The comparison.

/**
 * Field suffixes for a difference whose cause is shown: PKCalc gives our rolls once it is given one of our choices that
 * differ from its own:
 * - `unmodelled`: for a move whose damage effect our calc leaves out (`unmodelled`), the base move our calc runs in
 *   place of the move's own (`calc.baseMove`), so the difference is exactly the effect PKCalc models by the move's name;
 * - the cartridge's punch and sound tables (`moveFlags`), the ROM's move target, Hidden Power's type and power from our
 *   `hiddenPower`;
 * - for Fling, a plain hit of the held item's fling power in the ROM's item data (`fling-power`: ours runs Fling that
 *   way), so the difference is PKCalc's fling power for the item.
 */
export const CALC_CAUSES = ['unmodelled', 'punch-sound', 'target', 'hidden-power', 'fling-power'] as const;

/**
 * The suffix for a difference on an `unmodelled` move that no cause shows: no group accepts it, so the real check fails
 * on it, as it may hide a real bug.
 */
export const UNEXPLAINED = 'unexplained';

/**
 * The suffix for an OHKO move (`isOhko`) whose 16 rolls are all exactly the target's HP: our calc deals the target's
 * current HP when an OHKO move hits (`BtlCmd_TryOHKOMove`, pokeplatinum src/battle/battle_script.c:4334-4383), where PKCalc runs it on its power-1 numbers. Shown by our own rolls, with no PKCalc rerun; an OHKO move whose
 * rolls are anything else (0 when Sturdy or a type stops it) gets no such label.
 */
export const OHKO = 'ohko';

/** The target's HP in a case: its `curHp`, else full, within 0 to max HP, as the calc takes it. */
function targetHp(side: CalcSide): number {
  const { mon } = side;
  const maxHp = calcHp(mon.baseStats.hp, mon.ivs.hp, mon.evs.hp, mon.level);
  return Math.min(maxHp, Math.max(0, side.curHp ?? maxHp));
}

/**
 * What `diffCalc` compared: grid cases, rolls compared (16 each, normal and critical), trainers, trainer Pokémon and
 * distinct moves, how many comparisons had damage on our side, and how many differed.
 */
export interface CalcCoverage { cases: number; rolls: number; trainers: number; trainerMons: number; moves: number; damaging: number; differing: number }

const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Our 16 rolls against PKCalc's for each case, normal (field `rolls`) and as a critical hit (`crit-rolls`), with
 * identical inputs (`pkcalcInput`). A difference is a Diff in area `calc`, ours as `rom` and PKCalc's as `docs`. Its
 * field gets a `CALC_CAUSES` suffix ("rolls-punch-sound") where the cause is shown, by PKCalc giving our rolls once
 * given our choice (the first of them that does, `unmodelled` first). An OHKO move whose rolls are all the target's HP
 * gets `OHKO` instead. A difference on an unmodelled move that no cause shows gets `UNEXPLAINED`; one on a modelled move
 * keeps its plain field.
 */
export async function diffCalc(page: Page, cases: CalcCase[], names: PkcalcNames): Promise<{ diffs: Diff[]; coverage: CalcCoverage }> {
  return await diffCalcWith((inputs) => pkcalcRollsAll(page, inputs), cases, names);
}

/** Each input's 16 rolls from PKCalc's own calc, as `pkcalcRollsAll` gives them from its page. */
export type PkcalcRolls = (inputs: PkcalcCalcInput[]) => Promise<number[][]>;

/** `diffCalc`, with PKCalc's calc as `rollsOf`. */
export async function diffCalcWith(rollsOf: PkcalcRolls, cases: CalcCase[], names: PkcalcNames): Promise<{ diffs: Diff[]; coverage: CalcCoverage }> {
  const runs = cases.flatMap((c) => [false, true].map((isCrit) => {
    const ours = damage(c.attacker, c.defender, c.move, c.field);
    if (ours === null) throw new Error(`${c.key}: the move deals no damage`);
    return { c, field: isCrit ? 'crit-rolls' : 'rolls', ours: isCrit ? ours.critRolls : ours.rolls, input: pkcalcInput(c.attacker, c.defender, c.move, c.field, names, isCrit) };
  }));
  const theirs = await rollsOf(runs.map((run) => run.input));
  const differing = runs.map((run, i) => ({ ...run, theirs: theirs[i]! })).filter((run) => !same(run.ours, run.theirs));
  const ohko = new Set(differing.filter((run) => {
    const hp = targetHp(run.c.defender);
    return isOhko(run.c.move) && hp > 0 && run.ours.every((roll) => roll === hp);
  }));

  // Each cause's input, for every other difference.
  const tests = differing.filter((run) => !ohko.has(run)).flatMap((run) => {
    const { move } = run.c;
    const flags = moveFlags(move);
    const own = hiddenPower(run.c.attacker.mon.ivs);
    const variants: [string, PkcalcCalcInput][] = [];
    if (move.unmodelled !== null) variants.push(['unmodelled', { ...run.input, move: { ...run.input.move, name: move.calc.baseMove } }]);
    variants.push(
      ['punch-sound', { ...run.input, move: { ...run.input.move, flags: { punch: flags.punch, sound: flags.sound } } }],
      ['target', { ...run.input, move: { ...run.input.move, target: smogonTarget(move.target) } }],
    );
    if (run.input.move.hiddenPower) variants.push(['hidden-power', { ...run.input, move: { ...run.input.move, hiddenPower: false, basePower: own.power, type: TYPE_NAMES[own.type]! } }]);
    const flingPower = move.calc.baseMove === 'Fling' ? move.calc.flingPower?.[run.c.attacker.mon.item] : undefined;
    if (flingPower !== undefined) {
      const plain = move.category === 'special' ? 'Swift' : 'Tackle';
      variants.push(['fling-power', { ...run.input, move: { ...run.input.move, name: plain, basePower: flingPower } }]);
    }
    return variants.map(([cause, input]) => ({ run, cause, input }));
  });
  const testRolls = await rollsOf(tests.map((test) => test.input));
  const shown = new Map<(typeof differing)[number], string>();
  tests.forEach((test, i) => {
    if (!shown.has(test.run) && same(testRolls[i]!, test.run.ours)) shown.set(test.run, test.cause);
  });

  const diffs = differing.map((run): Diff => {
    const cause = ohko.has(run) ? OHKO : shown.get(run) ?? (run.c.move.unmodelled !== null ? UNEXPLAINED : undefined);
    return { area: 'calc', key: run.c.key, field: cause === undefined ? run.field : `${run.field}-${cause}`, rom: run.ours, docs: run.theirs };
  });
  const trainerKeys = new Set(cases.map((c) => c.key.replace(/ mon \d+ \(.*$/, '')));
  const monKeys = new Set(cases.map((c) => c.key.replace(/\) .*$/, ')')));
  const moveIds = new Set(cases.map((c) => c.move.id));
  return {
    diffs,
    coverage: {
      cases: cases.length, rolls: runs.length, trainers: trainerKeys.size, trainerMons: monKeys.size, moves: moveIds.size,
      damaging: runs.filter((run) => Math.max(...run.ours) > 0).length, differing: differing.length,
    },
  };
}
