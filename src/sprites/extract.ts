// The Pokémon sprites, extracted from the ROM the planner already reads into the data folder's git-ignored
// `sprites/`, as indexed PNGs whose index 0 is transparent: `front/` and `back/` (80×80) and `icon/` (32×32),
// each holding `<species>.png` for species 1–493, `<species>-<form>.png` for each alternate form with its own look
// (forms.ts `FORM_SPRITES`), and for front and back `…-shiny.png` in the shiny palette too (icons have no shiny colours;
// a form without an icon of its own gets the species' icon). They are the game's own art: never committed, never
// published.
//
// Where they are (Platinum's layout, which the hack keeps):
// - `poketool/pokegra/pl_pokegra.narc`: six files a species, from species 0 (a placeholder): back female, back male,
//   front female, front male (NCGR, 160×80 scanned rows holding two 80×80 frames side by side, encrypted: nitro.ts
//   `decryptPlatinum`), then the normal and the shiny palette (NCLR, 16 colours). A species without a female difference
//   (genderless and male-only ones too) has empty female files; a female-only one (Nidoran♀, Chansey, Cresselia: 16 in
//   the hack) has empty male files. The male file is the default, else the female one. The first frame is the sprite.
//   Form 0 of every species is drawn from here.
// - `poketool/pokegra/pl_otherpoke.narc`: the alternate forms' sprites and palettes (forms.ts).
// - `poketool/icongra/pl_poke_icon.narc`: file 0 the 16 shared palettes (NCLR); 1–6 cells and animations; from file 7
//   one NCGR a species from species 0, 32×64 in 8×8 tiles, two 32×32 frames one above the other; the eggs and the forms'
//   icons after species 493 (forms.ts). Which palette an icon file uses is a table in ARM9 (one byte an icon file from
//   file 7), found by its first 16 entries (`ICON_PALETTE_SIGNATURE`), which match once in the hack's ARM9 and in the
//   vanilla game's.
//
// Left out (`NOT_EXTRACTED`): the female differences and the second frames.

import fs from 'node:fs';
import path from 'node:path';
import { RomError } from '../errors.js';
import { readNarc } from '../nds/narc.js';
import { readGameCode, readNdsFiles } from '../nds/ndsFs.js';
import { FORM_SPRITES, spriteFileName } from './forms.js';
import { decryptPlatinum, readNcgr, readNclr, scannedWindow, tiledImage } from './nitro.js';
import { encodeIndexedPng } from './png.js';

/** The version of the cache's layout, in its manifest; a cache of another version is extracted again. 2: forms and shiny. */
export const SPRITES_VERSION = 2;
export const SPRITE_KINDS = ['front', 'back', 'icon'] as const;
export type SpriteKind = (typeof SPRITE_KINDS)[number];
/** The side of each kind's PNG, in pixels. */
export const SPRITE_SIZE: Readonly<Record<SpriteKind, number>> = { front: 80, back: 80, icon: 32 };
/** What the cache does not hold yet. */
export const NOT_EXTRACTED: readonly string[] = ['the female differences (each shows the male sprite)', 'the second animation frames'];

const POKEGRA = 'poketool/pokegra/pl_pokegra.narc';
const OTHERPOKE = 'poketool/pokegra/pl_otherpoke.narc';
const ICONS = 'poketool/icongra/pl_poke_icon.narc';
const FILES_PER_SPECIES = 6;
const BACK_MALE = 1;
const FRONT_MALE = 3;
const NORMAL_PALETTE = 4;
const SHINY_PALETTE = 5;
const BATTLE_STRIDE = 160;
const ICON_PALETTES_FILE = 0;
const FIRST_ICON = 7;
const ICON_TILES = 4;
const COLOURS_A_PALETTE = 16;
const ARM9_OFFSET = 0x20;
const ARM9_SIZE = 0x2c;
/** The icon palette table's first 16 entries, species 0 (the placeholder) to Beedrill. */
export const ICON_PALETTE_SIGNATURE: readonly number[] = [0, 1, 1, 1, 0, 0, 0, 0, 2, 2, 1, 1, 0, 1, 2, 2];

/** What the cache holds, written last as `manifest.json`. `forms` counts the alternate forms with sprites. */
export interface SpriteManifest {
  version: typeof SPRITES_VERSION; gameCode: string; species: number; forms: number; shiny: true;
  kinds: readonly SpriteKind[]; sizes: Readonly<Record<SpriteKind, number>>; notExtracted: readonly string[];
}

/**
 * The ROM's sprites, decoded on request: `count` species (1 to `count`), how many forms with a look of their own each
 * has (`forms`, form 0 included: 1 for most), and the PNG of a kind for a species, form and colouring. A shiny icon is
 * the normal one, and a form without an icon of its own has the species'.
 */
export interface SpriteSource {
  gameCode: string; count: number;
  forms(species: number): number;
  png(kind: SpriteKind, species: number, form?: number, shiny?: boolean): Uint8Array;
}

/** The icon palette table in `arm9`: `length` entries from species 0. A RomError unless its signature matches exactly once. */
export function iconPaletteTable(arm9: Uint8Array, length: number): Uint8Array {
  const hits: number[] = [];
  for (let at = 0; at + ICON_PALETTE_SIGNATURE.length <= arm9.length && hits.length < 2; at++) {
    if (ICON_PALETTE_SIGNATURE.every((v, i) => arm9[at + i] === v)) hits.push(at);
  }
  if (hits.length !== 1) throw new RomError('BAD_FORMAT', `the icon palette table matches ${hits.length === 0 ? 'nowhere' : 'more than once'} in ARM9`);
  const at = hits[0]!;
  if (at + length > arm9.length) throw new RomError('BAD_FORMAT', `the icon palette table at 0x${at.toString(16)} runs past ARM9`);
  return arm9.slice(at, at + length);
}

/** The ROM's sprite source. A RomError when a file it needs is missing or not as described at the top of the file. */
export function spriteSource(rom: Uint8Array): SpriteSource {
  const files = readNdsFiles(rom);
  const narc = (name: string) => {
    const file = files.get(name);
    if (file === undefined) throw new RomError('MISSING_FILE', `the ROM has no ${name}`);
    return readNarc(file);
  };
  const graphics = narc(POKEGRA);
  const other = narc(OTHERPOKE);
  const icons = narc(ICONS);
  const count = Math.floor(graphics.length / FILES_PER_SPECIES) - 1;
  if (count < 1 || FIRST_ICON + count >= icons.length) throw new RomError('BAD_FORMAT', `${graphics.length} battle sprite files and ${icons.length} icon files do not hold the same species`);
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const arm9 = rom.subarray(view.getUint32(ARM9_OFFSET, true), view.getUint32(ARM9_OFFSET, true) + view.getUint32(ARM9_SIZE, true));
  const iconPalettes = readNclr(icons[ICON_PALETTES_FILE]!, `${ICONS} file ${ICON_PALETTES_FILE}`);
  const paletteOf = iconPaletteTable(arm9, icons.length - FIRST_ICON);
  const palettes = Math.floor(iconPalettes.length / COLOURS_A_PALETTE);
  paletteOf.forEach((p, i) => {
    if (p >= palettes) throw new RomError('BAD_FORMAT', `icon file ${FIRST_ICON + i}'s palette ${p} is not one of the ${palettes}`);
  });
  const fileOf = (archive: Uint8Array[], name: string, index: number) => {
    const file = archive[index];
    if (file === undefined || file.length === 0) throw new RomError('BAD_FORMAT', `${name} has no file ${index}`);
    return file;
  };

  const icon = (file: number) => {
    const pixels = tiledImage(readNcgr(fileOf(icons, ICONS, file), `${ICONS} file ${file}`).data, 0, ICON_TILES, ICON_TILES);
    const p = paletteOf[file - FIRST_ICON]!;
    return encodeIndexedPng(SPRITE_SIZE.icon, SPRITE_SIZE.icon, pixels, iconPalettes.slice(p * COLOURS_A_PALETTE, (p + 1) * COLOURS_A_PALETTE));
  };
  const battle = (archive: Uint8Array[], name: string, character: number, palette: number) => {
    const what = `${name} file ${character}`;
    const ncgr = readNcgr(fileOf(archive, name, character), what);
    if (!ncgr.scanned) throw new RomError('BAD_FORMAT', `${what} is in tiles, not scanned rows`);
    const pixels = scannedWindow(decryptPlatinum(ncgr.data), BATTLE_STRIDE, 0, 0, SPRITE_SIZE.front, SPRITE_SIZE.front);
    const colours = readNclr(fileOf(archive, name, palette), `${name} file ${palette}`).slice(0, COLOURS_A_PALETTE);
    return encodeIndexedPng(SPRITE_SIZE.front, SPRITE_SIZE.front, pixels, colours);
  };

  return {
    gameCode: readGameCode(rom),
    count,
    forms: (species) => FORM_SPRITES[species]?.forms ?? 1,
    png(kind, species, form = 0, shiny = false) {
      if (!Number.isInteger(species) || species < 1 || species > count) throw new RangeError(`species ${species} is not 1 to ${count}`);
      const sprites = FORM_SPRITES[species];
      if (!Number.isInteger(form) || form < 0 || form >= (sprites?.forms ?? 1)) throw new RangeError(`species ${species} has no form ${form} with a sprite`);
      if (kind === 'icon') return icon(form === 0 ? FIRST_ICON + species : sprites!.icon(form) ?? FIRST_ICON + species);
      if (form > 0) return battle(other, OTHERPOKE, kind === 'front' ? sprites!.front(form) : sprites!.back(form), sprites!.palette(form, shiny));
      const first = species * FILES_PER_SPECIES;
      const male = first + (kind === 'front' ? FRONT_MALE : BACK_MALE);
      const character = graphics[male]!.length > 0 ? male : male - 1;   // a female-only species has only the female file
      return battle(graphics, POKEGRA, character, first + (shiny ? SHINY_PALETTE : NORMAL_PALETTE));
    },
  };
}

const MANIFEST = 'manifest.json';
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The manifest of the cache in `dir` when it is of this version and looks whole (each kind's first and last species
 * there), else null. A few small reads: the server's start pays only this when the cache is there.
 */
export function readyManifest(dir: string): SpriteManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as SpriteManifest;
    if (manifest.version !== SPRITES_VERSION || !Number.isInteger(manifest.species) || manifest.species < 1) return null;
    for (const kind of SPRITE_KINDS) for (const species of [1, manifest.species]) fs.statSync(path.join(dir, kind, `${species}.png`));
    return manifest;
  } catch {
    return null;
  }
}

/** The temp folders a stopped extract into `dir` left beside it (`<dir>.tmp-…`). */
async function staleTemps(dir: string): Promise<string[]> {
  const prefix = `${path.basename(dir)}.tmp-`;
  try {
    return (await fs.promises.readdir(path.dirname(dir))).filter((name) => name.startsWith(prefix)).map((name) => path.join(path.dirname(dir), name));
  } catch {
    return [];
  }
}

/**
 * Writes every species' sprites from `rom` into `dir` (its `front/`, `back/` and `icon/`, then `manifest.json`). They
 * are written into a fresh folder beside `dir` that replaces it only once complete, so a failed or stopped extract leaves
 * the old cache (or none) as it was; a temp folder an earlier stopped one left is removed first. Yields to the event
 * loop after each species, so a server answers meanwhile.
 */
export async function writeSprites(rom: Uint8Array, dir: string): Promise<SpriteManifest> {
  return writeSpritesFrom(spriteSource(rom), dir);
}

/** `writeSprites` from a decoded source: for each species, each of its forms, normal and (front and back) shiny. */
export async function writeSpritesFrom(source: SpriteSource, dir: string): Promise<SpriteManifest> {
  for (const stale of await staleTemps(dir)) await fs.promises.rm(stale, { recursive: true, force: true });
  const temp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  let forms = 0;
  try {
    for (const kind of SPRITE_KINDS) await fs.promises.mkdir(path.join(temp, kind), { recursive: true });
    for (let species = 1; species <= source.count; species++) {
      const count = source.forms(species);
      forms += count - 1;
      for (let form = 0; form < count; form++) {
        for (const kind of SPRITE_KINDS) {
          for (const shiny of kind === 'icon' ? [false] : [false, true]) {
            await fs.promises.writeFile(path.join(temp, kind, spriteFileName(species, form, shiny)), source.png(kind, species, form, shiny));
          }
        }
      }
      await yieldNow();
    }
    const manifest: SpriteManifest = {
      version: SPRITES_VERSION, gameCode: source.gameCode, species: source.count, forms, shiny: true,
      kinds: SPRITE_KINDS, sizes: SPRITE_SIZE, notExtracted: NOT_EXTRACTED,
    };
    await fs.promises.writeFile(path.join(temp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rename(temp, dir);
    return manifest;
  } catch (error) {
    await fs.promises.rm(temp, { recursive: true, force: true });
    throw error;
  }
}
