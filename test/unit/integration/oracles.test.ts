import { beforeAll, describe, expect, it } from 'vitest';
import { buildMoves } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import { damage } from '../../../src/calc/calc.js';
import type { BattleInput, Choice, Engine, EngineState, Outcome, Rational } from '../../../src/contracts/engine.js';
import {
  add, createBattle, expandTurn, installKaizoDex, mul, rat, residueWeights, restore, showdownEngine, snapshot, U16,
} from '../../../src/engine/index.js';
import { activeOf, buildLookups } from '../../../src/integration/battleView.js';
import { createOracles, psywaveValues } from '../../../src/integration/oracles.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { ABILITY, BAG, emberTurn, fixtureData, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';

type Battle = ReturnType<typeof restore>;
const COUNTER = 68;   // the ROM's Counter: a hit the calc cannot bound
const DOWNLOAD = 88;

// The engine fixture's dex with Counter added, and its vanilla Psywave run on Showdown's Psywave with the calc's spec.
const data = fixtureData();
data.rom.moves[COUNTER] = { id: COUNTER, effect: 89, category: 'physical', power: 1, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 1, priority: -5, flags: 1 };
data.docs.moves.push({
  id: COUNTER, name: 'Counter', effectText: '2x last amount of damage received', category: 'physical', power: 1, type: '', accuracy: 100, pp: 20,
  effectChance: 0, targets: '', priority: -5, contact: false,
});
data.names = buildNameIndex(data.docs);
const fixture = { data, moves: buildMoves(data) };
const psywave = fixture.moves.get(ID.psywave)!;
psywave.calc.baseMove = 'Psywave';
psywave.calc.fixedDamage = 'psywave';
psywave.effectText = 'Fixture: the behaviour source\'s own effect';
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const MOVE_0: Choice = { kind: 'move', slot: 0 };
const BOTH_FIRST = { p1: MOVE_0, p2: MOVE_0 };
const FERNANDO = 'p1a: Fernando';
const ZIG = 'p2a: Zigzagoon';
const MONFERNO = 'p1a: Monferno';

type Oracles = ReturnType<typeof createOracles>;
const oraclesFor = (input: BattleInput, engine: Engine = showdownEngine): Oracles => createOracles({
  data: fixture.data, moves: fixture.moves, player: input.player, engine,
  trainer: (romIndex) => (romIndex === input.trainer.romIndex ? input.trainer : undefined),
});
const setup = (input: BattleInput, engine: Engine = showdownEngine) => ({ before: createBattle(input), oracles: oraclesFor(input, engine) });
/** `setup` with the battle changed by `edit` before the step. */
function edited(input: BattleInput, edit: (battle: Battle) => void) {
  const battle = restore(createBattle(input));
  edit(battle);
  return { before: snapshot(battle), oracles: oraclesFor(input) };
}
const check = (oracles: Oracles, before: EngineState, outcome: Outcome) => oracles.damage.check({ before, choices: BOTH_FIRST, outcome });
const forged = (outcome: Outcome, edit: (line: string) => string): Outcome => ({ ...outcome, log: outcome.log.map(edit) });

/** Every outcome of the step through the oracle; the checks, mismatches and skipped hits summed. */
function checkAll(oracles: Oracles, before: EngineState, outcomes = expandTurn(before, BOTH_FIRST)) {
  let checks = 0;
  const mismatches: string[] = [];
  const skipped: Record<string, number> = {};
  for (const outcome of outcomes) {
    const result = check(oracles, before, outcome);
    checks += result.checks;
    mismatches.push(...result.mismatches);
    for (const [move, hits] of Object.entries(result.skipped ?? {})) skipped[move] = (skipped[move] ?? 0) + hits;
  }
  return { checks, mismatches, skipped, outcomes };
}

/** How many move (not residual) damage lines `o` holds on `victim`: each is one hit. */
const hitsOn = (o: Outcome, victim: string) => o.log.filter((l) => l.startsWith(`|-damage|${victim}|`) && !l.includes('[from]')).length;
const hitOn = (o: Outcome, victim: string) => hitsOn(o, victim) > 0;
/** An oracle result's `skipped` for these per-move hit counts, absent when none has any. */
const skippedOf = (counts: Record<string, number>) => {
  const named = Object.fromEntries(Object.entries(counts).filter(([, hits]) => hits > 0));
  return Object.keys(named).length === 0 ? {} : { skipped: named };
};
const koOf = (o: Outcome, victim: string) => o.log.includes(`|-damage|${victim}|0 fnt`);
const nonCritHitOn = (o: Outcome, victim: string) => !o.log.some((l) => l.startsWith(`|-crit|${victim}`)) && o.log.some((l) => l.startsWith(`|-damage|${victim}|`) && !l.includes('[from]'));

/** Fernando (Monferno L30, Mean Look first) against a Zigzagoon L20 with `enemyMove`, on `hp(rolls, critRolls)` HP. */
function enemyHits(enemyMove: number, hp: (rolls: number[], critRolls: number[]) => number) {
  const fernando = playerMon(ID.monferno, 30, [ID.meanLook], { nickname: 'Fernando' });
  const zigzagoon = resolvedMon(ID.zigzagoon, 20, [enemyMove]);
  const result = damage({ mon: zigzagoon }, { mon: fernando }, fixture.moves.get(enemyMove)!, {})!;
  const at = hp(result.rolls, result.critRolls);
  const input: BattleInput = { player: [{ ...fernando, currentHp: at }], trainer: resolvedTrainer(BAG.none, [zigzagoon]), field: {} };
  return { input, rolls: result.rolls, hp: at };
}
const between = (rolls: number[]) => Math.min(...rolls) + 1;   // the lowest roll leaves 1 HP, the highest KOs

/** The real engine with its steps' outcomes passed through `edit`. */
const doctored = (edit: (outcomes: Outcome[]) => Outcome[]): Engine => ({
  ...showdownEngine, expandTurn: (state, choices, opts) => edit(showdownEngine.expandTurn(state, choices, opts)),
});

/** An engine where every non-crit (or, with `crits`, crit) hit on `victim` KOs, the outcomes merged as the engine merges them. */
function overstating(victim: string, crits = false): Engine {
  return doctored((outcomes) => {
    const merged = new Map<string, Outcome>();
    for (const o of outcomes) {
      const crit = o.log.some((l) => l.startsWith(`|-crit|${victim}`));
      const log = o.log.flatMap((l) => (crit === crits && l.startsWith(`|-damage|${victim}|`) && !l.includes('[from]') && !l.includes('fnt') ? [`|-damage|${victim}|0 fnt`, `|faint|${victim}`] : [l]));
      const key = log.join('\n');
      const same = merged.get(key);
      merged.set(key, same === undefined ? { ...o, log } : { ...same, probability: add(same.probability, o.probability), merged: same.merged + o.merged });
    }
    return [...merged.values()];
  });
}

describe('the damage oracle', () => {
  it("checks every move's damage line (after Mean Look's trap) against damage(), naming nothing skipped", () => {
    const { before, oracles } = setup(emberTurn());
    let checks = 0;
    for (const outcome of expandTurn(before, BOTH_FIRST)) {
      const result = check(oracles, before, outcome);
      expect(result).toStrictEqual({ checks: expect.any(Number), mismatches: [] });
      checks += result.checks;
    }
    expect(checks).toBeGreaterThan(0);
  });

  it('reports damage no roll gives', () => {
    const { before, oracles } = setup(emberTurn());
    const outcome = expandTurn(before, BOTH_FIRST).find((o) => o.log.some((l) => /^\|-damage\|p2a: [^|]+\|\d+\/\d+$/.test(l)))!;
    const bad = forged(outcome, (line) => (line.startsWith('|-damage|p2a') ? line.replace(/\|(\d+)\/(\d+)/, (_, _hp, max) => `|${Number(max) - 1}/${max}`) : line));
    const result = check(oracles, before, bad);
    expect(result).toMatchObject({ checks: 1, mismatches: [expect.stringMatching(/Ember/)] });
  });

  it("works a hit out under the defender's Reflect", () => {
    const { before, oracles } = edited(emberTurn([ID.meanLook], { moves: [ID.tackle], pp: [35] }), (b) => { b.p2.addSideCondition('reflect', 'debug'); });
    const { checks, mismatches } = checkAll(oracles, before);
    expect([mismatches, checks > 0]).toEqual([[], true]);
  });

  describe('a KO that depends on the roll', () => {
    it("checks the step at the calc's odds: every non-KO value and the engine's one collapsed '≥hp' KO; keeps plain data", () => {
      const { input, rolls, hp } = enemyHits(ID.megaKick, between);
      expect([Math.min(...rolls) < hp, rolls.filter((r) => r >= hp).length > 1]).toEqual([true, true]);
      const { before, oracles } = setup(input);
      const { checks, mismatches, outcomes } = checkAll(oracles, before);
      const kos = outcomes.filter((o) => koOf(o, FERNANDO) && nonCritHitOn(o, FERNANDO));
      expect(kos).toHaveLength(1);
      expect(kos[0]!.labels.some((l) => l.kind === 'roll' && l.outcome === '≥hp')).toBe(true);
      expect([mismatches, checks > 0]).toEqual([[], true]);
      // The cache holds no restored battle (a battle holds functions, which cannot be cloned).
      expect(oracles.cachedExpansions().length).toBeGreaterThan(0);
      expect(() => structuredClone(oracles.cachedExpansions())).not.toThrow();
    });

    it('counts a KO that every roll gives', () => {
      const { before, oracles } = setup(enemyHits(ID.megaKick, () => 1).input);
      const { checks, mismatches, outcomes } = checkAll(oracles, before);
      expect([outcomes.some((o) => koOf(o, FERNANDO)), mismatches, checks > 0]).toEqual([true, [], true]);
    });

    it('reports an engine that overstates the damage so that every roll KOs', () => {
      const engine = overstating(FERNANDO);
      const { before, oracles } = setup(enemyHits(ID.megaKick, between).input, engine);
      const outcomes = engine.expandTurn(before, BOTH_FIRST);
      expect(outcomes.some((o) => koOf(o, FERNANDO) && !o.log.some((l) => l.startsWith('|-crit|')))).toBe(true);
      expect(checkAll(oracles, before, outcomes).mismatches[0]).toMatch(/Mega Kick/);
    });

    it('reports a hit that leaves 1 HP where every roll KOs', () => {
      const { before, oracles } = setup(enemyHits(ID.megaKick, () => 5).input);
      const outcome = expandTurn(before, BOTH_FIRST).find((o) => koOf(o, FERNANDO))!;
      const survived = outcome.log.filter((l) => l !== `|faint|${FERNANDO}`).map((l) => (l === `|-damage|${FERNANDO}|0 fnt` ? `|-damage|${FERNANDO}|1/97` : l));
      expect(check(oracles, before, { ...outcome, log: survived })).toMatchObject({ checks: 1, mismatches: [expect.any(String)] });
    });

    it('a pass cut after its first outcome, then a full pass, still reports the mismatch', () => {
      // Every crit KOs in this engine, where the calc's crit rolls straddle Fernando's HP.
      const { input } = enemyHits(ID.megaKick, (rolls, critRolls) => Math.max(Math.max(...rolls) + 1, Math.min(...critRolls) + 1));
      const engine = overstating(FERNANDO, true);
      const { before, oracles } = setup(input, engine);
      const outcomes = engine.expandTurn(before, BOTH_FIRST);
      expect(outcomes[0]!.log.some((l) => l.startsWith(`|-crit|${FERNANDO}`)) && koOf(outcomes[0]!, FERNANDO)).toBe(true);
      check(oracles, before, outcomes[0]!);
      expect(checkAll(oracles, before, outcomes).mismatches.length).toBeGreaterThan(0);
    });

    it('reports an engine that gives the KO on 14 of 16 rolls where the calc gives another share, the values unchanged', () => {
      const { input, rolls, hp } = enemyHits(ID.megaKick, between);
      const calcKo = rolls.filter((r) => r >= hp).length;
      const share = calcKo === 14 ? 13 : 14;
      const engine = doctored((outcomes) => outcomes.map((o) => {
        if (!nonCritHitOn(o, FERNANDO)) return o;
        const scale = koOf(o, FERNANDO) ? rat(BigInt(share), BigInt(calcKo)) : rat(BigInt(16 - share), BigInt(16 - calcKo));
        return { ...o, probability: mul(o.probability, scale) };
      }));
      const { before, oracles } = setup(input, engine);
      expect(checkAll(oracles, before, engine.expandTurn(before, BOTH_FIRST)).mismatches.join('\n')).toMatch(/odds|of 16/);
    });

    it('a Focus Sash that saves at 1 HP (announced only after the damage) is no mismatch', () => {
      const FOCUS_SASH = 275;
      const { before, oracles } = setup({
        player: [playerMon(ID.monferno, 30, [ID.megaKick])],
        trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook], { item: FOCUS_SASH })]), field: {},
      });
      const { mismatches, outcomes } = checkAll(oracles, before);
      expect(outcomes.some((o) => o.log.some((l) => /^\|-damage\|p2a: Zigzagoon\|1\//.test(l)) && o.log.some((l) => l.startsWith('|-enditem|p2a: Zigzagoon|Focus Sash')))).toBe(true);
      expect(mismatches).toEqual([]);
    });
  });

  describe('counts no check where the calc cannot model the hit, naming the hits skipped', () => {
    it.each<[string, number, number]>([['Present', ID.present, 15], ['Guillotine', ID.guillotine, 5]])('%s (unbounded or OHKO)', (name, move, pp) => {
      const { before, oracles } = setup(emberTurn([ID.meanLook], { moves: [move], pp: [pp] }));
      const { checks, mismatches, skipped, outcomes } = checkAll(oracles, before);
      const hits = outcomes.filter((o) => hitOn(o, ZIG)).length;
      expect(hits).toBeGreaterThan(0);
      expect({ checks, mismatches, skipped }).toEqual({ checks: 0, mismatches: [], skipped: { [name]: hits } });
    });

    it.each<[string, number[], (log: string[]) => string[]]>([
      ['a boost earlier in the step', [ID.meanLook], (log) => log.flatMap((l) => (l.startsWith('|move|p1a') ? ['|-boost|p1a: Monferno|spa|1', l] : [l]))],
      ['a copied move ([from] on its move line, as Me First)', [ID.meanLook], (log) => log.map((l) => (l.startsWith('|move|p1a') ? `${l}|[from] move: Me First` : l))],
      ['an activation that may change the battle (Skill Swap logs no -ability)', [ID.tackle], (log) => ['|-activate|p1a: Monferno|move: Skill Swap|||[of] p2a: Zigzagoon', ...log]],
    ])('any hit after %s', (_, enemy, edit) => {
      const { before, oracles } = setup(emberTurn(enemy));
      for (const outcome of expandTurn(before, BOTH_FIRST)) {
        const o = { ...outcome, log: edit(outcome.log) };
        expect(check(oracles, before, o)).toEqual({ checks: 0, mismatches: [], ...skippedOf({ Ember: hitsOn(o, ZIG), Tackle: hitsOn(o, MONFERNO) }) });
      }
    });

    it('a Download holder (the calc would add its boost again)', () => {
      const { before, oracles } = setup(emberTurn([ID.meanLook], { ability: knownAbility(DOWNLOAD) }));
      expect(checkAll(oracles, before)).toMatchObject({ checks: 0, mismatches: [] });
    });

    it('a Counter hit is skipped; the Tackle it returns is checked', () => {
      const { before, oracles } = setup(emberTurn([ID.tackle], { moves: [COUNTER], pp: [20] }));
      const countered = expandTurn(before, BOTH_FIRST).filter((o) => o.log.some((l) => l.startsWith('|move|p1a: Monferno|Counter|')) && hitOn(o, ZIG));
      expect(countered.length).toBeGreaterThan(0);
      for (const outcome of countered) expect(check(oracles, before, outcome)).toEqual({ checks: 1, mismatches: [], skipped: { Counter: 1 } });
    });

    it("each hit of a multi-hit move, and False Swipe's hit", () => {
      // A weakened Zigzagoon (25 HP) keeps the step small and still takes 3 hits or more.
      const input = emberTurn([ID.meanLook], { moves: [ID.furyAttack], pp: [20] });
      const fury = edited(input, (b) => { b.p2.active[0]!.hp = 25; });
      const outcomes = expandTurn(fury.before, BOTH_FIRST);
      expect(Math.max(...outcomes.map((o) => hitsOn(o, ZIG)))).toBeGreaterThan(2);
      for (const outcome of outcomes) {
        expect(check(fury.oracles, fury.before, outcome)).toEqual({ checks: 0, mismatches: [], ...skippedOf({ 'Fury Attack': hitsOn(outcome, ZIG) }) });
      }
      const swipe = setup(emberTurn([ID.meanLook], { moves: [ID.falseSwipe], pp: [40] }));
      const swiped = expandTurn(swipe.before, BOTH_FIRST).filter((o) => hitOn(o, ZIG));
      expect(swiped.length).toBeGreaterThan(0);
      for (const outcome of swiped) expect(check(swipe.oracles, swipe.before, outcome)).toEqual({ checks: 0, mismatches: [], skipped: { 'False Swipe': 1 } });
    });

    // A delayed hit or Bide's release has no move line of its own; Taunt, Encore and Disable ending do not take the hit.
    const DAMAGE = '|-damage|p2a: Zigzagoon|20/52';
    const EMBER_LINE = '|move|p1a: Monferno|Ember|p2a: Zigzagoon';
    it.each<[string, string[], string]>([
      ['Future Sight', ['|-end|p2a: Zigzagoon|move: Future Sight', DAMAGE], 'Future Sight'],
      ['Bide', ['|-end|p1a: Monferno|move: Bide', DAMAGE], 'Bide'],
      ...['Taunt', 'Encore', 'Disable'].map((ended): [string, string[], string] => [ended, [EMBER_LINE, `|-end|p2a: Zigzagoon|move: ${ended}`, DAMAGE], 'Ember']),
    ])('a hit after the end of %s goes to the right move', (_, log, move) => {
      const { before, oracles } = setup(emberTurn());
      const outcome = expandTurn(before, BOTH_FIRST)[0]!;
      expect(check(oracles, before, { ...outcome, log })).toEqual({ checks: 0, mismatches: [], skipped: { [move]: 1 } });
    });

    it.each<[number, string]>([[200, '|-activate|p2a: Zigzagoon|Substitute|[damage]'], [1, '|-end|p2a: Zigzagoon|Substitute']])(
      'a hit a Substitute takes (sub HP %i: %s), which logs no -damage',
      (subHp, line) => {
        const { before, oracles } = edited(emberTurn([ID.meanLook], { moves: [ID.tackle], pp: [35] }), (b) => {
          const foe = b.p2.active[0]!;
          foe.addVolatile('substitute');
          foe.volatiles['substitute']!['hp'] = subHp;
        });
        const outcomes = expandTurn(before, BOTH_FIRST);
        expect(outcomes.length).toBeGreaterThan(0);
        for (const outcome of outcomes) {
          expect(outcome.log).toContain(line);
          expect(check(oracles, before, outcome)).toEqual({ checks: 0, mismatches: [], skipped: { Tackle: 1 } });
        }
      },
    );

    it("names Bide's release on the real engine: `-end|<user>|move: Bide`, then the hit", () => {
      const start = setup(emberTurn([ID.tackle], { moves: [ID.bide], pp: [10] }));
      let { before } = start;
      let released: Outcome[] = [];
      for (let turn = 0; turn < 4 && released.length === 0; turn++) {
        const outcomes = expandTurn(before, BOTH_FIRST);
        released = outcomes.filter((o) => o.log.includes('|-end|p1a: Monferno|move: Bide'));
        before = released.length === 0 ? outcomes[0]!.state : before;
      }
      expect(released.length).toBeGreaterThan(0);
      for (const outcome of released) {
        expect(hitOn(outcome, ZIG)).toBe(true);
        expect(check(start.oracles, before, outcome)).toEqual({ checks: 0, mismatches: [], ...skippedOf({ Bide: hitsOn(outcome, ZIG), Tackle: hitsOn(outcome, MONFERNO) }) });
      }
    });

    it('never names damage no move dealt: residuals, recoil, items, abilities, hazards, confusion', () => {
      // Checks plus named hits add up to the move damage lines alone. In the `away` cases the damage lands on the side
      // the last move line did not come from, so only its `[from]` keeps it out.
      const zig = (fields: Partial<PlayerMon> = {}, moves: number[] = [ID.growl], level = 30) => playerMon(ID.zigzagoon, level, moves, fields);
      const foe = (moves: number[] = [ID.growl], fields = {}) => resolvedMon(ID.zigzagoon, 20, moves, fields);
      const duel = (player: PlayerMon, party = [foe()]): BattleInput => ({ player: [player], trainer: resolvedTrainer(BAG.none, party), field: {} });
      const LIFE_ORB = 270;
      const cases: { name: string; input: BattleInput; edit?: (battle: Battle) => void; line: RegExp }[] = [
        { name: 'burn residual (away)', input: duel(zig({ status: { kind: 'burn' } })), line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] brn$/ },
        { name: 'poison residual (away)', input: duel(zig({ status: { kind: 'poison' } })), line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] psn$/ },
        { name: 'Leech Seed (away)', input: duel(zig(), [foe([ID.leechSeed])]), line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] Leech Seed/ },
        { name: 'Sandstorm (away)', input: duel(zig()), edit: (b) => { b.field.setWeather('sandstorm', b.p2.active[0]!); }, line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] Sandstorm/ },
        {
          name: 'Spikes on a Pokémon Whirlwind drags in (away)', input: duel(zig({}, [ID.whirlwind]), [foe(), resolvedMon(ID.castform, 20, [ID.growl])]),
          edit: (b) => { b.p2.addSideCondition('spikes', 'debug'); }, line: /^\|-damage\|p2a: Castform\|[^|]+\|\[from\] Spikes/,
        },
        // Overheat's "1/3 damage dealt recoil" recoils (the fixture's Double-Edge runs as its Tackle base); L12 keeps the foe up.
        { name: 'recoil (Overheat)', input: duel(zig({}, [ID.overheat], 12)), line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] Recoil$/ },
        { name: 'Life Orb', input: duel(zig({ item: LIFE_ORB }, [ID.tackle])), line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] item: Life Orb/ },
        { name: 'Rough Skin', input: duel(zig({}, [ID.tackle]), [foe([ID.growl], { ability: knownAbility(ABILITY.roughSkin) })]), line: /^\|-damage\|p1a: Zigzagoon\|[^|]+\|\[from\] ability: Rough Skin/ },
      ];
      const moveLines = (o: Outcome) => o.log.filter((l) => l.startsWith('|-damage|') && !l.includes('[from]')).length;
      for (const c of cases) {
        const { before, oracles } = edited(c.input, c.edit ?? (() => undefined));
        const outcomes = expandTurn(before, BOTH_FIRST);
        expect(outcomes.some((o) => o.log.some((l) => c.line.test(l))), `${c.name}: its damage line`).toBe(true);
        for (const outcome of outcomes) {
          const result = check(oracles, before, outcome);
          expect(result.checks + Object.values(result.skipped ?? {}).reduce((a, b) => a + b, 0), c.name).toBe(moveLines(outcome));
        }
      }
      // A confusion self-hit, forged as Showdown logs it, after Zigzagoon's move.
      const { before, oracles } = setup(emberTurn());
      const confused = ['|move|p2a: Zigzagoon|Mean Look|p1a: Monferno', '|-activate|p1a: Monferno|trapped', '|-activate|p1a: Monferno|confusion', '|-damage|p1a: Monferno|40/76|[from] confusion'];
      expect(check(oracles, before, { ...expandTurn(before, BOTH_FIRST)[0]!, log: confused })).toEqual({ checks: 0, mismatches: [] });
    });
  });

  describe("Psywave's odds: its 11 values at the cartridge's 16-bit draws mod 11, not the calc's 16 roll slots", () => {
    const psywaveTurn = (level: number): BattleInput => ({
      player: [playerMon(ID.monferno, level, [ID.psywave])],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook])]), field: {},
    });
    /** Psywave's damage for x from 5 to 15 (effect_script_0088.s), written out apart from the calc and the oracle. */
    const dealt = (level: number, x: number) => Math.max(1, Math.floor((level * x) / 10));
    const xsOf = (level: number, value: number) => Array.from({ length: 11 }, (_, k) => 5 + k).filter((x) => dealt(level, x) === value);
    /** How many of the calc's 16 roll slots hold `value`: slot i holds x = 5 + floor(i × 11 / 16). */
    const slotsOf = (level: number, value: number) => Array.from({ length: 16 }, (_, i) => 5 + Math.floor((i * 11) / 16)).filter((x) => dealt(level, x) === value).length;
    /** The damage of `o`'s hit on a full-HP Zigzagoon, or null when Psywave did not hit it. */
    const damageOf = (o: Outcome): number | null => {
      const m = /\|(\d+)\/(\d+)$/.exec(o.log.find((l) => l.startsWith(`|-damage|${ZIG}|`) && !l.includes('[from]')) ?? '');
      return m === null ? null : Number(m[2]) - Number(m[1]);
    };
    /** The real engine with each Psywave hit's odds replaced by `share(value)` (its residue-weighted draws divided out). */
    const psywaveOdds = (level: number, share: (value: number) => Rational): Engine => {
      const weights = residueWeights(11);
      return doctored((outcomes) => outcomes.map((o) => {
        const value = damageOf(o);
        if (value === null) return o;
        const drawn = xsOf(level, value).reduce((sum, x) => sum + weights[x - 5]!, 0n);
        return { ...o, probability: mul(mul(o.probability, rat(U16, drawn)), share(value)) };
      }));
    };
    const elevenths = (level: number) => (value: number) => rat(xsOf(level, value).length, 11);
    const sixteenths = (level: number) => (value: number) => rat(slotsOf(level, value), 16);
    const checkUnder = (level: number, engine: Engine) => {
      const { before, oracles } = setup(psywaveTurn(level), engine);
      return checkAll(oracles, before, engine.expandTurn(before, BOTH_FIRST));
    };
    /** Each damage's share of the outcomes that hold a Psywave hit. */
    const sharesOf = (outcomes: Outcome[]): Map<number, Rational> => {
      const summed = new Map<number, Rational>();
      let total = rat(0, 1);
      for (const o of outcomes) {
        const value = damageOf(o);
        if (value === null) continue;
        summed.set(value, add(summed.get(value) ?? rat(0, 1), o.probability));
        total = add(total, o.probability);
      }
      return new Map([...summed].map(([value, p]) => [value, mul(p, rat(total.den, total.num))]));
    };
    /** The engine's odds a mismatch gives for `value` against the calc's `count` of `of`, or null. */
    const oddsIn = (mismatch: string | undefined, value: number, count: number, of: number): Rational | null => {
      const m = new RegExp(`(?:^|; |HP: )${value}: the engine's odds (\\d+)/(\\d+), the calc's ${count} of ${of}(?:;|$)`).exec(mismatch ?? '');
      return m === null ? null : rat(BigInt(m[1]!), BigInt(m[2]!));
    };

    it("passes the engine's own odds (each x at its residue's 16-bit draws), and reports 1/11 or 16-slot odds", () => {
      const weights = residueWeights(11);
      expect(weights).toEqual([...Array<bigint>(9).fill(5958n), 5957n, 5957n]);
      const { checks, mismatches, outcomes } = checkUnder(28, showdownEngine);
      const shares = sharesOf(outcomes);   // at level 28 the 11 values all differ
      expect([...shares.keys()].sort((a, b) => a - b)).toEqual([14, 16, 19, 22, 25, 28, 30, 33, 36, 39, 42]);
      for (const [value, share] of shares) expect(share, `${value}`).toEqual(rat(weights[xsOf(28, value)[0]! - 5]!, U16));
      expect([mismatches, checks]).toEqual([[], outcomes.filter((o) => hitOn(o, ZIG)).length]);

      const even = checkUnder(28, psywaveOdds(28, elevenths(28))).mismatches[0];
      expect([oddsIn(even, 14, 5958, 65536), oddsIn(even, 42, 5957, 65536)], even).toEqual([rat(1, 11), rat(1, 11)]);
      expect(slotsOf(28, 14)).toBe(2);   // the slots hold x = 5, 7, 9, 11 and 13 twice
      const slotted = checkUnder(28, psywaveOdds(28, sixteenths(28))).mismatches[0];
      expect(oddsIn(slotted, 14, 5958, 65536), slotted).toEqual(rat(2, 16));
    });

    it("at level 5, a damage two x values give has the two x's weights summed", () => {
      expect([xsOf(5, 3), xsOf(5, 7)]).toEqual([[6, 7], [14, 15]]);
      const weights = residueWeights(11);
      expect([weights[1]! + weights[2]!, weights[9]! + weights[10]!]).toEqual([11916n, 11914n]);
      const real = checkUnder(5, showdownEngine);
      expect([sharesOf(real.outcomes).get(3), real.mismatches, real.checks > 0]).toEqual([rat(11916, U16), [], true]);
      const even = checkUnder(5, psywaveOdds(5, elevenths(5))).mismatches[0];
      expect([oddsIn(even, 3, 11916, 65536), oddsIn(even, 7, 11914, 65536)], even).toEqual([rat(2, 11), rat(2, 11)]);
      const slotted = checkUnder(5, psywaveOdds(5, sixteenths(5))).mismatches[0];
      expect(oddsIn(slotted, 3, 11916, 65536), slotted).toEqual(rat(3, 16));
    });

    it.each([1, 5, 28, 50, 100])("the oracle's Psywave values are the calc's at level %i", (level) => {
      const result = damage({ mon: playerMon(ID.monferno, level, [ID.psywave]) }, { mon: resolvedMon(ID.zigzagoon, 20, [ID.meanLook]) }, psywave, {})!;
      const note = /Psywave: (\d+(?:, \d+)*), each 1\/11/.exec(result.desc);
      expect(note, result.desc).not.toBeNull();
      expect(psywaveValues(level)).toEqual(note![1]!.split(', ').map(Number));
    });

    it("the fallback's value check (the engine's own expansion failed) accepts a Psywave value and refuses any other", () => {
      const failing = doctored(() => {
        throw new Error('an engine limit');
      });
      const { before, oracles } = setup(psywaveTurn(28), failing);
      const outcome = expandTurn(before, BOTH_FIRST).find((o) => hitOn(o, ZIG))!;
      expect(check(oracles, before, outcome)).toEqual({ checks: 1, mismatches: [] });
      // 15 HP lies between x = 5's 14 and x = 6's 16.
      const fifteen = forged(outcome, (l) => (l.startsWith(`|-damage|${ZIG}|`) ? l.replace(/\|(\d+)\/(\d+)$/, (_, _hp, max) => `|${Number(max) - 15}/${max}`) : l));
      expect(check(oracles, before, fifteen)).toEqual({
        checks: 1, mismatches: [expect.stringMatching(/Psywave took Zigzagoon from \d+ to \d+ HP; the calc's rolls give 14, 16, 19, 22, 25, 28, 30, 33, 36, 39, 42$/)],
      });
    });
  });

  it('passes the stop to its engine step, rethrows STOPPED and never keeps a stopped step as a failed expansion', () => {
    let asked = 0;
    const stop = Object.assign(new Error('stopped'), { code: 'STOPPED' });
    const engine: Engine = {
      ...showdownEngine,
      expandTurn: (state, choices, opts) => {
        asked += 1;
        if (opts?.shouldStop?.() === true) throw stop;
        return showdownEngine.expandTurn(state, choices, opts?.maxLeaves === undefined ? undefined : { maxLeaves: opts.maxLeaves });
      },
    };
    const { before, oracles } = setup(emberTurn(), engine);
    const outcome = expandTurn(before, BOTH_FIRST).find((o) => o.log.some((l) => /^\|-damage\|p2a: [^|]+\|\d+\/\d+$/.test(l)))!;
    const thrown = (() => {
      try {
        oracles.damage.check({ before, choices: BOTH_FIRST, outcome, shouldStop: () => true });
      } catch (e) {
        return e;
      }
    })();
    expect(thrown).toBe(stop);
    expect([asked, oracles.cachedExpansions()]).toEqual([1, []]);
    const result = check(oracles, before, outcome);   // asked again without a stop: run, kept, no failure
    expect([asked, result.mismatches, result.checks > 0]).toEqual([2, [], true]);
    expect(oracles.cachedExpansions().map((x) => x.failed)).toEqual([false]);
  });
});

describe("matching the player's Pokémon in the battle", () => {
  const viewOfLead = (team: PlayerMon[], fighter: PlayerMon) => {
    const input: BattleInput = { player: [fighter], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.tackle])]), field: {} };
    const ctx = { data: fixture.data, moves: fixture.moves, player: team, trainer: () => input.trainer };
    return activeOf(restore(createBattle(input)), input.trainer, 'p1', ctx, buildLookups(fixture.moves));
  };
  const ivs = (atk: number) => ({ hp: 31, atk, def: 31, spa: 31, spd: 31, spe: 31 });

  it('picks the Pokémon whose IVs, ability and item the battle has, not the first with the same name, species, level and moves', () => {
    const first = playerMon(ID.monferno, 30, [ID.ember], { nickname: 'MONFERNO', ivs: ivs(31), location: { kind: 'party', slot: 1 } });
    const second = playerMon(ID.monferno, 30, [ID.ember], { nickname: 'MONFERNO', ivs: ivs(10), ability: knownAbility(55), location: { kind: 'box', box: 1, slot: 1 } });
    expect(viewOfLead([first, second], second)?.calc.mon).toBe(second);
    expect(viewOfLead([first, second], first)?.calc.mon).toBe(first);
  });

  it('gives no view when two different Pokémon fit the set', () => {
    const one = playerMon(ID.monferno, 30, [ID.ember], { nickname: 'MONFERNO' });
    const other = { ...one, baseStats: { ...one.baseStats, atk: one.baseStats.atk + 1 }, location: { kind: 'box', box: 1, slot: 2 } } as PlayerMon;
    expect(viewOfLead([one, other], one)).toBeNull();
  });
});

describe('the speed oracle', () => {
  const turn = (enemyMoves: number[]) => {
    const { before, oracles } = setup(emberTurn(enemyMoves));
    const speed = (outcome: Outcome) => oracles.speed.check({ before, choices: BOTH_FIRST, outcome });
    return { speed, outcomes: expandTurn(before, BOTH_FIRST) };
  };

  it('checks the speed order (Monferno before Zigzagoon at equal priority) and the higher priority first (Mean Look)', () => {
    const tackle = turn([ID.tackle]);
    const results = tackle.outcomes.map(tackle.speed);
    expect(results.flatMap((r) => r.mismatches)).toEqual([]);
    expect(results.reduce((sum, r) => sum + r.checks, 0)).toBeGreaterThan(0);
    const meanLook = turn([ID.meanLook]);
    expect(meanLook.speed(meanLook.outcomes[0]!)).toEqual({ checks: 1, mismatches: [] });
  });

  it('reports a move order the speeds do not give', () => {
    const { speed, outcomes } = turn([ID.tackle]);
    const outcome = outcomes.find((o) => o.log.filter((l) => l.startsWith('|move|')).length === 2)!;
    const [first, second] = outcome.log.filter((l) => l.startsWith('|move|'));
    const result = speed({ ...outcome, log: [second!, first!] });
    expect(result).toMatchObject({ checks: 1, mismatches: [expect.stringMatching(/first/)] });
  });
});
