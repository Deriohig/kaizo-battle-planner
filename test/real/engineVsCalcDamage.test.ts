// Real-data sweep: the engine's damage, `damage()` and `gen4Damage` agree on real Pokémon. Every
// eligible Pokémon of the player's save (the frozen 12 June copy) against every enemy of the first 40 single-battle trainers in game
// order, every damaging move both ways, as a plain hit and as a critical hit, 16 rolls each.
//
// - The engine's rolls are `getDamage`'s own, enumerated through a chance driver (every crit and roll pick, no turn around
//   them), on the battle `createBattle` makes for the pair: so the stats, the boosts an Intimidate left, the weather a weather
//   ability set and the trainer's field note are the engine's, and the calc sides are built from that state.
// - `gen4Damage` is the reference (written from the decompilation alone); `damage()` runs through it, but keeps Smogon's zero
//   for an immunity Smogon finds, so the comparison with it is for the moves that deal damage.
// - A disagreement fails the test unless `accepted-engine-diffs.json` lists it, by key `<attacker> <move> <defender>` with the
//   reason. A moves `gen4Damage` does not derive (power from weight, speed, PP or the hit number) is counted, not compared.
// - A move its own `Try` handler stops (Endeavor when its user has at least the target's HP) deals nothing, as gen4Damage's 0
//   says: `engineRolls` runs that handler, as `trySpreadMoveHit` does before the hit.
//
// Set SWEEP_TRAINERS to run the first N trainers only (a quick look); the committed run is all 40.

import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import { buildCatalog } from '../../src/battle/catalog.js';
import { buildMoves, type KaizoMove } from '../../src/battle/moves.js';
import { eligibleTeam, type PlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData, ResolvedMon } from '../../src/battle/types.js';
import { type CalcField, type CalcSide, damage } from '../../src/calc/calc.js';
import { Gen4DamageUnsupported, gen4Damage } from '../../src/calc/gen4Damage.js';
import { loadDocs } from '../../src/data/load.js';
import { attachDriver, ChanceDriver, nextScript } from '../../src/engine/chance.js';
import { createBattle, restoreShared, sharedState } from '../../src/engine/battle.js';
import { abilityId, installKaizoDex, moveId } from '../../src/engine/dex.js';
import { fieldSpec } from '../../src/integration/resolver.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { extractRomData } from '../../src/rom/extract.js';
import { DEFAULT_GRAVEYARD_BOXES, readSave } from '../../src/save/readSave.js';
import { DATA_DIR, needFiles, PK_ROM, PK_SAVE } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('The engine, damage() and gen4Damage on real Pokémon', { PK_ROM, PK_SAVE }, [caches.docs]);

const TRAINERS = Number(process.env['SWEEP_TRAINERS'] ?? 40);
void DATA_DIR;

type Rolls = number[];

/**
 * `getDamage`'s 16 rolls for `moveRom` from the player's (`p1`) or the trainer's (`p2`) Pokémon, plain and critical, by
 * enumerating its picks. null where the hit deals nothing (`getDamage` returned false or undefined) or cannot crit.
 * `stopped` is whether the move's own `Try` handler stops it first, as `trySpreadMoveHit` runs it before any hit step
 * (sim/battle-actions.ts): Endeavor fails there when its user has at least the target's HP (the gen4 mod's `onTry`, the
 * cartridge's effect_script_0189.s:5-7 and :14, `MOVE_STATUS_FAILED` when the target's HP <= the user's), and `getDamage`
 * alone would return the negative difference.
 */
function engineRolls(battle: Battle, shared: ReturnType<typeof sharedState>, from: 'p1' | 'p2', move: KaizoMove, restoreEachLeaf: boolean): { plain: Rolls | null; crit: Rolls | null; stopped: boolean } {
  const maps = { plain: new Map<number, number>(), crit: new Map<number, number>() };
  let stopped = false;
  let live = battle;
  let script: number[] | null = [];
  while (script !== null) {
    const driver: ChanceDriver = new ChanceDriver(script, { collapse: false });
    if (restoreEachLeaf) live = restoreShared(shared, driver);
    else attachDriver(live, driver);
    const [source, target] = from === 'p1' ? [live.p1.active[0]!, live.p2.active[0]!] : [live.p2.active[0]!, live.p1.active[0]!];
    const active = live.dex.getActiveMove(moveId(move));
    // useMove runs these before the damage: Hidden Power, Weather Ball and Normalize set the type there.
    live.singleEvent('ModifyType', active, null, source, target, active, active);
    live.runEvent('ModifyType', source, target, active, active);
    live.singleEvent('ModifyMove', active, null, source, target, active, active);
    live.runEvent('ModifyMove', source, target, active, active);
    live.activeMove = active;
    live.activePokemon = source;
    live.activeTarget = target;
    if (!live.singleEvent('Try', active, null, source, target, active)) stopped = true;
    const dealt = live.actions.getDamage(source, target, active);
    const crit = !!target.getMoveHitData(active).crit;
    const rollPoint = driver.points.find((point) => point.kind === 'roll');
    const count = rollPoint === undefined ? 16 : Number(rollPoint.options[rollPoint.chosen]!.weight / 4096n);
    const value = typeof dealt === 'number' ? dealt : 0;
    const map = crit ? maps.crit : maps.plain;
    map.set(value, (map.get(value) ?? 0) + count);
    script = nextScript(driver.points);
  }
  const expand = (map: Map<number, number>): Rolls | null => {
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    if (total !== 16) throw new Error(`${move.name}: ${total} rolls of 16`);
    return [...map].sort((a, b) => a[0] - b[0]).flatMap(([value, count]) => Array<number>(count).fill(value));
  };
  return { plain: expand(maps.plain), crit: expand(maps.crit), stopped };
}

/** The ROM ability number of Showdown ability `id` (Trace has copied one by now). */
function romAbility(id: string, fallback: number): number {
  for (let n = 0; n <= 123; n++) if (abilityId(n) === id) return n;
  return fallback;
}

function sideOf(mon: PlayerMon | ResolvedMon, pokemon: Pokemon): CalcSide {
  const current = { ...mon, ability: { ...mon.ability, value: romAbility(pokemon.ability, mon.ability.value) } };
  const boosts: NonNullable<CalcSide['boosts']> = { atk: pokemon.boosts.atk, def: pokemon.boosts.def, spa: pokemon.boosts.spa, spd: pokemon.boosts.spd, spe: pokemon.boosts.spe };
  return { mon: current, boosts, curHp: pokemon.hp, abilityOn: !!pokemon.abilityState['counter'] };
}

const WEATHERS: Record<string, NonNullable<CalcField['weather']>> = { raindance: 'rain', sunnyday: 'sun', sandstorm: 'sand', hail: 'hail' };

function fieldOf(battle: Battle): CalcField {
  const field: CalcField = {};
  const weather = battle.field.effectiveWeather();
  if (weather !== '' && WEATHERS[weather] !== undefined) field.weather = WEATHERS[weather]!;
  if (battle.field.getPseudoWeather('gravity')) field.gravity = true;
  return field;
}

describe.skipIf(suite.skip)(suite.title, () => {
  it('the engine\'s rolls, damage()\'s and gen4Damage\'s are equal on every pair, apart from the accepted differences', () => {
    const docs = loadDocs(caches.docs.dir);
    const rom = extractRomData(readFileSync(PK_ROM));
    const data: LoadedData = { rom, names: buildNameIndex(docs), docs };
    const moves = buildMoves(data);
    installKaizoDex(data, moves);
    const save = readSave(readFileSync(PK_SAVE), rom);
    const team = eligibleTeam(save, data, { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: 100 });
    const trainers = buildCatalog(data).trainers.filter((trainer) => trainer.battleType === 'single').slice(0, TRAINERS);

    const diffs: Record<string, string> = {};
    const stats = { pairs: 0, comparisons: 0, unsupported: 0, noDamage: 0, engineErrors: 0, trainers: trainers.length, team: team.length };
    const note = (key: string, reason: string) => { diffs[key] ??= reason; };

    for (const trainer of trainers) {
      for (const enemy of trainer.party) {
        for (const mon of team) {
          let battle: Battle;
          let shared: ReturnType<typeof sharedState>;
          try {
            const state = createBattle({ player: [mon], trainer: { ...trainer, party: [enemy], variants: [] }, field: fieldSpec(trainer.field) });
            shared = sharedState(state);
            battle = restoreShared(shared, new ChanceDriver([]));
          } catch (error) {
            stats.engineErrors++;
            note(`${mon.name} vs ${enemy.name} (${trainer.name})`, `engine could not start: ${(error as Error).message.slice(0, 80)}`);
            continue;
          }
          stats.pairs++;
          const field = fieldOf(battle);
          const mine = sideOf(mon, battle.p1.active[0]!);
          const theirs = sideOf(enemy, battle.p2.active[0]!);
          for (const from of ['p1', 'p2'] as const) {
            const [attacker, defender, attackerMon, defenderMon] = from === 'p1' ? [mine, theirs, mon, enemy] : [theirs, mine, enemy, mon];
            const target = from === 'p1' ? battle.p2.active[0]! : battle.p1.active[0]!;
            const berry = /berry$/.test(target.item);
            for (const romId of new Set(attackerMon.moves)) {
              const move = moves.get(romId);
              if (move === undefined || move.category === 'status' || move.power === 0) continue;
              const key = `${attackerMon.name} ${move.name} ${defenderMon.name}`;
              let reference: { plain: number[]; crit: number[] };
              try {
                reference = { plain: gen4Damage(attacker, defender, move, field, false), crit: gen4Damage(attacker, defender, move, field, true) };
              } catch (error) {
                if (error instanceof Gen4DamageUnsupported) { stats.unsupported++; continue; }
                throw error;
              }
              if (move.calc.fixedDamage !== undefined) reference.crit = reference.plain;
              let engine: ReturnType<typeof engineRolls>;
              try {
                engine = engineRolls(battle, shared, from, move, berry);
              } catch (error) {
                stats.engineErrors++;
                note(key, `engine threw: ${(error as Error).message.slice(0, 80)}`);
                continue;
              }
              const fixed = move.calc.fixedDamage !== undefined;
              // Battle Armor and Shell Armor (75) stop a crit: the engine rolls none, damage() gives the plain hit.
              const armoured = [4, 75].includes(defender.mon.ability.value) && attacker.mon.ability.value !== 104;
              const result = damage(attacker, defender, move, field, {});
              const critResult = damage(attacker, defender, move, field, { crit: true });
              const same = (a: number[] | null, b: number[]) => a !== null && a.length === 16 && a.every((value, i) => value === b[i]);
              stats.comparisons++;
              // A move its own `Try` stops deals nothing, which only gen4Damage's 0 agrees with (its Endeavor at the user's HP or
              // more). Where gen4Damage deals damage the hit is still compared: the other `Try` handlers read turn state this
              // sweep does not build (Sucker Punch the target's queued move, Snore sleep, Last Resort the used moves).
              if (reference.plain.every((value) => value === 0) && (engine.plain === null || engine.stopped)) { stats.noDamage++; continue; }
              // Endeavor's `Try` reads only the two HPs, which the sweep has: a stop where gen4Damage deals damage is a disagreement.
              if (engine.stopped && move.calc.fixedDamage === 'endeavor') note(key, `engine: Endeavor failed vs ${JSON.stringify(reference.plain)}`);
              if (!same(engine.plain, reference.plain)) note(key, `engine plain ${JSON.stringify(engine.plain)} vs ${JSON.stringify(reference.plain)}`);
              else if (!fixed && !armoured && engine.crit !== null && !same(engine.crit, reference.crit)) note(key, `engine crit ${JSON.stringify(engine.crit)} vs ${JSON.stringify(reference.crit)}`);
              if (result !== null && result.max > 0 && !same(result.rolls, reference.plain)) note(key, 'damage() plain');
              if (critResult !== null && critResult.max > 0 && !fixed && !armoured && !same(critResult.critRolls, reference.crit)) note(key, 'damage() crit');
            }
          }
        }
      }
    }
    console.log(`engineVsCalcDamage: ${JSON.stringify(stats)}; ${Object.keys(diffs).length} disagreements`);
    if (process.env['SWEEP_LIST'] !== undefined) console.log(Object.entries(diffs).map(([key, why]) => `DIFF ${key}: ${why}`).join('\n'));
    expect(stats.comparisons).toBeGreaterThan(process.env['SWEEP_TRAINERS'] === undefined ? 8_000 : 10);
    expect(diffs).toEqual(process.env['SWEEP_TRAINERS'] === undefined ? acceptedDiffs() : diffs);
  });
});

/** The accepted differences (test/real/accepted-engine-diffs.json): key → why the engine, damage() and gen4Damage differ there. */
function acceptedDiffs(): Record<string, string> {
  return (JSON.parse(readFileSync(new URL('./accepted-engine-diffs.json', import.meta.url), 'utf8')) as { diffs: Record<string, string> }).diffs;
}
