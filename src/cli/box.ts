// `npm run box -- --save <path> [--cap N]`: prints the party, then the boxes, one line per Pokémon with names from the
// docs. It needs the data `npm run extract` saves in `data/`.

import { parseArgs } from 'node:util';
import type { NameIndex } from '../names/nameIndex.js';
import { NATURES } from '../rom/natures.js';
import { DEFAULT_GRAVEYARD_BOXES, ineligibleReasons, type SaveMon } from '../save/readSave.js';
import { fail, loadData, loadSave, parseCap, statusCode } from './common.js';

const USAGE = 'Usage: npm run box -- --save <path> [--cap N]';

/** The `--save` path and the `--cap` level, if given. Bad arguments print one line with the usage. */
function cliArgs(): { save: string; cap: number | undefined } {
  let values: { save?: string; cap?: string } = {};
  try {
    values = parseArgs({ options: { save: { type: 'string' }, cap: { type: 'string' } } }).values;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
  }
  const save = values.save ?? fail(USAGE);
  return { save, cap: values.cap === undefined ? undefined : parseCap(values.cap, USAGE) };
}

/** The name `lookup` gives, or `fallback` when the docs lack the ID and it throws. */
function nameOr(lookup: () => string, fallback: string): string {
  try {
    return lookup();
  } catch {
    return fallback;
  }
}

/**
 * `party 1  Mon (Monferno) Lv 15  Impish  Blaze  @Quick Claw  Scratch/Ember  IVs 0/26/12/10/7/24  [over cap]`: the
 * location, then the fields, two spaces apart. Empty fields (no status, no item) are left out. A bad checksum record's
 * fields are garbage, so its line is the location and `[bad checksum]` alone.
 */
function monLine(m: SaveMon, names: NameIndex, cap: number | undefined): string {
  const where = m.location.kind === 'party' ? `party ${m.location.slot}` : `box ${m.location.box} slot ${m.location.slot}`;
  if (m.badChecksum) return `${where}  [bad checksum]`;
  const flags = ineligibleReasons(m, { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: cap }).map((reason) => `[${reason}]`);
  const species = nameOr(() => names.species(m.species, m.form), m.form === 0 ? `species ${m.species}` : `species ${m.species} form ${m.form}`);
  const { hp, atk, def, spa, spd, spe } = m.ivs;
  return [
    where,
    `${m.nickname} (${species}) Lv ${m.level}`,
    NATURES[m.nature]!,
    statusCode(m.status),
    names.ability(m.ability),
    m.item === 0 ? '' : `@${names.item(m.item)}`,
    m.moves.map((id) => nameOr(() => names.move(id), `(move ${id})`)).join('/'),
    `IVs ${hp}/${atk}/${def}/${spa}/${spd}/${spe}`,
    flags.join(' '),
  ].filter(Boolean).join('  ');
}

const { save, cap } = cliArgs();
const data = loadData();
const { party, boxes } = loadSave(save, data);
for (const m of [...party, ...boxes]) console.log(monLine(m, data.names, cap));
