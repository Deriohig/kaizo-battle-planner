// Preloaded into the CLI under test (`tsx --import <this file>`), so `npm run extract` never reaches the network.
// Each docs tab, found by its gid, answers with `fakeTabCsv`; with FAKE_DOCS set to 'html', with a sign-in page; and with
// FAKE_DOCS set to 'bad-format', the Personal tab answers with one that passes its wrong-tab check but not its parser.

import { DOC_TAB_GIDS, DOC_TABS } from '../../src/docs/fetchDocs.js';
import { fakeTabCsv, PERSONAL_WITHOUT_STATS } from './fakeDocsTabs.js';

const tabByGid = new Map(DOC_TABS.map((tab) => [DOC_TAB_GIDS[tab], tab]));

globalThis.fetch = async (input) => {
  const tab = tabByGid.get(new URL(String(input)).searchParams.get('gid') ?? '');
  if (tab === undefined) throw new Error(`fakeDocsFetch: no tab has the URL ${String(input)}`);
  if (process.env.FAKE_DOCS === 'html') return new Response('<!DOCTYPE html><html>');
  if (process.env.FAKE_DOCS === 'bad-format' && tab === 'Personal') return new Response(PERSONAL_WITHOUT_STATS);
  return new Response(fakeTabCsv(tab));
};
