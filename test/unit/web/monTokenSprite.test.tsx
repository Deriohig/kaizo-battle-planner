// MonToken's sprite: the real image over the type disc, falling back to the initials; and the move tile's parts.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BoxMonJson } from '../../../src/server/apiTypes';
import { MoveTile } from '../../../web/src/components/MoveTile';
import { MonCard, MonToken, spriteLook, spriteSpecies } from '../../../web/src/components/plan/MonToken';
import { spriteUrl } from '../../../web/src/sprites';
import { mon } from './stubServer';

const tok = (p: Partial<Parameters<typeof MonToken>[0]> = {}) => <MonToken name="Prinplup" level={20} types={['Water']} {...p} />;
const img = (c: HTMLElement) => c.querySelector('img');
const initials = (c: HTMLElement) => c.querySelector('.disc')!.textContent;

describe('MonToken sprite', () => {
  it.each<[string, Partial<Parameters<typeof MonToken>[0]>, string]>([
    ['the icon at size m', { species: 393, size: 'm' }, '/api/sprites/icon/393.png'],
    ['the front at size l', { species: 393, size: 'l' }, '/api/sprites/front/393.png'],
    ['the back on request', { species: 393, size: 'l', sprite: 'back' }, '/api/sprites/back/393.png'],
    ['the form and shiny', { species: 479, form: 2, shiny: true, size: 'l' }, '/api/sprites/front/479-2-shiny.png'],
  ])('shows %s, kept out of the accessible name, without the initials', (_, props, src) => {
    const { container } = render(tok(props));
    expect(img(container)).toHaveAttribute('src', src);
    expect(img(container)).toHaveAttribute('alt', '');
    expect(img(container)).toHaveAttribute('draggable', 'false');
    expect(screen.queryByRole('img')).toBeNull();
    expect(initials(container)).not.toContain('Pr');
    expect(container.textContent).toMatch(/Prinplup.*Lv 20/);
  });

  it('shows the initials with no species or species 0', () => {
    for (const species of [undefined, 0]) {
      const { container, unmount } = render(tok({ species }));
      expect(img(container)).toBeNull();
      expect(initials(container)).toContain('Pr');
      unmount();
    }
  });

  it('falls back from the form sprite to the species sprite, then to the initials, and retries for a new species', () => {
    const { container, rerender } = render(tok({ species: 479, form: 2, shiny: true, size: 'l' }));
    fireEvent.error(img(container)!);
    expect(img(container)).toHaveAttribute('src', '/api/sprites/front/479.png');
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(initials(container)).toContain('Pr');
    rerender(tok({ species: 394 }));
    expect(img(container)).toHaveAttribute('src', '/api/sprites/icon/394.png');
  });

  it('spriteUrl encodes a string key and builds the form and shiny parts; a form of 0 is the species\' own', () => {
    expect(spriteUrl('icon', 'Mr. Mime')).toBe('/api/sprites/icon/Mr.%20Mime.png');
    expect(spriteUrl('front', 479, { form: 2 })).toBe('/api/sprites/front/479-2.png');
    expect(spriteUrl('back', 394, { shiny: true })).toBe('/api/sprites/back/394-shiny.png');
    expect(spriteUrl('icon', 487, { form: 0 })).toBe('/api/sprites/icon/487.png');
  });

  it('a card shows its Pokémon\'s icon from speciesId, form and shiny, and the initials when the id is 0 or missing', () => {
    const rotom = { ...mon('box:1:4', { species: 'Rotom' }), speciesId: 479, formId: 2, shiny: true } as BoxMonJson;
    const zero = { ...mon('box:1:5', { species: 'Bidoof' }), speciesId: 0 } as BoxMonJson;
    expect([spriteSpecies(rotom), spriteSpecies(zero), spriteSpecies(mon('box:1:6'))]).toEqual([479, undefined, undefined]);
    expect([spriteLook(rotom), spriteLook(mon('box:1:5'))]).toEqual([{ form: 2, shiny: true }, {}]);
    const { container } = render(<>
      <MonCard mon={rotom} active={null} fainted={[]}>{null}</MonCard>
      <MonCard mon={zero} active={null} fainted={[]}>{null}</MonCard>
    </>);
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['/api/sprites/icon/479-2-shiny.png']);
  });
});

describe('MoveTile', () => {
  it('with button it is one button: name, meta, damage and KO in order, aria-pressed from selected', () => {
    render(<MoveTile name="Aerial Ace" meta="19/20 PP" damage="22–27 HP (44–54%)" ko="2HKO 39.84%" koTitle="1 hit 0/1" selected button={{ 'data-choice': 'm0' }} />);
    const tile = screen.getByRole('button');
    expect(tile).toHaveAttribute('type', 'button');
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(tile).toHaveAttribute('data-choice', 'm0');
    expect(tile).toHaveClass('tile', 'is-selected');
    expect([...tile.querySelectorAll('.tile-name, .tile-meta, .tile-damage, .tile-ko')].map((e) => [e.className, e.textContent])).toEqual([
      ['tile-name', 'Aerial Ace'], ['tile-meta', '19/20 PP'], ['tile-damage', '22–27 HP (44–54%)'], ['tile-ko', '2HKO 39.84%'],
    ]);
    expect(tile.querySelector('.tile-ko')).toHaveAttribute('title', '1 hit 0/1');
  });

  it('not selected: aria-pressed false and no is-selected; the button props pass through', () => {
    render(<MoveTile name="Tackle" button={{ disabled: true, 'aria-disabled': true }} />);
    const tile = screen.getByRole('button');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(tile).not.toHaveClass('is-selected');
    expect(tile).toBeDisabled();
    expect(tile.querySelector('.tile-meta, .tile-damage, .tile-ko, .tile-extra')).toBeNull();
  });

  it('without button it is a div with no button role, its extra in .tile-extra', () => {
    const { container } = render(<MoveTile name="Tackle" meta="35/35 PP" extra={<span>Priority +1</span>} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.firstElementChild!.tagName).toBe('DIV');
    expect(container.firstElementChild).toHaveClass('tile');
    expect(container.querySelector('.tile-extra')).toHaveTextContent('Priority +1');
  });

  it('type, sub and band show in order: chip before the name, sub then band before the damage line', () => {
    const { container } = render(<MoveTile name="Aqua Jet" type="Water" sub="Physical · 40 power" band={<div className="band" />} damage="10%" ko="2HKO" />);
    expect(container.querySelector('.type-chip')).toHaveAttribute('data-type', 'Water');
    expect(container.querySelector('.tile-head')!.textContent).toBe('Water Aqua Jet');
    expect([...container.querySelectorAll('.tile-sub, .band, .tile-damage, .tile-ko')].map((e) => e.className)).toEqual(['tile-sub', 'band', 'tile-damage', 'tile-ko']);
    expect(container.querySelector('.tile-sub')).toHaveTextContent('Physical · 40 power');
  });

  it('with none of the new props, or a null type and an empty sub, it draws only the plain parts', () => {
    const { container, rerender } = render(<MoveTile name="Tackle" meta="35/35 PP" damage="1" ko="K" />);
    expect(container.firstElementChild!.innerHTML).toBe(
      '<span class="tile-head"><span class="tile-name">Tackle</span> <span class="tile-meta">35/35 PP</span></span> <span class="tile-damage">1</span> <span class="tile-ko">K</span>',
    );
    rerender(<MoveTile name="A" type={null} sub="" />);
    expect(container.querySelector('.type-chip, .tile-sub, .band')).toBeNull();
  });

  it('the KO tone is a class on the KO part: ok, danger, or none', () => {
    const { container, rerender } = render(<MoveTile name="A" ko="OHKO 100%" koTone="ok" />);
    expect(container.querySelector('.tile-ko')).toHaveClass('is-ok');
    rerender(<MoveTile name="A" ko="OHKO 40%" koTone="danger" />);
    expect(container.querySelector('.tile-ko')).toHaveClass('is-danger');
    rerender(<MoveTile name="A" ko="2HKO 40%" koTone={null} />);
    expect(container.querySelector('.tile-ko')!.className).toBe('tile-ko');
  });
});
