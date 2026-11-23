// The hosted sign-in: the page asks for the password only when the server has one and this browser holds no sign-in; a
// wrong password and a 429 each have a plain line; a 401 `SIGN_IN` later brings the page back once, and the re-send of
// the stored save never takes it for `NO_SAVE`; "Sign out" shows when signed in; local mode shows none of it.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../web/src/App';
import { ApiError, getBox, onSignInRequired, setHosted } from '../../../web/src/api';
import { setup, stubFetch } from './stubServer';
import { stubHosted } from './hostedServer';

beforeEach(() => localStorage.clear());
afterEach(() => {
  setHosted(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const saveFile = () => new File([new Uint8Array(64)], 'plat.dsv', { lastModified: Date.UTC(2026, 10, 1) });
const signOut = () => screen.queryByRole('button', { name: 'Sign out' });
const logouts = (stub: ReturnType<typeof stubHosted>) => stub.calls.filter((c) => c.method === 'POST' && c.url === '/api/logout');
async function signIn(user: ReturnType<typeof userEvent.setup>, password: string) {
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}
async function toWorkspace(stub: ReturnType<typeof stubHosted>) {
  render(<App />);
  await screen.findByRole('heading', { name: 'Load your save' });
  fireEvent.change(screen.getByTestId('load-save-input'), { target: { files: [saveFile()] } });
  await screen.findByRole('tab', { name: 'Run' });
  expect(stub.puts()).toHaveLength(1);
}

describe('the sign-in page', () => {
  // The page asks only for the password; the usage report tells visitors apart by a rough location, device and fights.
  it('shows for a server with a password and no sign-in: the password alone, the logging line under Sign in, the wordmark; a wrong password is one line, the right one goes on', async () => {
    const stub = stubHosted({ password: 'hunter2' });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.signin input')).toHaveLength(1);
    const note = screen.getByText('Visits are logged with a rough location, device and the fights you plan.');
    expect(screen.getByRole('button', { name: 'Sign in' }).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('.signin .wordmark-lg')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Load your save' })).not.toBeInTheDocument();
    expect(stub.calls.map((c) => c.url)).toEqual(['/api/config']);
    await signIn(user, 'nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
    await user.clear(screen.getByLabelText('Password'));
    await signIn(user, 'hunter2');
    expect(await screen.findByRole('heading', { name: 'Load your save' })).toBeInTheDocument();
    expect(stub.logins().at(-1)).toEqual({ password: 'hunter2' });             // no name sent
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  // Minutes above 90 seconds, rounded up.
  it.each([['42', 'Too many tries. Try again in 42 s.'], ['90', 'Try again in 90 s.'], ['91', 'Try again in 2 min.'], ['540', 'Too many tries. Try again in 9 min.']])(
    'a 429 with Retry-After %s says how long to wait', async (retryAfter, said) => {
      const stub = stubHosted({ password: 'hunter2' });
      stub.nextLogin({ status: 429, json: { error: 'Too many wrong passwords', code: 'RATE_LIMITED' } });
      const real = globalThis.fetch;
      // The stub's answers carry no headers: wrap fetch to add the `Retry-After` the server sends.
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await real(input, init);
        return res.status !== 429 ? res : new Response(await res.text(), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': retryAfter } });
      });
      render(<App />);
      await screen.findByLabelText('Password');
      await signIn(userEvent.setup(), 'hunter2');
      expect(await screen.findByRole('alert')).toHaveTextContent(said);
    },
  );

  it('a sign-in the browser did not keep says so, and no loop follows', async () => {
    const stub = stubHosted({ password: 'hunter2' });
    stub.nextLogin({ status: 204, json: null });
    render(<App />);
    await screen.findByLabelText('Password');
    await signIn(userEvent.setup(), 'hunter2');
    expect(await screen.findByRole('alert')).toHaveTextContent('did not keep it');
    expect(stub.calls.filter((c) => c.url === '/api/config')).toHaveLength(2);
  });

  it('a server without a password, and local mode, never show it, nor "Sign out"', async () => {
    const stub = stubHosted();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Load your save' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(signOut()).toBeNull();
    document.body.innerHTML = '';
    await toWorkspace(stub);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings' }));
    expect(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Change save' })).toBeInTheDocument();
    expect(signOut()).toBeNull();
    document.body.innerHTML = '';
    setHosted(null);
    stubFetch({ 'GET /api/setup': { json: setup({ data: { state: 'missing', message: null, trainers: null }, saveCandidates: [] }) } });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Check and extract' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(signOut()).toBeNull();
  });
});

describe('signed in', () => {
  it.each<[string, (stub: ReturnType<typeof stubHosted>) => Promise<void>]>([
    ['Settings', async (stub) => {
      await toWorkspace(stub);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Settings' }));
    }],
    ['"Load your save"', async () => {
      render(<App />);
      await screen.findByRole('heading', { name: 'Load your save' });
    }],
  ])('%s has Sign out, which posts the logout and brings the sign-in page back', async (_, open) => {
    const stub = stubHosted({ password: 'hunter2', signedIn: true });
    await open(stub);
    await userEvent.setup().click(signOut()!);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(logouts(stub)).toHaveLength(1);
    expect(stub.signedIn()).toBe(false);
  });

  it('a 401 SIGN_IN from a call later brings the sign-in page back once, with no re-send, and signing in again goes on', async () => {
    const stub = stubHosted({ password: 'hunter2', signedIn: true });
    const user = userEvent.setup();
    await toWorkspace(stub);
    stub.expire();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Change save' }));
    fireEvent.change(await screen.findByTestId('load-save-input'), { target: { files: [saveFile()] } });
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    const puts = stub.puts().length;
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.puts()).toHaveLength(puts);
    expect(stub.calls.filter((c) => c.url === '/api/config')).toHaveLength(1);
    await signIn(user, 'hunter2');
    await waitFor(() => expect(screen.queryByLabelText('Password')).not.toBeInTheDocument());
    expect(stub.signedIn()).toBe(true);
  });
});

it('a 401 SIGN_IN at the api is told to the page, and never taken for NO_SAVE: no re-send', async () => {
  stubHosted({ password: 'hunter2' });
  const resend = vi.fn(async () => {});
  setHosted({ session: () => 'tab', resend });
  const heard = vi.fn();
  const stop = onSignInRequired(heard);
  await expect(getBox()).rejects.toMatchObject({ status: 401, code: 'SIGN_IN' });
  await expect(getBox()).rejects.toBeInstanceOf(ApiError);
  expect(resend).not.toHaveBeenCalled();
  expect(heard).toHaveBeenCalledTimes(2);                    // one per refused call; the page's listener ignores a second one
  stop();
});
