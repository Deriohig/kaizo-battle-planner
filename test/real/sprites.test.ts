// The Pokémon sprites from the hack's ROM (src/sprites/extract.ts): Bulbasaur's and Prinplup's front sprites
// are 80×80 with a sane share of drawn pixels and colours, the icons 32×32, a female-only species reads its female file,
// the alternate forms (Rotom's, Giratina Origin, the Deoxys forms the trainers use) are drawn and their own, the shiny
// colours are other colours on the same pixels, and the whole cache writes and reads back as ready. Needs the ROM
// (PK_ROM, git-ignored); writes only to a temp folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_EXTRACTED, readyManifest, spriteSource, type SpriteKind, writeSprites } from '../../src/sprites/extract.js';
import { readIndexedPng } from '../unit/sprites/pngRead.js';
import { needFiles, PK_ROM } from './env.js';

const suite = needFiles('the sprites from the ROM', { PK_ROM });
const BULBASAUR = 1;
const NIDORAN_F = 29;
const PRINPLUP = 394;
const ROTOM = 479;
const GIRATINA = 487;
const DEOXYS = 386;

describe.skipIf(suite.skip)(suite.title, () => {
  const source = (() => {
    let made: ReturnType<typeof spriteSource> | null = null;
    return () => (made ??= spriteSource(new Uint8Array(fs.readFileSync(PK_ROM))));
  })();

  /** The sprite's image, with the share of its pixels that are drawn (not index 0) and how many colours it uses. */
  const look = (kind: SpriteKind, species: number, form = 0, shiny = false) => {
    const image = readIndexedPng(source().png(kind, species, form, shiny));
    const drawn = image.pixels.filter((p) => p !== 0).length / image.pixels.length;
    return { ...image, drawn, colours: new Set(image.pixels).size };
  };
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

  it('has the 493 species of Platinum', () => {
    expect(source().count).toBe(493);
    expect(source().gameCode).toBe('JAK7');
  });

  it("Bulbasaur's and Prinplup's front sprites decode to 80×80, transparent around a drawn Pokémon of several colours", () => {
    for (const species of [BULBASAUR, PRINPLUP]) {
      const front = look('front', species);
      expect([front.width, front.height, front.colourType, front.trns], `species ${species}`).toEqual([80, 80, 3, [0]]);
      expect(front.palette).toHaveLength(16);
      expect(front.drawn, `species ${species}`).toBeGreaterThan(0.08);
      expect(front.drawn, `species ${species}`).toBeLessThan(0.7);
      expect(front.colours, `species ${species}`).toBeGreaterThanOrEqual(6);
      // The corners are background.
      for (const at of [0, 79, 80 * 79, 80 * 80 - 1]) expect(front.pixels[at], `species ${species} pixel ${at}`).toBe(0);
    }
  });

  it('back sprites are 80×80 and icons 32×32, each drawn; a female-only species (Nidoran♀) reads its female files', () => {
    for (const species of [BULBASAUR, NIDORAN_F, PRINPLUP]) {
      const back = look('back', species);
      expect([back.width, back.height]).toEqual([80, 80]);
      expect(back.drawn, `species ${species} back`).toBeGreaterThan(0.05);
      const icon = look('icon', species);
      expect([icon.width, icon.height]).toEqual([32, 32]);
      expect(icon.drawn, `species ${species} icon`).toBeGreaterThan(0.1);
      expect(icon.drawn, `species ${species} icon`).toBeLessThan(0.8);
    }
    expect(look('front', NIDORAN_F).drawn).toBeGreaterThan(0.05);
  });

  it("Rotom's five appliance forms, Giratina Origin and the Deoxys forms are drawn, each its own picture, with icons of their own", () => {
    expect(source().forms(ROTOM)).toBe(6);
    expect(source().forms(GIRATINA)).toBe(2);
    const forms: [number, number][] = [[ROTOM, 1], [ROTOM, 2], [ROTOM, 3], [ROTOM, 4], [ROTOM, 5], [GIRATINA, 1], [DEOXYS, 1], [DEOXYS, 2], [DEOXYS, 3]];
    const seen: Uint8Array[] = [look('front', ROTOM).pixels, look('front', GIRATINA).pixels, look('front', DEOXYS).pixels];
    for (const [species, form] of forms) {
      for (const kind of ['front', 'back'] as const) {
        const image = look(kind, species, form);
        expect([image.width, image.height], `${species}-${form} ${kind}`).toEqual([80, 80]);
        expect(image.drawn, `${species}-${form} ${kind}`).toBeGreaterThan(0.05);
        expect(image.colours, `${species}-${form} ${kind}`).toBeGreaterThanOrEqual(5);
      }
      const front = look('front', species, form).pixels;
      expect(seen.some((other) => same(other, front)), `${species}-${form} front is another form's`).toBe(false);
      seen.push(front);
      expect(same(source().png('icon', species, form), source().png('icon', species)), `${species}-${form} icon`).toBe(false);
    }
    // Castform's weather forms have no icons of their own.
    expect(same(source().png('icon', 351, 1), source().png('icon', 351))).toBe(true);
    expect(() => source().png('front', ROTOM, 6)).toThrow(RangeError);
    expect(() => source().png('front', PRINPLUP, 1)).toThrow(RangeError);
  });

  it('a shiny sprite is the same picture in other colours; a shiny icon is the normal icon', () => {
    for (const [species, form] of [[PRINPLUP, 0], [ROTOM, 2], [GIRATINA, 1]] as const) {
      const normal = look('front', species, form);
      const shiny = look('front', species, form, true);
      expect(same(shiny.pixels, normal.pixels), `${species}-${form}`).toBe(true);
      expect(shiny.palette, `${species}-${form}`).not.toEqual(normal.palette);
    }
    expect(same(source().png('icon', PRINPLUP, 0, true), source().png('icon', PRINPLUP))).toBe(true);
  });

  it('writes the whole cache (every species and form, front and back also shiny, then the manifest), which then reads as ready', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sprites-real-')), 'sprites');
    try {
      expect(readyManifest(dir)).toBeNull();
      const manifest = await writeSprites(new Uint8Array(fs.readFileSync(PK_ROM)), dir);
      // Forms: Deoxys 3, Unown 27, Castform 3, Burmy 2, Wormadam 2, Cherrim, Shellos, Gastrodon, Arceus 17, Shaymin, Rotom 5, Giratina.
      expect(manifest).toMatchObject({ species: 493, forms: 64, shiny: true, kinds: ['front', 'back', 'icon'], notExtracted: NOT_EXTRACTED });
      expect(readyManifest(dir)).toEqual(manifest);
      for (const kind of ['front', 'back']) expect(fs.readdirSync(path.join(dir, kind))).toHaveLength((493 + 64) * 2);
      expect(fs.readdirSync(path.join(dir, 'icon'))).toHaveLength(493 + 64);
      expect(fs.readdirSync(path.dirname(dir))).toEqual(['sprites']);   // the temp folder was renamed, none left beside it
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});
