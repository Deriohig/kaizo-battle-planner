import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import {
  DEFAULT_HORIZON_TURNS, DEFAULT_PLAN_SETTINGS, type PlanContext, type PlanSettings, START_STATUSES, toSolveRequest,
} from '../../../src/integration/planRequest.js';
import { GARDENIA_ID, serverData, TRISTAN_ID, TWINS_ID } from '../server/fixtures.js';

const catalog = buildCatalog(serverData());
const ctx: PlanContext = {
  catalog, eligible: new Set(['party:1', 'party:2', 'box:1:1']), settings: DEFAULT_PLAN_SETTINGS, horizonTurns: DEFAULT_HORIZON_TURNS,
};
const RANKING = ['critBudget', 'critDeathProbability', 'worstMinHp', 'totalHp', 'pp', 'chanceDependencies', 'turns'];
const SIX = ['party:1', 'party:2', 'party:3', 'party:4', 'party:5', 'party:6'];
const POOL = ['party:1', 'party:2', 'box:1:1'];
const withSave: PlanContext = { ...ctx, saveLevels: new Map([['party:1', 15], ['party:2', 14], ['box:1:1', 14]]) };

/** A valid request against Youngster Tristan with a fixed team of party:1; `fields` replace any part of it. */
const body = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  fights: [{ trainerId: TRISTAN_ID }], team: { kind: 'fixed', party: ['party:1'] }, preStatus: 'given', budget: 'route', attemptAnyLegalBadge: false, ...fields,
});
const search = (fields: Record<string, unknown> = {}) => body({ team: { kind: 'search', pool: POOL, maxSize: 6, ...fields } });
const fixedLevels = (levels: unknown) => body({ team: { kind: 'fixed', party: ['party:1', 'party:2'] }, levels });
const searchLevels = (levels: unknown) => body({ team: { kind: 'search', pool: ['party:1', 'box:1:1'], maxSize: 2 }, levels });

function errorOf(request: unknown, context: PlanContext = ctx): string {
  const result = toSolveRequest(request, context);
  if (result.ok) throw new Error(`Expected an error, got ${JSON.stringify(result.request)}`);
  return result.error;
}
function requestOf(request: unknown, context: PlanContext = ctx) {
  const result = toSolveRequest(request, context);
  if (!result.ok) throw new Error(`Expected a request, got ${result.error}`);
  return result.request;
}

it('has a 50-turn horizon and five accepted pre-statuses', () => {
  expect([DEFAULT_HORIZON_TURNS, START_STATUSES]).toEqual([50, ['sleep:1', 'burn', 'poison', 'toxic', 'paralysis']]);
});

describe('toSolveRequest maps a valid request', () => {
  it('fixed, with pre-sleep and a gym budget', () => {
    expect(requestOf({
      fights: [{ trainerId: TRISTAN_ID }], team: { kind: 'fixed', party: ['party:2', 'party:1'] },
      startStatus: { 'party:2': 'sleep:1', 'party:1': 'burn' }, preStatus: 'given', budget: 'gym', attemptAnyLegalBadge: true,
    })).toEqual({
      fights: [{ trainerId: TRISTAN_ID, variant: 0, healBefore: false }], team: { kind: 'fixed', party: ['party:2', 'party:1'] },
      startStatus: { 'party:2': { kind: 'sleep', turns: 1 }, 'party:1': { kind: 'burn' } },
      preStatus: 'given', budgetMs: 300_000, horizonTurns: 50, attemptAnyLegalBadge: true, ranking: RANKING,
    });
  });

  it('search, with a variant and a budget in milliseconds', () => {
    expect(requestOf({
      fights: [{ trainerId: GARDENIA_ID, variant: 1 }], team: { kind: 'search', pool: ['box:1:1', 'party:1', 'party:2'], maxSize: 2 },
      startStatus: { 'box:1:1': 'toxic', 'party:2': 'paralysis', 'party:1': 'poison' }, preStatus: 'propose', budget: { ms: 45_000 }, attemptAnyLegalBadge: false,
    })).toEqual({
      fights: [{ trainerId: GARDENIA_ID, variant: 1, healBefore: false }], team: { kind: 'search', pool: ['box:1:1', 'party:1', 'party:2'], maxSize: 2 },
      startStatus: { 'box:1:1': { kind: 'toxic' }, 'party:2': { kind: 'paralysis' }, 'party:1': { kind: 'poison' } },
      preStatus: 'propose', budgetMs: 45_000, horizonTurns: 50, attemptAnyLegalBadge: false, ranking: RANKING,
    });
  });

  it('taking the budget, a copy of the ranking and the horizon from the context, and leaving out an absent startStatus', () => {
    const settings: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, budgetsMs: { ...DEFAULT_PLAN_SETTINGS.budgetsMs, route: 12_345 }, ranking: ['turns', 'pp'] };
    const request = requestOf(body(), { ...ctx, settings, horizonTurns: 7 });
    expect(request).toStrictEqual({
      fights: [{ trainerId: TRISTAN_ID, variant: 0, healBefore: false }], team: { kind: 'fixed', party: ['party:1'] },
      preStatus: 'given', budgetMs: 12_345, horizonTurns: 7, attemptAnyLegalBadge: false, ranking: ['turns', 'pp'],
    });
    expect(request.ranking).not.toBe(settings.ranking);
  });

  it('a gauntlet, keeping healBefore per fight', () => {
    const fights = [{ trainerId: TRISTAN_ID }, { trainerId: GARDENIA_ID, healBefore: false }, { trainerId: TRISTAN_ID, healBefore: true }];
    expect(requestOf(body({ fights, budget: 'gauntlet' }))).toMatchObject({
      budgetMs: 900_000, fights: fights.map((f) => ({ variant: 0, healBefore: false, ...f })),
    });
  });

  it.each<[string, Record<string, unknown>, PlanContext?]>([
    ['20 fights', { fights: Array.from({ length: 20 }, () => ({ trainerId: TRISTAN_ID })) }],
    ['a party of 6', { team: { kind: 'fixed', party: SIX } }, { ...ctx, eligible: new Set(SIX) }],
    ['budget { ms: 1000 }', { budget: { ms: 1_000 } }],
    ['budget { ms: 86400000 }', { budget: { ms: 86_400_000 } }],
  ])('at the limit: %s', (_, fields, context = ctx) => {
    expect(toSolveRequest(body(fields), context).ok).toBe(true);
  });

  it("the 'deep' budget from the settings", () => {
    expect(requestOf(body({ budget: 'deep' })).budgetMs).toBe(3_600_000);
  });

  it('a search pool of every eligible mon of the box (31 or more)', () => {
    const everyone = [...SIX, ...Array.from({ length: 18 * 30 }, (_, i) => `box:${Math.floor(i / 30) + 1}:${(i % 30) + 1}`)];
    const wide = { ...ctx, eligible: new Set(everyone) };
    for (const pool of [everyone.slice(0, 31), everyone]) {
      expect(requestOf(body({ team: { kind: 'search', pool, maxSize: 6 } }), wide).team).toEqual({ kind: 'search', pool, maxSize: 6 });
    }
  });
});

describe('toSolveRequest refuses', () => {
  const NOT_OBJECT = 'The plan request must be a JSON object';
  const FIGHTS = 'fights must be a list of 1 to 20 fights';
  const TWO_COPIES = 'fights[0].variant must be a whole number from 0 to 1: Leader Gardenia has 2 copies';
  const TEAM = 'team must be an object with kind fixed or search';
  const PARTY = 'team.party must be a list of 1 to 6 MonRefs';
  const POOL_LIST = 'team.pool must be a list of 1 or more MonRefs';
  const MAX_SIZE = 'team.maxSize must be a whole number from 1 to 6';
  const STATUS = (s: string) => `startStatus for party:1 must be sleep:1, burn, poison, toxic or paralysis, not ${s}`;
  const BUDGET = 'budget must be route, gym, deep or gauntlet, or { ms } with a whole number of milliseconds from 1000 to 86400000';
  const OUTSIDE = 'startStatus names box:1:1, which is not in the team';

  const cases: [string, unknown, string][] = [
    ...[null, undefined, 'plan', 42, [body()]].map((r): [string, unknown, string] => [`body ${JSON.stringify(r)}`, r, NOT_OBJECT]),
    ['no fights', body({ fights: [] }), FIGHTS],
    ['21 fights', body({ fights: Array.from({ length: 21 }, () => ({ trainerId: TRISTAN_ID })) }), FIGHTS],
    ['absent fights', body({ fights: undefined }), FIGHTS],
    ['a fight that is not an object', body({ fights: [{ trainerId: TRISTAN_ID }, 'tristan'] }), 'fights[1] must be an object'],
    ['an unknown trainer', body({ fights: [{ trainerId: 'roark-split/nobody/1' }] }), 'fights[0].trainerId "roark-split/nobody/1" is not a trainer in the catalog'],
    ['no trainer ID', body({ fights: [{}] }), 'fights[0].trainerId must be a trainer ID (a string)'],
    ['a double', body({ fights: [{ trainerId: TRISTAN_ID }, { trainerId: TWINS_ID }] }), 'Twins Ally and Ann is a double battle: the solver is not available yet'],
    ...[2, -1, 0.5, '1', null].map((variant): [string, unknown, string] => [`variant ${JSON.stringify(variant)} of 2 copies`, body({ fights: [{ trainerId: GARDENIA_ID, variant }] }), TWO_COPIES]),
    ['variant 1 of one copy', body({ fights: [{ trainerId: TRISTAN_ID, variant: 1 }] }), 'fights[0].variant must be 0: Youngster Tristan has one copy'],
    ['healBefore "yes"', body({ fights: [{ trainerId: TRISTAN_ID }, { trainerId: TRISTAN_ID, healBefore: 'yes' }] }), 'fights[1].healBefore must be true or false'],
    ...[undefined, 'fixed', { kind: 'random', party: ['party:1'] }].map((team): [string, unknown, string] => [`team ${JSON.stringify(team)}`, body({ team }), TEAM]),
    ...[[], ['party:1', 2], undefined].map((party): [string, unknown, string] => [`party ${JSON.stringify(party)}`, body({ team: { kind: 'fixed', party } }), PARTY]),
    ['a duplicate party ref', body({ team: { kind: 'fixed', party: ['party:1', 'party:2', 'party:1'] } }), 'team.party lists party:1 twice'],
    ['an ineligible party ref', body({ team: { kind: 'fixed', party: ['party:1', 'box:2:1'] } }), 'box:2:1 is not eligible'],
    ['an ineligible pool ref', body({ team: { kind: 'search', pool: ['box:15:1'], maxSize: 1 } }), 'box:15:1 is not eligible'],
    ...[[], ['party:1', 2], undefined].map((pool): [string, unknown, string] => [`pool ${JSON.stringify(pool)}`, search({ pool }), POOL_LIST]),
    ['a duplicate pool ref', search({ pool: ['box:1:1', 'box:1:1'] }), 'team.pool lists box:1:1 twice'],
    ...[0, 7, 2.5, '3', undefined].map((maxSize): [string, unknown, string] => [`maxSize ${JSON.stringify(maxSize)}`, search({ pool: ['party:1'], maxSize }), MAX_SIZE]),
    ...['freeze', 'sleep:3', null].map((s): [string, unknown, string] => [`startStatus ${JSON.stringify(s)}`, body({ startStatus: { 'party:1': s } }), STATUS(JSON.stringify(s))]),
    ['a status outside the fixed team', body({ startStatus: { 'box:1:1': 'burn' } }), OUTSIDE],
    ['a status outside the pool', body({ team: { kind: 'search', pool: ['party:1', 'party:2'], maxSize: 1 }, startStatus: { 'box:1:1': 'burn' } }), OUTSIDE],
    ...[null, 'burn', ['burn']].map((s): [string, unknown, string] => [`startStatus ${JSON.stringify(s)}`, body({ startStatus: s }), 'startStatus must be an object from MonRef to status']),
    ['preStatus "maybe"', body({ preStatus: 'maybe' }), 'preStatus must be given or propose'],
    ['no attemptAnyLegalBadge', body({ attemptAnyLegalBadge: undefined }), 'attemptAnyLegalBadge must be true or false'],
    ...[{ ms: 500 }, { ms: 86_400_001 }, { ms: 1_500.5 }, { ms: '5000' }, {}, 'weekly', 'toString', undefined, 30_000]
      .map((budget): [string, unknown, string] => [`budget ${JSON.stringify(budget)}`, body({ budget }), BUDGET]),
    ...['fast', 'First', '', null, true, 1, ['first']].map((refine): [string, unknown, string] => [`refine ${JSON.stringify(refine)}`, body({ refine }), 'refine must be first or best']),
  ];
  it.each(cases)('%s', (_, request, error) => {
    expect(errorOf(request)).toBe(error);
  });

  it('a player partner, whom byId finds but catalog.trainers leaves out', () => {
    const data = serverData();
    data.docs.trainers[0]!.tags = { ...data.docs.trainers[0]!.tags, playerPartner: true };
    const withPartner = { ...ctx, catalog: buildCatalog(data) };
    expect(withPartner.catalog.byId(TRISTAN_ID)).toBeDefined();
    expect(errorOf(body(), withPartner)).toBe(`fights[0].trainerId "${TRISTAN_ID}" is not a trainer in the catalog`);
  });

  it('a party of 7', () => {
    const many = [...SIX, 'box:1:1'];
    expect(errorOf(body({ team: { kind: 'fixed', party: many } }), { ...ctx, eligible: new Set(many) })).toBe('team.party must be a list of 1 to 6 MonRefs');
  });
});

describe('toSolveRequest: mustBring and preferred in a search', () => {
  it('passes both lists through as copies in the order given, and leaves an empty or absent list out', () => {
    const mustBring = ['party:1'];
    const preferred = ['box:1:1'];
    const team = requestOf(search({ mustBring, preferred })).team as { mustBring: unknown; preferred: unknown };
    expect(team).toStrictEqual({ kind: 'search', pool: POOL, maxSize: 6, mustBring: ['party:1'], preferred: ['box:1:1'] });
    expect([team.mustBring === mustBring, team.preferred === preferred]).toEqual([false, false]);
    const today = { kind: 'search', pool: POOL, maxSize: 6 };
    expect(requestOf(search({ mustBring: ['box:1:1', 'party:1'] })).team).toStrictEqual({ ...today, mustBring: ['box:1:1', 'party:1'] });
    expect(requestOf(search({ preferred: ['party:2', 'party:1'] })).team).toStrictEqual({ ...today, preferred: ['party:2', 'party:1'] });
    for (const lists of [{}, { mustBring: [] }, { mustBring: [], preferred: [] }]) expect(requestOf(search(lists)).team).toStrictEqual(today);
    expect(requestOf(search({ mustBring: ['party:2'], preferred: [] })).team).toStrictEqual({ ...today, mustBring: ['party:2'] });
    // More Must bring than maxSize is accepted: the solver answers it with an unproven noEligibleTeam.
    expect(requestOf(search({ maxSize: 2, mustBring: POOL })).team).toStrictEqual({ ...today, maxSize: 2, mustBring: POOL });
  });

  it.each(['mustBring', 'preferred'])("refuses a bad %s list under its own name: not MonRefs, a ref twice, a ref outside the pool", (field) => {
    for (const list of ['party:1', ['party:1', 2], null, { 0: 'party:1' }]) expect(errorOf(search({ [field]: list }))).toBe(`team.${field} must be a list of MonRefs`);
    expect(errorOf(search({ [field]: ['party:1', 'party:1'] }))).toBe(`team.${field} lists party:1 twice`);
    expect(errorOf(search({ [field]: ['box:1:2'] }))).toBe(`team.${field} lists box:1:2, which is not in team.pool`);
    // Eligible, but left out of this pool: checked against the pool, not the box.
    expect(errorOf(search({ pool: ['party:1', 'party:2'], [field]: ['box:1:1'] }))).toBe(`team.${field} lists box:1:1, which is not in team.pool`);
  });

  it('refuses a ref in both lists, and checks mustBring before preferred', () => {
    expect(errorOf(search({ mustBring: ['party:1'], preferred: ['party:1'] }))).toBe('team.preferred lists party:1, which is also in team.mustBring');
    expect(errorOf(search({ mustBring: ['party:2', 'box:1:1'], preferred: ['party:1', 'box:1:1'] }))).toBe('team.preferred lists box:1:1, which is also in team.mustBring');
    expect(errorOf(search({ mustBring: 'party:1', preferred: 'party:1' }))).toBe('team.mustBring must be a list of MonRefs');
  });

  it('ignores the lists in the body of a fixed team', () => {
    for (const lists of [{ mustBring: ['party:1'], preferred: ['party:2'] }, { mustBring: 'not a list' }]) {
      expect(requestOf(body({ team: { kind: 'fixed', party: ['party:1'], ...lists } })).team).toStrictEqual({ kind: 'fixed', party: ['party:1'] });
    }
  });
});

describe('toSolveRequest: what-if levels', () => {
  it('carries the levels of a fixed team or a search pool as given, and leaves them out when absent or empty', () => {
    expect(requestOf(fixedLevels({ 'party:1': 18, 'party:2': 14 }), withSave).levels).toEqual({ 'party:1': 18, 'party:2': 14 });
    expect(requestOf(searchLevels({ 'box:1:1': 100 }), withSave).levels).toEqual({ 'box:1:1': 100 });
    expect(requestOf(fixedLevels({ 'party:1': 15 }), withSave).levels).toEqual({ 'party:1': 15 });   // the save level itself
    expect(toSolveRequest(fixedLevels(undefined), withSave)).toEqual(toSolveRequest(body({ team: { kind: 'fixed', party: ['party:1', 'party:2'] } }), withSave));
    for (const levels of [undefined, {}]) expect('levels' in requestOf(fixedLevels(levels), withSave)).toBe(false);
  });

  it.each<[string, unknown, string | RegExp]>([
    ['a list', fixedLevels(['party:1']), 'levels must be an object from MonRef to level'],
    ['null', fixedLevels(null), 'levels must be an object from MonRef to level'],
    ['a string level', fixedLevels({ 'party:1': '18' }), 'levels: the level for party:1 must be a whole number, not "18"'],
    ['a fraction', fixedLevels({ 'party:1': 18.5 }), /^levels: the level for party:1 must be a whole number/],
    ['below the save level', fixedLevels({ 'party:1': 14 }), 'levels: party:1 is level 15 in the save, so its level must be a whole number from 15 to 100, not 14'],
    ['over 100', fixedLevels({ 'party:2': 101 }), /from 14 to 100, not 101$/],
    ['a ref not in the team', body({ levels: { 'party:2': 20 } }), 'levels: party:2 is not in the team'],
    ['an eligible ref not in the pool', searchLevels({ 'party:2': 20 }), 'levels: party:2 is not in the pool'],
    ['an unknown ref', fixedLevels({ 'box:2:2': 20 }), 'levels: box:2:2 is not in the team'],
    ['a bad team first', body({ team: { kind: 'fixed', party: ['box:2:1'] }, levels: { 'party:1': 1 } }), 'box:2:1 is not eligible'],
  ])('refuses levels: %s', (_, request, error) => {
    if (typeof error === 'string') expect(errorOf(request, withSave)).toBe(error);
    else expect(errorOf(request, withSave)).toMatch(error);
  });
});

describe('refine', () => {
  it("passes 'first' and 'best' through, and leaves it out when absent", () => {
    for (const refine of ['first', 'best'] as const) expect(requestOf(body({ refine })).refine).toBe(refine);
    expect('refine' in requestOf(body())).toBe(false);
    expect(toSolveRequest(body({ refine: undefined }), ctx)).toEqual(toSolveRequest(body(), ctx));
  });
});
