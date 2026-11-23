// Where the alternate forms' sprites are, and how a battle's or a save's form becomes a sprite's form.
//
// `poketool/pokegra/pl_otherpoke.narc` holds the form sprites (NCGR 0–153, encrypted as the battle sprites are) and their
// palettes (NCLR 154–247), mapped on the hack's ROM by rendering every file and checking form 0 against the species'
// own sprite and palettes (see FORM_SPRITES). Most species lie back then front for each form, with a normal then a shiny
// palette for each form; Castform and Cherrim lie all backs then all fronts, all normal palettes then all shiny ones;
// Deoxys and Unown share one palette pair across their forms. The menu icons of the forms that have their own lie in
// `pl_poke_icon.narc` after species 493 (500 is Arceus's own; 501 and 502 the eggs): Deoxys 503–505, Unown 506–533 (A
// to ?, A again first), Burmy 534–535, Wormadam 536–537, Shellos 538, Gastrodon 539, Giratina 540, Shaymin 541, Rotom
// 542–546. Castform, Cherrim and Arceus keep the species' icon.

import { FORMS } from '../rom/forms.js';

/** One species' form sprites: its form count (form 0 included), and each form's files. `icon` null: the species' icon. */
export interface FormSprites {
  readonly forms: number;
  back(form: number): number;
  front(form: number): number;
  palette(form: number, shiny: boolean): number;
  icon(form: number): number | null;
}

/** Back, front, normal palette, shiny palette in that order for each form, from `firstChar` and `firstPalette`. */
function paired(forms: number, firstChar: number, firstPalette: number, icon: (form: number) => number | null = () => null): FormSprites {
  return {
    forms,
    back: (form) => firstChar + form * 2,
    front: (form) => firstChar + form * 2 + 1,
    palette: (form, shiny) => firstPalette + form * 2 + (shiny ? 1 : 0),
    icon: (form) => (form === 0 ? null : icon(form)),
  };
}

/** By species ID: the species whose forms look different, with where their sprites are in `pl_otherpoke.narc`. */
export const FORM_SPRITES: Readonly<Record<number, FormSprites>> = {
  386: { forms: 4, back: (f) => f * 2, front: (f) => f * 2 + 1, palette: (_f, shiny) => 154 + (shiny ? 1 : 0), icon: (f) => (f === 0 ? null : 502 + f) },   // Deoxys
  201: { forms: 28, back: (f) => 8 + f * 2, front: (f) => 9 + f * 2, palette: (_f, shiny) => 156 + (shiny ? 1 : 0), icon: (f) => (f === 0 ? null : 506 + f) }, // Unown
  351: { forms: 4, back: (f) => 64 + f, front: (f) => 68 + f, palette: (f, shiny) => 158 + (shiny ? 4 : 0) + f, icon: () => null },                         // Castform
  412: paired(3, 72, 166, (f) => 533 + f),   // Burmy
  413: paired(3, 78, 172, (f) => 535 + f),   // Wormadam
  421: { forms: 2, back: (f) => 92 + f, front: (f) => 94 + f, palette: (f, shiny) => 186 + (shiny ? 2 : 0) + f, icon: () => null },                         // Cherrim
  422: paired(2, 84, 178, (f) => 537 + f),   // Shellos
  423: paired(2, 88, 182, (f) => 538 + f),   // Gastrodon
  493: paired(18, 96, 190),                  // Arceus
  492: paired(2, 134, 228, () => 541),       // Shaymin
  479: paired(6, 138, 232, (f) => 541 + f),  // Rotom
  487: paired(2, 150, 244, () => 540),       // Giratina
};

/** Arceus's forms by Showdown forme (its type), in the ROM's type order: Normal is form 0 and "???" (form 9) has no forme. */
const ARCEUS_FORMES = ['', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];

/**
 * The sprite form of a battle Pokémon of species `num` whose Showdown forme is `forme` ("Wash", "Sunny", "B"), as the
 * engine names a form (src/engine/ids.ts `speciesId`, from src/rom/forms.ts's names) or a battle changes it (Forecast,
 * Flower Gift, Multitype): its form number when that is not 0 and has a sprite, else undefined (the default sprite).
 */
export function spriteFormOf(num: number, forme: string): number | undefined {
  const sprites = FORM_SPRITES[num];
  if (sprites === undefined || forme === '') return undefined;
  const form = num === 493 ? ARCEUS_FORMES.indexOf(forme) : (FORMS[num] ?? []).findIndex((entry) => entry.name === forme);
  return form > 0 && form < sprites.forms ? form : undefined;
}

/**
 * The sprite form of form `form` of species `species` (a save's form bits, or the ROM trainer data's form): the form when
 * it is not 0 and has a sprite, else undefined.
 */
export function saveSpriteForm(species: number, form: number): number | undefined {
  const sprites = FORM_SPRITES[species];
  return sprites !== undefined && form > 0 && form < sprites.forms ? form : undefined;
}

/** A JSON Pokémon's sprite keys: `speciesId`, and `formId` when its form has a sprite of its own and is not 0. */
export function spriteIds(species: number, form: number): { speciesId: number; formId?: number } {
  const formId = saveSpriteForm(species, form);
  return formId === undefined ? { speciesId: species } : { speciesId: species, formId };
}

/** Whether a Pokémon with personality `pid` and original trainer `otId` (trainer ID low, secret ID high) is shiny (Gen 4). */
export function isShiny(pid: number, otId: number): boolean {
  return ((otId >>> 16) ^ (otId & 0xffff) ^ (pid >>> 16) ^ (pid & 0xffff)) < 8;
}

/** The cache file name of a sprite: `<species>.png`, `<species>-<form>.png`, with `-shiny` before `.png` for a shiny one. */
export function spriteFileName(species: number, form = 0, shiny = false): string {
  return `${species}${form > 0 ? `-${form}` : ''}${shiny ? '-shiny' : ''}.png`;
}
