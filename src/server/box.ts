// The box as the page sees it (`BoxJson`, `GET /api/box`): every party and box Pokémon with its names, HP, PP, status,
// IVs, EVs and Hidden Power, the reasons it cannot fight, the key that follows it by its PID and its Showdown set (the
// sheet's text, for the page's Copy party and Copy box), plus the team the planner may fight with. A Pokémon the data
// cannot name, or whose record fails its checksum, is listed and flagged ineligible; it never makes the box fail (spec
// section 7).

import { hiddenPower } from '../battle/moves.js';
import { eligibleTeam, MAX_LEVEL, type OriginTrainer, type PlayerMon, toPlayerMon } from '../battle/playerMon.js';
import type { BoxDraftJson } from '../contracts/api.js';
import type { LocalData } from '../data/load.js';
import { personalRowFor } from '../rom/forms.js';
import { NATURES } from '../rom/natures.js';
import { computeStats, natureMultipliers } from '../rom/stats.js';
import { TYPE_NAMES } from '../rom/tables.js';
import type { Stats } from '../rom/types.js';
import { ineligibleReasons, readSave, type SaveLocation, type SaveMon } from '../save/readSave.js';
import { isShiny, saveSpriteForm } from '../sprites/forms.js';
import type { BoxJson, BoxMonJson, MonRef, NatureStat, SettingsJson } from './apiTypes.js';
import { statusToJson } from './json.js';
import { levelCapFor } from './levelCap.js';
import { runFights, runOf, splitsOf } from './run.js';
import { readTrainerInfo } from './saveInfo.js';
import { graveyardBoxes } from './settings.js';
import { showdownSet } from './showdown.js';

/**
 * The box for the page, the eligible team in `eligibleTeam` order, and each eligible Pokémon by its MonRef. `pool` is
 * every Pokémon that may join a draft, by its MonRef: the eligible ones and those over the level cap (a superset of
 * `byRef`'s refs), so exactly those whose `BoxMonJson.draft` is non-null. It never holds one in the graveyard, a fainted
 * one, an egg, or one the data cannot read or name.
 */
export interface BoxState { json: BoxJson; team: PlayerMon[]; byRef: Map<MonRef, PlayerMon>; pool: Map<MonRef, PlayerMon> }

const PARTY_SLOTS = 6;
const BOXES = 18;
const BOX_SLOTS = 30;

/** `party:<slot>` or `box:<box>:<slot>`, 1-based. */
export function monRef(l: SaveLocation): MonRef {
  return l.kind === 'party' ? `party:${l.slot}` : `box:${l.box}:${l.slot}`;
}

/** The key a Pokémon keeps wherever it moves: "pid:" and its PID as 8 lowercase hex digits ("pid:0000002a" for 42). */
export function monKey(pid: number): string {
  return `pid:${(pid >>> 0).toString(16).padStart(8, '0')}`;
}

const PARTY_REF = /^party:([1-9]\d*)$/;
const BOX_REF = /^box:([1-9]\d*):([1-9]\d*)$/;

/** The location `ref` names, or null for anything that is not a party slot 1–6 or a box 1–18 slot 1–30 written as `monRef` writes it. */
export function parseMonRef(ref: string): SaveLocation | null {
  const party = PARTY_REF.exec(ref);
  if (party) {
    const slot = Number(party[1]);
    return slot <= PARTY_SLOTS ? { kind: 'party', slot } : null;
  }
  const box = BOX_REF.exec(ref);
  if (box) {
    const [number, slot] = [Number(box[1]), Number(box[2])];
    return number <= BOXES && slot <= BOX_SLOTS ? { kind: 'box', box: number, slot } : null;
  }
  return null;
}

type EligibilityOpts = { graveyardBoxes: number[]; levelCap: number };

/**
 * Reads the save and builds the box. Badges come from the save; the level cap is `levelCapFor(badges, override)`, the
 * graveyard (`json.graveyardBoxes`) `graveyardBoxes(settings)`. `json.mons` holds the party, then the boxes by box and
 * slot; each Pokémon, an unreadable one included, has its `key` (`monKey` of its PID). The team is `eligibleTeam` over
 * the Pokémon whose species and moves all resolve, so one the data cannot name never reaches it; the pool is the same
 * with no level cap. `json.run` is the badge count's split among the docs' splits (`runOf`), with that split's fights and
 * the next one by the save's trainer-defeated flags (`runFights`). Throws `SaveError` for a file that is not a save.
 */
export function buildBox(input: { file: Uint8Array; savePath: string; savedAt: Date; data: LocalData; settings: SettingsJson }): BoxState {
  const { file, savePath, savedAt, data, settings } = input;
  const save = readSave(file, data.rom);
  const { badges } = readTrainerInfo(file);
  const levelCap = levelCapFor(badges, settings.levelCapOverride);
  const opts: EligibilityOpts = { graveyardBoxes: graveyardBoxes(settings), levelCap };

  const mons: BoxMonJson[] = [];
  const known: SaveMon[] = [];
  for (const m of [...save.party, ...save.boxes]) {
    if (m.badChecksum) {
      mons.push(unreadableJson(m, opts));
      continue;
    }
    const unknown = unknownIds(m, data);
    mons.push(monJson(m, data, opts, unknown, save.trainer));
    if (unknown.length === 0) known.push(m);
  }

  const inParty = (m: SaveMon) => m.location.kind === 'party';
  const team = eligibleTeam({ party: known.filter(inParty), boxes: known.filter((m) => !inParty(m)), trainer: save.trainer }, data, opts);
  const pool = eligibleTeam({ party: known.filter(inParty), boxes: known.filter((m) => !inParty(m)), trainer: save.trainer }, data, { graveyardBoxes: opts.graveyardBoxes, levelCap: MAX_LEVEL });
  const place = runOf(badges, splitsOf(data.docs));
  const run = { ...place, ...runFights(place.split, data, save.defeatedTrainers) };
  return {
    json: { savePath, savedAt: savedAt.toISOString(), badges, levelCap, graveyardBoxes: opts.graveyardBoxes, mons, run },
    team,
    byRef: new Map(team.map((mon) => [monRef(mon.location), mon])),
    pool: new Map(pool.map((mon) => [monRef(mon.location), mon])),
  };
}

function where(l: SaveLocation): Pick<BoxMonJson, 'location' | 'box' | 'slot'> {
  return l.kind === 'party' ? { location: 'party', box: null, slot: l.slot } : { location: 'box', box: l.box, slot: l.slot };
}

/** The name `lookup` gives, or null when it throws (the name index throws for a species or move the docs lack). */
function nameOrNull(lookup: () => string): string | null {
  try {
    return lookup();
  } catch {
    return null;
  }
}

const speciesName = (m: SaveMon, data: LocalData) => nameOrNull(() => data.names.species(m.species, m.form));
const moveName = (id: number, data: LocalData) => nameOrNull(() => data.names.move(id));

/**
 * `unknown species <id>` (with the form when it is not 0) when the species is past 493 (the ROM's rows past 493 are
 * forms' rows, which no Pokémon holds as its species, and the fight engine knows 1 to 493), the docs cannot name it or the
 * ROM lacks its
 * Personal row (`toPlayerMon` needs both), and one `unknown move <id>` per move the docs cannot name or the ROM lacks
 * (its record gives the base PP, and the calc needs it).
 */
function unknownIds(m: SaveMon, data: LocalData): string[] {
  const reasons: string[] = [];
  if (m.species > LAST_SPECIES || speciesName(m, data) === null || personalRecord(m, data) === undefined) {
    reasons.push(m.form === 0 ? `unknown species ${m.species}` : `unknown species ${m.species} form ${m.form}`);
  }
  for (const id of new Set(m.moves)) if (moveName(id, data) === null || data.rom.moves[id] === undefined) reasons.push(`unknown move ${id}`);
  // Only a corrupt or crafted record has none, and a battle cannot start with a Pokémon that has no move.
  if (m.moves.length === 0) reasons.push(NO_MOVES);
  return reasons;
}

/** The last species a save may hold, and the last the fight engine knows (Arceus). */
export const LAST_SPECIES = 493;
/** Why a Pokémon with no moves cannot fight (`BoxMonJson.ineligibleReasons`). */
export const NO_MOVES = 'no moves';

/**
 * The ROM's Personal record for `m`'s species and form (`personalRowFor`), or undefined when the ROM lacks it or the form
 * is one `personalRowFor` throws for: an unknown form of a species whose forms have rows of their own (Deoxys, Wormadam,
 * Rotom, Giratina, Shaymin), which only a corrupt or crafted record holds. Such a Pokémon reads as an unknown species.
 */
function personalRecord(m: SaveMon, data: LocalData): LocalData['rom']['species'][number] | undefined {
  try {
    return data.rom.species[personalRowFor(m.species, m.form)];
  } catch {
    return undefined;
  }
}

/** The stats a nature can raise or lower. */
const NATURE_STATS: readonly NatureStat[] = ['atk', 'def', 'spa', 'spd', 'spe'];

/** The stats `nature` (0–24) raises and lowers, by its multipliers, or null for a neutral nature. */
function natureEffect(nature: number): BoxMonJson['natureEffect'] {
  const multipliers = natureMultipliers(nature);
  const up = NATURE_STATS.find((stat) => multipliers[stat] > 1);
  const down = NATURE_STATS.find((stat) => multipliers[stat] < 1);
  return up === undefined || down === undefined ? null : { up, down };
}

/**
 * Hidden Power's type, by name, and power for these IVs. The hack leaves Hidden Power as Gen 4 has it: the docs'
 * Moves.csv gives move 237 power 1 (the variable-power marker), Move Changes.csv has no Hidden Power row, and the ROM's
 * move 237 has power 1 too. So the Gen 4 formula (`hiddenPower`) holds.
 */
function hiddenPowerJson(ivs: Stats): BoxMonJson['hiddenPower'] {
  const { type, power } = hiddenPower(ivs);
  return { type: TYPE_NAMES[type]!, power };
}

/** A Personal row's two type IDs by name, once when both are the same type. */
function typeNames(types: [number, number]): string[] {
  return [...new Set(types)].map((id) => TYPE_NAMES[id] ?? `(type ${id})`);
}

/**
 * One readable Pokémon. `maxHp` is the stat formula's (the stored max HP of a party Pokémon whose species the ROM lacks,
 * else 0); `hp` is the party's current HP, or `maxHp` in a box, as the PC heals it. A move's `maxPp` is
 * floor(base PP × (5 + PP Ups) / 5) from the ROM record, or 0 for a move the ROM lacks. A species or move the docs cannot
 * name shows as "(species <id>)" or "(move <id>)", as the name index writes unknown items. `ivs` and `evs` are the
 * record's; `hiddenPower` and `natureEffect` come from them and the nature. `types` are its form's Personal row's (`typeNames`),
 * none when the ROM lacks the row. `notes` and `showdown` come from its
 * `toPlayerMon`, which the team and so the sheet use too; a Pokémon with `unknown` IDs has none, and an egg no set.
 * `draft` (`draftJson`) is there exactly when it has its `toPlayerMon` and no reason but "over cap": the same Pokémon
 * as the box's pool.
 */
/** `m`'s sprite form (`formId`, only for a form with a look of its own) and `shiny` (only when it is, and not an egg). */
function spriteLook(m: SaveMon): Pick<BoxMonJson, 'formId' | 'shiny'> {
  const form = saveSpriteForm(m.species, m.form);
  return { ...(form === undefined ? {} : { formId: form }), ...(!m.isEgg && isShiny(m.pid, m.otId) ? { shiny: true as const } : {}) };
}

function monJson(m: SaveMon, data: LocalData, opts: EligibilityOpts, unknown: string[], trainer: OriginTrainer): BoxMonJson {
  const player = unknown.length === 0 ? toPlayerMon(m, data, trainer) : null;
  const record = personalRecord(m, data);
  const maxHp = record === undefined ? m.storedStats?.hp ?? 0 : computeStats(record.baseStats, m.ivs, m.evs, m.level, m.nature).hp;
  const inParty = m.location.kind === 'party';
  const reasons = [...ineligibleReasons(m, opts), ...unknown];
  const draftable = player !== null && reasons.every((reason) => reason === 'over cap');
  return {
    ref: monRef(m.location),
    key: monKey(m.pid),
    nickname: m.nickname,
    species: speciesName(m, data) ?? (m.form === 0 ? `(species ${m.species})` : `(species ${m.species} form ${m.form})`),
    speciesId: m.species,
    ...spriteLook(m),
    level: m.level,
    nature: NATURES[m.nature] ?? null,
    natureEffect: natureEffect(m.nature),
    types: record === undefined ? [] : typeNames(record.types),
    ivs: m.ivs,
    evs: m.evs,
    hiddenPower: hiddenPowerJson(m.ivs),
    ability: data.names.ability(m.ability),
    item: m.item === 0 ? null : data.names.item(m.item),
    moves: m.moves.map((id, k) => {
      const basePp = data.rom.moves[id]?.pp;
      return {
        name: moveName(id, data) ?? `(move ${id})`,
        pp: m.pp[k] ?? 0,
        maxPp: basePp === undefined ? 0 : Math.floor((basePp * (5 + (m.ppUps[k] ?? 0))) / 5),
      };
    }),
    hp: inParty ? m.currentHp ?? maxHp : maxHp,
    maxHp,
    status: inParty ? statusToJson(m.status) : null,
    ...where(m.location),
    eligible: reasons.length === 0,
    ineligibleReasons: reasons,
    notes: player?.notes ?? [],
    showdown: player === null || m.isEgg ? null : showdownSet(player, data.names),
    draft: draftable ? draftJson(m, data) : null,
  };
}

/**
 * What a draft may change of `m`, a Pokémon whose species and moves all resolve (so its form's Personal row exists).
 * `growthRate` is the species' own row's, never a form's, as the engine reads it (src/engine/dex.ts `growthTableOf`;
 * the form's row only if the ROM lacked the species' row, which keeps the box readable); `baseStats` is its form's row
 * (`personalRowFor`), as `toPlayerMon` and `maxHp` compute its stats. `moves` lines up with the save's moves.
 * `learnset` is the ROM's level-up moves for its form's row, in ROM order, each named ("(move <id>)" when the docs lack
 * it) with its base PP (0 when the ROM lacks it).
 */
function draftJson(m: SaveMon, data: LocalData): BoxDraftJson {
  const row = personalRowFor(m.species, m.form);
  const record = data.rom.species[row]!;
  return {
    exp: m.exp,
    growthRate: (data.rom.species[m.species] ?? record).growthRate,
    baseStats: { ...record.baseStats },
    nature: m.nature,
    item: m.item,
    moves: m.moves.map((id, k) => ({ id, ppUps: m.ppUps[k] ?? 0 })),
    learnset: (data.rom.learnsets[row] ?? []).map((entry) => ({
      level: entry.level, id: entry.move, name: moveName(entry.move, data) ?? `(move ${entry.move})`, pp: data.rom.moves[entry.move]?.pp ?? 0,
    })),
  };
}

/**
 * A record that fails its checksum: its fields are garbage, so it shows only where it is, as "Unreadable", with the
 * reasons that do not read those fields (`dead` from its box, and `bad checksum`), and no IVs, EVs, Hidden Power,
 * nature effect, types, Showdown set or draft facts. Its key still holds: the PID is the record's unencrypted first word.
 */
function unreadableJson(m: SaveMon, opts: EligibilityOpts): BoxMonJson {
  return {
    ref: monRef(m.location), key: monKey(m.pid),
    nickname: '', species: 'Unreadable', speciesId: 0, level: 0, nature: null, natureEffect: null, types: [], ivs: null, evs: null, hiddenPower: null,
    ability: '', item: null, moves: [],
    hp: 0, maxHp: 0, status: null, ...where(m.location), eligible: false,
    ineligibleReasons: ineligibleReasons(m, opts).filter((reason) => reason === 'dead' || reason === 'bad checksum'),
    notes: [], showdown: null, draft: null,
  };
}
