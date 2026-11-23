// The differential fixtures' own checks (aiFixtures.ts): each recorded fixture reached the situation it is named for
// (one check per fixture, over the states and logs the run visits), the fixtures the engine refuses today are still
// refused for the reason docs/ai-fixtures.md gives, and the list holds no name twice. (The fixtures' records are compared
// with the golden file by aiDifferential.fixtures.test.ts.)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { protocolIds } from '../../src/ai/adapter.js';
import type { AiMemoryData } from '../../src/ai/memory.js';
import type { AiMemory } from '../../src/contracts/ai.js';
import type { EngineState, Outcome } from '../../src/contracts/engine.js';
import { battleField, quickClawRolls, restore } from '../../src/engine/index.js';
import { type Corpus, loadCorpus } from './aiCorpus.js';
import { FIXTURES, type Fixture, FixtureRefused, REFUSED, runFixture } from './aiFixtures.js';
import { DATA_DIR, needFiles, PK_ROM } from './env.js';

const ROM_DIR = join(DATA_DIR, 'rom');
const suite = needFiles("the trainer AI's fixtures: the situations they reach, and the ones the engine refuses", { PK_ROM }, [{
  name: 'ROM extract', dir: ROM_DIR,
  skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
    ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
}]);

/** One state a fixture's run visits. `goesOn` is the outcome the fixture continues from (its path). */
interface Row { key: string; state: EngineState; memory: AiMemory; outcome?: Outcome; goesOn?: boolean }

/** What a fixture's run visited: every state, and the log of the path the fixture follows (and of every visited outcome). */
interface Seen { rows: Row[]; path: string; all: string; root: EngineState; last: EngineState }

function visitFixture(corpus: Corpus, fixture: Fixture): Seen {
  const rows: Row[] = [];
  runFixture(corpus, fixture, new Map(), (key, state, memory, outcome, goesOn) => {
    rows.push({ key, state, memory, ...(outcome === undefined ? {} : { outcome, goesOn }) });
  });
  const text = (picked: Row[]): string => picked.flatMap((row) => row.outcome?.log ?? []).join('\n');
  const onPath = rows.filter((row) => row.goesOn === true);
  return { rows, path: text(onPath), all: text(rows), root: rows[0]!.state, last: onPath[onPath.length - 1]!.state };
}

const count = (text: string, pattern: RegExp): number => (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
const data = (row: Row): AiMemoryData => row.memory.data as AiMemoryData;
/** The turn-choice states of the path whose memory carries turn fact `fact`. */
const turnFacts = (s: Seen, fact: string): number => s.rows.filter((row) => row.state.phase.kind === 'turnChoice' && data(row).turnFight === fact).length;
const phases = (s: Seen, kind: string): number => s.rows.filter((row) => row.state.phase.kind === kind).length;
const sides = (state: EngineState): Record<'p1' | 'p2', Record<string, { layers?: number }>> => {
  const battle = restore(state);
  return { p1: battle.p1.sideConditions as never, p2: battle.p2.sideConditions as never };
};
/** The toxic counter of `side`'s active Pokémon at some visited state. */
const toxicStages = (s: Seen, side: 'p1' | 'p2'): number[] => s.rows.map((row) => {
  const active = restore(row.state)[side].active[0];
  return active?.status === 'tox' ? (active.statusState as unknown as { stage: number }).stage : 0;
});
const forcedAfter = (s: Seen, pattern: RegExp): boolean => turnFacts(s, 'forced') > 0 && pattern.test(s.path);

type Check = [what: string, holds: (s: Seen) => boolean];

/** One check per recorded fixture: the situation its name promises, in the log or the states the run visited. */
const CHECKS: Record<string, Check> = {
  'protect-chain-bag': ['Protect twice against the player, then the bag item', (s) => count(s.path, /\|-activate\|p2a: Shuckle\|Protect/) === 2 && /item: Full Restore\|\[trainer\]/.test(s.path)],
  'protect-chain-player': ['the player Protects twice', (s) => count(s.path, /\|-activate\|p1a: Garchomp\|Protect/) === 2],
  'sleeptalk-protect': ['Sleep Talk calls Protect', (s) => /Protect\|p2a: Shuckle\|\[from\] move: Sleep Talk/.test(s.path)],
  'bugbite-berry': ["Bug Bite takes the AI's berry", (s) => /-enditem\|p2a: Blissey\|Sitrus Berry\|\[from\] stealeat\|\[move\] Bug Bite/.test(s.path)],
  'imprison-works-player': ["the player's Imprison starts", (s) => /-start\|p1a: Garchomp\|move: Imprison/.test(s.path)],
  'imprison-fails-player': ["the player's Imprison fails", (s) => /Imprison\|\|\[still\]/.test(s.path) && !/-start\|p1a: Garchomp\|move: Imprison/.test(s.path)],
  'imprison-works-ai': ["the AI's Imprison starts", (s) => /-start\|p2a: Shuckle\|move: Imprison/.test(s.path)],
  'imprison-fails-ai': ["the AI's Imprison fails", (s) => /p2a: Shuckle\|Imprison\|\|\[still\]/.test(s.path) && !/-start\|p2a: Shuckle\|move: Imprison/.test(s.path)],
  'imprison-struggle': ['the imprisoned AI is forced to Struggle', (s) => /cant\|p2a: Shuckle\|move: Imprison\|Tackle/.test(s.path) && /\|move\|p2a: Shuckle\|Struggle/.test(s.path) && turnFacts(s, 'forced') > 0],
  // The engine fires an awake player's Pursuit before the U-turn user leaves, so here no Pursuit is queued at the switch:
  // the Pursuit hits the U-turn user and the AI decides at its mid-turn switch. The asleep player's Pursuit stays queued
  // (as in the U-turn unit test in test/unit/ai/model.test.ts), and the AI decides that switch too: TryPursuit's sleep test
  // rules the Pursuit out (compose.ts pursuitMayRun).
  'pursuit-hits-uturn-user': ['Pursuit hits the U-turn user and the AI decides at its mid-turn switch', (s) => /\[from\] Pursuit/.test(s.all) && phases(s, 'enemyMidTurnSwitch') > 0],
  'pursuit-queued-asleep': ["the asleep player's Pursuit is still queued when the AI decides its mid-turn switch", (s) => !/\[from\] Pursuit/.test(s.all) && s.rows.some((row) => row.state.phase.kind === 'enemyMidTurnSwitch' && restore(row.state).queue.list.some((action) => (action as { choice?: string }).choice === 'move' && (action as { pokemon?: { side?: { id?: string } } }).pokemon?.side?.id === 'p1'))],
  'field-fog': ['the fog note', (s) => battleField(s.root).fog === true && battleField(s.last).fog === true],
  'field-trickroom': ['the Trick Room note, the condition up', (s) => battleField(s.root).trickRoom === true && 'trickroom' in restore(s.root).field.pseudoWeather],
  'field-gravity': ['the Gravity note, the condition up', (s) => battleField(s.root).gravity === true && 'gravity' in restore(s.root).field.pseudoWeather],
  quickclaw: ['no roll drawn at the root, the holder\'s roll stored on turn 2', (s) => quickClawRolls(s.root).p2 === undefined && quickClawRolls(s.last).p2 !== undefined],
  'sleep-known': ['the player starts asleep (an exact counter)', (s) => restore(s.root).p1.active[0]!.status === 'slp' && /cant\|p1a: Garchomp\|slp/.test(s.path)],
  'sleep-hazard': ['the player is put to sleep by a move', (s) => restore(s.root).p1.active[0]!.status !== 'slp' && /-status\|p1a: Garchomp\|slp\|\[from\] move: Spore/.test(s.path)],
  'toxic-on-player': ['toxic on the player reaches counter 3', (s) => toxicStages(s, 'p1').includes(3)],
  'toxic-on-ai': ['toxic on the AI reaches counter 3', (s) => toxicStages(s, 'p2').includes(3)],
  'perish-song': ['Perish Song counts down to the double faint', (s) => /perish3/.test(s.path) && /perish1/.test(s.path) && /perish0/.test(s.path) && count(s.path, /\|faint\|/) === 2],
  'stockpile-2': ['Stockpile twice', (s) => count(s.path, /\|move\|p2a: Shuckle\|Stockpile/) === 2 && count(s.path, /-boost\|p2a: Shuckle\|def\|1/) === 2],
  restrictions: ['Torment, Disable and Encore on the AI, then Struggle', (s) => /-start\|p2a: Shuckle\|Torment/.test(s.path) && /-start\|p2a: Shuckle\|Disable\|Bite/.test(s.path) && /-start\|p2a: Shuckle\|Encore/.test(s.path) && forcedAfter(s, /\|move\|p2a: Shuckle\|Struggle/)],
  'encore-lock': ['the Encore lock gives forced turns', (s) => /-start\|p2a: Shuckle\|Encore/.test(s.path) && turnFacts(s, 'forced') >= 2],
  'choice-lock': ['the Choice-locked AI repeats Bite, and the turn fact stays menu', (s) => count(s.path, /\|move\|p2a: Weavile\|Bite/) === 3 && 'choicelock' in restore(s.last).p2.active[0]!.volatiles && turnFacts(s, 'forced') === 0],
  'choice-disable': ['the Choice-locked AI whose move is Disabled has to Struggle', (s) => /-start\|p2a: Shuckle\|Disable\|Bite/.test(s.path) && forcedAfter(s, /\|move\|p2a: Shuckle\|Struggle/)],
  'twoturn-ai-solarbeam': ['the AI charges SolarBeam; its next turn is forced', (s) => /-prepare\|p2a: Weavile\|SolarBeam/.test(s.path) && turnFacts(s, 'forced') > 0],
  'twoturn-player-solarbeam': ['the player charges SolarBeam', (s) => /-prepare\|p1a: Garchomp\|SolarBeam/.test(s.path)],
  'twoturn-ai-razor-wind': ['the AI charges Razor Wind; its next turn is forced', (s) => /-prepare\|p2a: Weavile\|Razor Wind/.test(s.path) && turnFacts(s, 'forced') > 0],
  'twoturn-player-razor-wind': ['the player charges Razor Wind', (s) => /-prepare\|p1a: Garchomp\|Razor Wind/.test(s.path)],
  'leechseed-ai': ['the AI seeds the player', (s) => /-start\|p1a: Garchomp\|move: Leech Seed/.test(s.path)],
  'leechseed-player': ['the player seeds the AI', (s) => /-start\|p2a: Shuckle\|move: Leech Seed/.test(s.path)],
  'attract-ai': ['the player is infatuated', (s) => /-start\|p1a: Garchomp\|Attract/.test(s.path)],
  'attract-player': ['the AI is infatuated', (s) => /-start\|p2a: Blissey\|Attract/.test(s.path)],
  'substitute-ai': ['the AI makes a Substitute and it takes a hit', (s) => /-start\|p2a: Shuckle\|Substitute/.test(s.path) && /-activate\|p2a: Shuckle\|Substitute\|\[damage\]/.test(s.path)],
  'substitute-player': ['the player makes a Substitute and it takes a hit', (s) => /-start\|p1a: Garchomp\|Substitute/.test(s.path) && /-activate\|p1a: Garchomp\|Substitute\|\[damage\]/.test(s.path)],
  'wish-ai': ["the AI's Wish", (s) => /\|move\|p2a: Blissey\|Wish/.test(s.path)],
  'wish-player': ["the player's Wish", (s) => /\|move\|p1a: Garchomp\|Wish/.test(s.path)],
  'hazards-on-ai': ['Spikes (2 layers), Toxic Spikes and Stealth Rock on the AI\'s side, and the switch-in poisoned', (s) => {
    const side = sides(s.last).p2;
    return side['spikes']?.layers === 2 && 'toxicspikes' in side && 'stealthrock' in side && /-status\|p2a: Zigzagoon\|psn/.test(s.path);
  }],
  'hazards-on-player': ["Spikes (2 layers), Toxic Spikes and Stealth Rock on the player's side, and the switch-in poisoned", (s) => {
    const side = sides(s.last).p1;
    return side['spikes']?.layers === 2 && 'toxicspikes' in side && 'stealthrock' in side && /-status\|p1a: Garchomp 2\|psn/.test(s.path);
  }],
  'tailwind-ai': ["the AI's Tailwind starts and ends", (s) => /-sidestart\|p2: [^|]*\|move: Tailwind/.test(s.path) && /-sideend\|p2: [^|]*\|move: Tailwind/.test(s.path)],
  'tailwind-player': ["the player's Tailwind starts and ends", (s) => /-sidestart\|p1: [^|]*\|move: Tailwind/.test(s.path) && /-sideend\|p1: [^|]*\|move: Tailwind/.test(s.path)],
  'weather-move-rain-dance': ['rain from a move, ticking', (s) => /-weather\|RainDance\n/.test(s.path) && /-weather\|RainDance\|\[upkeep\]/.test(s.path)],
  'weather-move-sunny-day': ['sun from a move, ticking', (s) => /-weather\|SunnyDay\n/.test(s.path) && /-weather\|SunnyDay\|\[upkeep\]/.test(s.path)],
  'weather-move-sandstorm': ['sand from a move, ticking', (s) => /-weather\|Sandstorm\n/.test(s.path) && /-weather\|Sandstorm\|\[upkeep\]/.test(s.path)],
  'weather-move-hail': ['hail from a move, ticking', (s) => /-weather\|Hail\n/.test(s.path) && /-weather\|Hail\|\[upkeep\]/.test(s.path)],
  'weather-ability-drizzle': ['rain from the AI lead\'s ability at the start', (s) => restore(s.root).field.weather === 'raindance' && /-weather\|RainDance\|\[upkeep\]/.test(s.path)],
  'weather-ability-drought': ['sun from the AI lead\'s ability at the start', (s) => restore(s.root).field.weather === 'sunnyday' && /-weather\|SunnyDay\|\[upkeep\]/.test(s.path)],
  'weather-ability-sand-stream': ['sand from the AI lead\'s ability at the start', (s) => restore(s.root).field.weather === 'sandstorm' && /-weather\|Sandstorm\|\[upkeep\]/.test(s.path)],
  'weather-ability-snow-warning': ['hail from the AI lead\'s ability at the start', (s) => restore(s.root).field.weather === 'hail' && /-weather\|Hail\|\[upkeep\]/.test(s.path)],
  'uproar-ai': ["the AI's Uproar locks it", (s) => /-start\|p2a: Shuckle\|Uproar/.test(s.path) && turnFacts(s, 'forced') > 0],
  'faint-burned': ['the AI is burned by its Flame Orb, then faints and the replacement is decided', (s) => /-status\|p2a: Weavile\|brn\|\[from\] item: Flame Orb/.test(s.path) && /\|faint\|p2a: Weavile/.test(s.path) && phases(s, 'enemyReplacement') > 0],
  'faint-asleep': ['the AI is put to sleep, then faints and the replacement is decided', (s) => /-status\|p2a: Weavile\|slp\|\[from\] move: Spore/.test(s.path) && /\|faint\|p2a: Weavile/.test(s.path) && phases(s, 'enemyReplacement') > 0],
  // aiTraced is cleared by an `-ability ... [from]` line that is not a Trace (Role Play, Worry Seed: both refused by the
  // engine), by a switch-in and by the faint's replacement; Gastro Acid suppresses the ability without changing it, so the
  // traced ability stays through the faint (the cartridge keeps it) and goes with the next switch-in.
  'trace-gastro': ['a traced ability, Gastro Acid\'d, kept through the faint, gone at the next switch-in', (s) => {
    const traced = protocolIds().ability('Rough Skin');
    const replacing = s.rows.filter((row) => row.state.phase.kind === 'enemyReplacement' && row.goesOn === true);
    const after = s.rows[s.rows.length - 1]!;
    return data(s.rows[0]!).aiTraced === traced && /-endability\|p2a: Smeargle/.test(s.path) && replacing.length === 1
      && data(replacing[0]!).aiTraced === traced && data(after).aiTraced === undefined;
  }],
  // The extras: a log line that names the situation.
  'status-thunder-wave-on-player': ['the player (not Ground) is paralysed', (s) => /-status\|p1a: Tyranitar\|par/.test(s.path)],
  'status-thunder-wave-on-ai': ['the AI is paralysed', (s) => /-status\|p2a: Shuckle\|par/.test(s.path)],
  'status-will-o-wisp-on-player': ['the player is burned', (s) => /-status\|p1a: Garchomp\|brn/.test(s.path)],
  'status-will-o-wisp-on-ai': ['the AI is burned', (s) => /-status\|p2a: Shuckle\|brn/.test(s.path)],
  'status-confuse-ray-on-player': ['the player is confused', (s) => /-start\|p1a: Garchomp\|confusion/.test(s.path)],
  'status-confuse-ray-on-ai': ['the AI is confused', (s) => /-start\|p2a: Shuckle\|confusion/.test(s.path)],
  'screens-ai': ["the AI's four side conditions", (s) => ['Reflect', 'Light Screen', 'Safeguard', 'Mist'].every((name) => new RegExp(`-sidestart\\|p2: [^|]*\\|(move: )?${name}`).test(s.path))],
  'screens-player': ["the player's four side conditions", (s) => ['Reflect', 'Light Screen', 'Safeguard', 'Mist'].every((name) => new RegExp(`-sidestart\\|p1: [^|]*\\|(move: )?${name}`).test(s.path))],
  'ingrain-ai': ['the AI ingrains', (s) => /-start\|p2a: Shuckle\|move: Ingrain/.test(s.path)],
  'magnetrise-ai': ['the AI rises on a magnet', (s) => /-start\|p2a: Shuckle\|Magnet Rise/.test(s.path)],
  'aquaring-ai': ['the AI wears an Aqua Ring', (s) => /-start\|p2a: Shuckle\|Aqua Ring/.test(s.path)],
  'embargo-player': ['the AI is embargoed', (s) => /-start\|p2a: Shuckle\|Embargo/.test(s.path)],
  'meanlook-player': ['the AI is trapped', (s) => /-activate\|p2a: Shuckle\|trapped/.test(s.path)],
  'whirlpool-ai': ['the player is bound by Whirlpool', (s) => /-activate\|p1a: Garchomp\|move: Whirlpool/.test(s.path)],
  'destinybond-ai': ['the AI sets Destiny Bond', (s) => /-singlemove\|p2a: Shuckle\|Destiny Bond/.test(s.path)],
  // The hack's Outrage has no lock (ROM effect 48: recoil, no rampage), so the AI picks it afresh each turn (turn fact menu).
  'outrage-no-lock': ['the AI uses Outrage four turns running, never locked', (s) => count(s.path, /\|move\|p2a: Shuckle\|Outrage/) === 4 && turnFacts(s, 'forced') === 0],
  'rest-ai': ['the AI Rests and sleeps', (s) => /-status\|p2a: Blissey\|slp\|\[from\] move: Rest/.test(s.path) && /cant\|p2a: Blissey\|slp/.test(s.path)],
  'batonpass-ai': ['Baton Pass leads to a mid-turn switch decision', (s) => phases(s, 'enemyMidTurnSwitch') > 0 && /\[from\] Baton Pass/.test(s.path)],
};

describe.skipIf(suite.skip)(suite.title, () => {
  it('names every fixture once', () => {
    const names = [...FIXTURES, ...REFUSED.map((entry) => entry.fixture)].map((fixture) => fixture.name);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  it('has exactly one situation check for each recorded fixture', () => {
    expect(Object.keys(CHECKS).sort()).toEqual(FIXTURES.map((fixture) => fixture.name).sort());
  });

  it('reaches the situation each recorded fixture is named for', () => {
    const corpus = loadCorpus(DATA_DIR);
    const failed: string[] = [];
    for (const fixture of FIXTURES) {
      const [what, holds] = CHECKS[fixture.name]!;
      if (!holds(visitFixture(corpus, fixture))) failed.push(`${fixture.name}: ${what}`);
    }
    expect(failed).toEqual([]);
  });

  it('still refuses each REFUSED fixture, for its stated reason (when one is modelled, move it to FIXTURES)', () => {
    const corpus = loadCorpus(DATA_DIR);
    for (const { fixture, why } of REFUSED) {
      let thrown: unknown = null;
      try {
        runFixture(corpus, fixture, new Map());
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${fixture.name} ran: the engine models it now`).toBeInstanceOf(FixtureRefused);
      expect((thrown as Error).message, fixture.name).toMatch(why);
    }
  });
});
