// The header publishes its height as `--header-height`, so the sticky parts under it stick at the right offset, keeps
// the save's file name on the line with "Saved", and carries the wordmark; the favicon files; the quiet 2v2 tag.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header, type HeaderStatus } from '../../../web/src/components/Header';
import { LoadSave } from '../../../web/src/components/LoadSave';
import { locationName, TrainerSearch } from '../../../web/src/components/TrainerSearch';
import { Wordmark } from '../../../web/src/components/Wordmark';
import { box, stubFetch, trainerById, TWINS } from './stubServer';

const WEB = resolve(__dirname, '../../../web');
const read = () => document.documentElement.style.getPropertyValue('--header-height');
interface Observer { callback: ResizeObserverCallback; observed: Element[] }
const observers: Observer[] = [];
class StubResizeObserver {
  private readonly record: Observer;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, observed: [] };
    observers.push(this.record);
  }
  observe(el: Element) { this.record.observed.push(el); }
  disconnect() { this.record.observed = []; }
  unobserve() {}
}
let height = 57;
const stubHeight = () => Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  observers.length = 0;
  document.documentElement.style.removeProperty('--header-height');
  height = 57;
});

describe('the header', () => {
  it('writes its height into --header-height, follows a resize without observing again on a re-render, and takes it back when it goes', () => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    stubHeight();
    const { unmount, rerender } = render(<Header />);
    rerender(<Header />);
    expect(read()).toBe('57px');
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed[0]!.tagName).toBe('HEADER');
    height = 98;
    act(() => observers[0]!.callback([], observers[0] as unknown as ResizeObserver));
    expect(read()).toBe('98px');
    unmount();
    expect(read()).toBe('');
    expect(observers[0]!.observed).toEqual([]);
  });

  it('writes it once without ResizeObserver; bare, the title is the wordmark heading', () => {
    expect('ResizeObserver' in globalThis).toBe(false);
    height = 40;
    stubHeight();
    const { container } = render(<Header />);
    expect(read()).toBe('40px');
    expect(screen.getByRole('heading', { name: 'Plat Kaizo Planner' }).querySelector('.wordmark-md')).not.toBeNull();
    expect(container.querySelector('.app-header')).toHaveClass('is-bare');
  });

  it("has the save's file name on the line with Saved", () => {
    const b = box({ savePath: '/x/run.dsv' });
    const status: HeaderStatus = { box: b, savePath: b.savePath, levelCapOverride: null, live: 'live', updated: false, onSettings: () => undefined };
    const line = render(<Header status={status} />).container.querySelector('.header-save')!;
    expect(line.querySelector('.header-file')!.textContent).toBe('run.dsv');
    expect(line.querySelector('.header-saved')!.textContent).toMatch(/^Saved /);
  });
});

describe('the wordmark and the favicon', () => {
  it('the wordmark is the name with a decorative mark, in both sizes; the load screen puts it over one centred card', () => {
    const { container, rerender } = render(<Wordmark size="lg" />);
    expect(container.querySelector('.wordmark-lg')).toHaveTextContent('Plat Kaizo Planner');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Wordmark size="md" />);
    expect(container.querySelector('.wordmark-md')).not.toBeNull();
    const load = render(<LoadSave canConnect uploading={false} error={null} reason={null} onFile={vi.fn()} onConnect={vi.fn()} />).container;
    expect(load.querySelector('.load-screen > .load-brand .wordmark-lg')).not.toBeNull();
    expect(load.querySelectorAll('.load-card')).toHaveLength(1);
    expect(screen.getAllByText(/nothing is stored on the server/)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /save/i }).filter((b) => b.className.includes('button-primary'))).toHaveLength(1);
  });

  it('index.html links the SVG favicon and the 180 px touch icon, and both files exist', () => {
    const html = readFileSync(resolve(WEB, 'index.html'), 'utf8');
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    expect(readFileSync(resolve(WEB, 'public/favicon.svg'), 'utf8')).toContain('<svg');
    const png = resolve(WEB, 'public/apple-touch-icon.png');
    expect(existsSync(png) && statSync(png).size > 0).toBe(true);
    const bytes = readFileSync(png);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([180, 180]);
  });
});

it('a double in the search has the one 2v2 tag with its title and no "Double" pill; capital-letter locations show in title case', async () => {
  const user = userEvent.setup();
  stubFetch({ 'GET /api/trainers': { json: [{ ...trainerById(TWINS), location: 'SPEAR PILLAR', tags: ['Double'] }] } });
  const { container } = render(<TrainerSearch openId={null} onPick={vi.fn()} />);
  await user.type(screen.getByRole('searchbox', { name: 'Search all trainers' }), 'twins');
  await waitFor(() => expect(container.querySelector('.trainer-pick')).not.toBeNull());
  const pills = [...container.querySelectorAll('.pill')];
  expect(pills.map((p) => p.textContent?.replace(/\s*\(.*\)$/, ''))).toEqual(['2v2']);
  expect(pills[0]).toHaveAttribute('title', "Double battle: can't be planned yet");
  expect(container.querySelector('.trainer-location')).toHaveTextContent('Spear Pillar');
  expect(['SPEAR PILLAR', 'Route 204 North', 'Route 204', ''].map(locationName)).toEqual(['Spear Pillar', 'Route 204 North', 'Route 204', '']);
  vi.unstubAllGlobals();
});
