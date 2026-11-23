// The one place a sprite URL is built. The server route serves the PNGs extracted from the ROM:
// `/api/sprites/{front|back|icon}/{speciesId}[-{formId}][-shiny].png`. A form id of 0 (or none) is the species' own sprite;
// icons have no shiny colours (the server serves the normal one).

export type SpriteKind = 'front' | 'back' | 'icon';

/** A form and shininess for the sprite: both optional; a form of 0 is the species' own. */
export interface SpriteLook { form?: number | undefined; shiny?: boolean | undefined }

export function spriteUrl(kind: SpriteKind, species: string | number, look: SpriteLook = {}): string {
  const form = look.form !== undefined && look.form !== 0 ? `-${look.form}` : '';
  const shiny = look.shiny === true ? '-shiny' : '';
  return `/api/sprites/${kind}/${encodeURIComponent(String(species))}${form}${shiny}.png`;
}

/**
 * The URLs to try, best first: the form's (and shiny) sprite, then the species' own (a form the species does not have is a
 * 404). One entry when there is no form and it is not shiny.
 */
export function spriteUrls(kind: SpriteKind, species: string | number, look: SpriteLook = {}): string[] {
  const best = spriteUrl(kind, species, look);
  const plain = spriteUrl(kind, species);
  return best === plain ? [plain] : [best, plain];
}
