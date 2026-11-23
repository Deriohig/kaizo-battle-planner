// No fixture fight reaches an outcome through a raw (unlabelled) draw. The fights cover every counter and chance site
// (sleep, freeze, confusion, paralysis, infatuation, durations, locks, binding, Protect, the picks, the procs, the hit-rate
// items, Struggle, rolls, crits, hits, multi-hit, OHKO, speed ties, Quick Claw and the named mechanics that draw). Each
// runs every legal choice pair for 3 steps over distinct states and must meet the chance points it names (`sites`).
// Weak attackers meet bulky targets so turns have few outcomes; counters a short fight never ends start near their end.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BattleInput, Choice, EngineState } from '../../../src/contracts/engine.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { createBattle, legalChoices, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
// As in counters.test.ts: these keep their Showdown behaviour (a text with no engine entry).
fixture.moves.get(ID.psywave)!.calc.baseMove = 'Psywave';
for (const id of [ID.outrage, ID.magnitude, ID.psywave]) fixture.moves.get(id)!.effectText = 'Fixture: the behaviour source\'s own effect';
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

// Every raw pick with a real choice, by its call site, and every chance point the current fight meets (`kind:source`).
const rawSites = new Map<string, number>();
let fightPoints = new Set<string>();
const originalPick = ChanceDriver.prototype.pick;
beforeAll(() => {
  vi.spyOn(ChanceDriver.prototype, 'pick').mockImplementation(function pick(this: ChanceDriver, kind, side, source, options) {
    fightPoints.add(`${kind}:${source}`);
    if (kind === 'raw' && options.filter((option) => option.weight > 0n).length > 1) {
      const site = `${source} at ${callSite(new Error().stack ?? '')}`;
      rawSites.set(site, (rawSites.get(site) ?? 0) + 1);
    }
    return originalPick.call(this, kind, side, source, options);
  });
});
afterAll(() => vi.restoreAllMocks());

const WRAPPERS = /engine\/chance\.ts|\/sim\/prng\.js|unlabelled\.test|node:internal|vitest|^(Battle\.)?(random|randomChance|sample|shuffle)\b|Object\.pick|^pick\b/;
/** The two innermost frames of `stack` that are neither the driver, the PRNG, nor Showdown's draw wrappers. */
const callSite = (stack: string): string =>
  stack.split('\n').slice(1).map((line) => line.trim().replace(/^at /, '')).filter((frame) => !WRAPPERS.test(frame)).slice(0, 2).join(' < ');

const move = (slot: number): Choice => ({ kind: 'move', slot });
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
const fight = (mine: PlayerMon, theirs: ResolvedMon | ResolvedMon[], enemyAbility?: number, extra: Partial<BattleInput> = {}): EngineState => createBattle({
  player: [mine], trainer: resolvedTrainer(BAG.none, Array.isArray(theirs) ? theirs : [theirs]), field: {},
  ...(enemyAbility === undefined ? {} : { world: { enemy: [{ ability: enemyAbility }] } }), ...extra,
});

const armored = { ability: knownAbility(ABILITY.battleArmor) };
const BA = ABILITY.battleArmor;
const weak = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.zigzagoon, 5, moves, fields);
const bulky = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.deoxys, 50, moves, { ...armored, ...fields });
const deoxys = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.deoxys, 50, moves, fields);
const little = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 5, moves, fields);
const bench = (moves: number[]) => [1, 2, 3].map(() => resolvedMon(ID.zigzagoon, 20, moves));
/** Adds `id` to the trainer's active Pokémon with its elapsed count set, so a short fight reaches its end. */
const nearEnd = (battle: Battle, id: string, count: number) => {
  expect(battle.p2.active[0]!.addVolatile(id, battle.p1.active[0]!)).toBe(true);
  battle.p2.active[0]!.volatiles[id]!['elapsed'] = count;
};

/** A fight, the chance points it must meet, and any it must not. */
interface Fight { name: string; start: () => EngineState; sites: string[]; absent?: string[]; steps?: number }
const F = (name: string, start: () => EngineState, sites: string[], extra: Partial<Fight> = {}): Fight => ({ name, start, sites, ...extra });

const FIGHTS: Fight[] = [
  F('sleep, Sleep Talk, freeze and a thawing move', () => fight(weak([ID.flameWheel, ID.sleepTalk], { status: { kind: 'freeze' } }), deoxys([ID.spore, ID.meanLook]), BA),
    ['thaw:frz', 'sleepWake:slp', 'effect:flamewheel', 'roll:flamewheel']),
  F('sleep with Early Bird', () => fight(weak([ID.growl], { ability: knownAbility(ABILITY.earlyBird) }), deoxys([ID.spore]), BA), ['sleepWake:slp']),
  F('confusion, paralysis and infatuation', () => fight(playerMon(ID.monferno, 30, [ID.confuseRay, ID.thunderWave], armored), little([ID.attract, ID.tackle], { gender: 'F' })),
    ['confusionSnap:confusion', 'selfHit:confusion', 'roll:confusion', 'fullPara:par', 'infatuation:attract']),
  F('Disable and Taunt near their ends', () => changed(runFirstOutcome(fight(bulky([ID.disable, ID.taunt]), little([ID.leechSeed, ID.tackle])), { p1: move(0), p2: move(0) }),
    (b) => { nearEnd(b, 'disable', 3); nearEnd(b, 'taunt', 2); }), ['durationEnd:disable', 'durationEnd:taunt']),
  F('Encore near its end', () => changed(runFirstOutcome(fight(bulky([ID.encore, ID.meanLook]), little([ID.leechSeed, ID.tackle])), { p1: move(1), p2: move(0) }),
    (b) => nearEnd(b, 'encore', 3)), ['durationEnd:encore']),
  F('Outrage, Uproar and the Protect chain', () => fight(weak([ID.outrage, ID.uproar]), deoxys([ID.protect, ID.meanLook]), BA),
    ['durationEnd:lockedmove', 'durationEnd:uproar', 'protect:protect']),
  F('binding and Endure', () => fight(bulky([ID.meanLook, ID.endure]), little([ID.wrap, ID.tackle])), ['durationEnd:partiallytrapped', 'protect:endure']),
  // Grip Claw's binding has a known length: no end-of-binding point.
  F('binding with Grip Claw', () => fight(bulky([ID.growl]), little([ID.wrap], { item: ITEM.gripClaw })), ['roll:wrap'], { absent: ['durationEnd:partiallytrapped'] }),
  ...([['Magnitude', ID.magnitude, 'pick:magnitude'], ['Psywave', ID.psywave, 'pick:psywave'], ['Present', ID.present, 'pick:present'],
    ['Tri Attack', ID.triAttack, 'effect:triattack']] as const).map(([name, id, site]) => F(name, () => fight(bulky([ID.growl]), little([id])), [site])),
  F('Struggle', () => fight(weak([ID.tackle], { pp: [0] }), deoxys([ID.meanLook]), BA), ['roll:struggle']),
  F('Roar', () => fight(weak([ID.roar]), bench([ID.growl])), ['hit:roar', 'switchTarget:roar']),
  F('Whirlwind', () => fight(weak([ID.whirlwind]), bench([ID.growl])), ['hit:whirlwind', 'switchTarget:whirlwind']),
  // At 2 HP a 1-damage hit leaves it up (Cute Charm draws), a bigger one would knock it out (Focus Band draws).
  F('Cute Charm, King\'s Rock and Focus Band', () => changed(fight(weak([ID.tackle], { item: ITEM.kingsRock }),
    resolvedMon(ID.zigzagoon, 20, [ID.meanLook], { gender: 'F', item: ITEM.focusBand }), ABILITY.cuteCharm), (b) => { b.p2.active[0]!.hp = 2; }),
  ['abilityProc:cutecharm', 'itemProc:kingsrock', 'itemProc:focusband']),
  F('Effect Spore and Razor Fang', () => fight(weak([ID.tackle], { item: ITEM.razorFang }), deoxys([ID.meanLook]), ABILITY.effectSpore),
    ['abilityProc:effectspore', 'itemProc:razorfang']),
  ...([['Static', ABILITY.static, 'static'], ['Flame Body', ABILITY.flameBody, 'flamebody'], ['Poison Point', ABILITY.poisonPoint, 'poisonpoint']] as const)
    .map(([name, ability, id]) => F(name, () => fight(weak([ID.tackle]), deoxys([ID.growl]), ability), [`abilityProc:${id}`])),
  F('Shed Skin', () => changed(fight(playerMon(ID.monferno, 30, [ID.meanLook]), resolvedMon(ID.zigzagoon, 20, [ID.meanLook]), ABILITY.shedSkin),
    (b) => { expect(b.p2.active[0]!.setStatus('psn')).toBe(true); }), ['abilityProc:shedskin']),
  // Tackle's 100 becomes 89 (the ROM's parameter 11): a hit point.
  ...([['BrightPowder', ITEM.brightPowder], ['Lax Incense', ITEM.laxIncense]] as const)
    .map(([name, item]) => F(name, () => fight(weak([ID.tackle]), deoxys([ID.growl], { item }), BA), ['hit:tackle'])),
  // One step: the called moves' own sites are the other fights'.
  F('Metronome', () => fight(weak([ID.metronome]), deoxys([ID.meanLook]), BA), ['pick:metronome'], { steps: 1 }),
  F('speed ties and Quick Claw', () => fight(weak([ID.meanLook], { item: ITEM.quickClaw }), little([ID.meanLook])), ['quickClaw:quickclaw', 'speedTie:actionOrder']),
  F('rolls, crits and accuracy', () => fight(weak([ID.megaKick]), deoxys([ID.meanLook])), ['roll:megakick', 'crit:megakick', 'hit:megakick']),
  F('one-hit KO moves', () => fight(bulky([ID.guillotine]), little([ID.growl])), ['hit:guillotine']),
  F('Pursuit, U-turn and Stealth Rock', () => fight(weak([ID.pursuit, ID.stealthRock]), [little([ID.uTurn]), little([ID.growl])]), ['roll:pursuit', 'roll:uturn']),
  // Every Explosion roll knocks Zigzagoon out: one option, so only its crit draws.
  F('Stomp, Minimize, Fake Out and Explosion', () => fight(weak([ID.stomp, ID.fakeOut]), deoxys([ID.minimize, ID.explosion]), BA), ['effect:stomp', 'roll:stomp', 'crit:explosion']),
  F('Counter, Focus Punch, Substitute and Rage', () => fight(bulky([ID.counter, ID.focusPunch]), deoxys([ID.rage, ID.substitute]), BA), ['roll:rage', 'roll:focuspunch']),
  F('Assist and Acupressure', () => fight(bulky([ID.assist, ID.acupressure]), deoxys([ID.meanLook]), BA,
    { player: [bulky([ID.assist, ID.acupressure]), { ...weak([ID.growl, ID.meanLook]), location: { kind: 'party', slot: 1 } }] }), ['pick:assist', 'pick:acupressure'], { steps: 1 }),
  // One step: every roll of each hit count is a leaf, so later steps only repeat its picks.
  F('multi-hit moves', () => fight(bulky([ID.growl]), little([ID.furyAttack])), ['multiHit:furyattack'], { steps: 1 }),
];

/** Every legal combination of choices for the sides `state`'s phase asks. */
function choiceSets(state: EngineState): { p1?: Choice; p2?: Choice }[] {
  const [mine, theirs] = [legalChoices(state, 'p1'), legalChoices(state, 'p2')];
  switch (state.phase.kind) {
    case 'turnChoice': return mine.flatMap((p1) => theirs.map((p2) => ({ p1, p2 })));
    case 'playerMidTurnSwitch': return mine.map((p1) => ({ p1 }));
    case 'playerReplacement': return theirs.length > 0 ? mine.flatMap((p1) => theirs.map((p2) => ({ p1, p2 }))) : mine.map((p1) => ({ p1 }));
    case 'enemyMidTurnSwitch': case 'enemyReplacement': return theirs.map((p2) => ({ p2 }));
    case 'terminal': return [];
  }
}

/** Runs `fight` for its steps (default 3) over every legal choice set from every distinct state: its unlabelled outcomes and the points it met. */
function sweep(fight: Fight): { unlabelled: string[]; points: Set<string> } {
  fightPoints = new Set();
  const start = fight.start();
  let frontier = [start];
  const seen = new Set([start.key]);
  const unlabelled: string[] = [];
  for (let step = 1; step <= (fight.steps ?? 3); step++) {
    const next: EngineState[] = [];
    for (const state of frontier) {
      for (const choices of choiceSets(state)) {
        for (const outcome of expandTurn(state, choices, { maxLeaves: 200_000 })) {
          if (outcome.unlabelled) unlabelled.push(`${fight.name}: step ${step}, ${JSON.stringify(choices)}`);
          if (!seen.has(outcome.state.key)) {
            seen.add(outcome.state.key);
            next.push(outcome.state);
          }
        }
      }
    }
    frontier = next;
  }
  return { unlabelled, points: fightPoints };
}

describe('labelled chances', () => {
  it('no unlabelled chances in the fixture fights, and each fight meets its sites', () => {
    const missed: string[] = [];
    const unlabelled = FIGHTS.flatMap((each) => {
      const { unlabelled: raw, points } = sweep(each);
      for (const site of each.sites) if (!points.has(site)) missed.push(`${each.name}: never met ${site}`);
      for (const site of each.absent ?? []) if (points.has(site)) missed.push(`${each.name}: met ${site}`);
      return raw;
    });
    expect(missed).toEqual([]);
    // On failure the message lists each raw pick's call site (with how often it drew), then the outcomes it reached.
    const sites = [...rawSites].sort(([, a], [, b]) => b - a).map(([site, n]) => `${n}x ${site}`);
    const report = [`${unlabelled.length} unlabelled outcomes; raw picks by call site:`, ...sites, 'first unlabelled outcomes:', ...unlabelled.slice(0, 10)].join('\n');
    expect(sites, report).toEqual([]);
    expect(unlabelled, report).toEqual([]);
  }, 600_000);
});
