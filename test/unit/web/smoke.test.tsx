// The page shell: App's first screen, the server out of reach, the skip link, the error boundary, the one dark theme
// whatever the system prefers, and a page head that lays a phone out 1100 px wide (the desktop layout, smaller).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../web/src/App';
import { ErrorBoundary } from '../../../web/src/components/ErrorBoundary';
import { box, SAVE_12_JUNE, settings, setup, stubFetch, trainers } from './stubServer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the app heading, then the setup', async () => {
    stubFetch({ 'GET /api/setup': { json: setup({ data: { state: 'missing', message: null, trainers: null }, saveCandidates: [] }) } });
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Plat Kaizo Planner' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Check and extract' })).toBeInTheDocument();
  });

  it.each<[string, () => Promise<Response>, string]>([
    ['a failed fetch', () => Promise.reject(new TypeError('Failed to fetch')), 'Cannot reach the planner server'],
    ["the dev proxy's empty 502", async () => new Response('', { status: 502, statusText: 'Bad Gateway' }), 'Cannot reach the planner server (HTTP 502 Bad Gateway)'],
  ])('says the server cannot be reached for %s, with Try again', async (_, answer, said) => {
    vi.stubGlobal('fetch', vi.fn(answer));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(said);
    expect(screen.getByRole('heading', { name: 'Plat Kaizo Planner' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('the first link of the page skips to the fight, on the Run tab', async () => {
    stubFetch({
      'GET /api/setup': { json: setup({ savePath: SAVE_12_JUNE }) }, 'GET /api/settings': { json: settings({ savePath: SAVE_12_JUNE }) },
      'GET /api/box': { json: box() }, 'GET /api/trainers': { json: trainers() },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Box' }));
    const link = screen.getAllByRole('link')[0]!;
    expect(link).toHaveTextContent('Skip to the fight');
    await user.click(link);
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toHaveAttribute('id', 'fight');
  });
});

it('ErrorBoundary shows a throwing child\'s message with Try again, keeps the rest of the page, and renders again on Try again or a new resetKey', async () => {
  let failing = true;
  function Fragile() {
    if (failing) throw new Error('bad odds');
    return <p>All good</p>;
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);   // React reports the caught error
  const user = userEvent.setup();
  const { unmount } = render(<main><h1>The page</h1><ErrorBoundary><Fragile /></ErrorBoundary><p>The rest</p></main>);
  expect(screen.getByRole('alert')).toHaveTextContent('This part of the page hit an error: bad odds');
  expect(screen.getByRole('heading', { name: 'The page' })).toBeInTheDocument();
  expect(screen.getByText('The rest')).toBeInTheDocument();
  failing = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('All good')).toBeInTheDocument();
  unmount();
  failing = true;
  const { rerender } = render(<ErrorBoundary resetKey={1}><Fragile /></ErrorBoundary>);
  failing = false;
  rerender(<ErrorBoundary resetKey={1}><Fragile /></ErrorBoundary>);
  expect(screen.getByRole('alert')).toBeInTheDocument();          // the same key: still the error
  rerender(<ErrorBoundary resetKey={2}><Fragile /></ErrorBoundary>);
  expect(screen.getByText('All good')).toBeInTheDocument();
});

it("the page has one dark theme, navy and violet, and its head lays a phone out 1100 px wide, dark only", () => {
  const css = (file: string) => readFileSync(join(process.cwd(), 'web/src', file), 'utf8');
  for (const file of ['styles.css', 'styles/run.css', 'styles/plan.css', 'styles/matchups.css', 'styles/tree.css']) expect(css(file), file).not.toMatch(/prefers-color-scheme/);
  for (const rule of [/color-scheme:\s*dark;/, /--bg:\s*#090b18;/, /--accent:\s*#c3bbff;/]) expect(css('styles.css')).toMatch(rule);
  const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8');
  const meta = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1];
  expect([meta('viewport'), meta('color-scheme')]).toEqual(['width=1100', 'dark']);
});
