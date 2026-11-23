import { describe, expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import { hitChance } from '../../../src/calc/accuracy.js';
import type { CalcSide } from '../../../src/calc/calc.js';
import type { CalcField } from '../../../src/calc/field.js';
import { ABILITY, BLIZZARD, FISSURE, HURRICANE, ITEM, monferno, move, SWIFT, TACKLE, THUNDER, zigzagoon } from '../../fixtures/battleMons.js';

// The cartridge's formula (battle_controller_player.c:2865-2977 and 3001-3032): an integer hit rate out of 100,
// truncated after every step, so each expected value is a whole percentage.
type Fields = Omit<CalcSide, 'mon'>;
const a = (fields: Fields = {}, mon: Parameters<typeof monferno>[0] = {}): CalcSide => ({ mon: monferno(mon), ...fields }); // level 15
const d = (fields: Fields = {}, mon: Parameters<typeof zigzagoon>[0] = {}): CalcSide => ({ mon: zigzagoon(mon), ...fields }); // level 5
const ab = (value: number) => ({ ability: { value, source: 'rom' as const, disputed: false, alternatives: [] } });
const acc = (accuracy: number, fields: Partial<KaizoMove> = {}) => move(500, { accuracy, ...fields });
const ACC_70 = acc(70);
const [RAIN, SUN, SAND, HAIL, FOG] = [{ weather: 'rain' }, { weather: 'sun' }, { weather: 'sand' }, { weather: 'hail' }, { fog: true }] as const;
const { AIR_LOCK, CLOUD_NINE, COMPOUND_EYES, HUSTLE, KLUTZ, MOLD_BREAKER, NO_GUARD, SAND_VEIL, SIMPLE, SNOW_CLOAK, STURDY, TANGLED_FEET, UNAWARE } = ABILITY;
type Row = [name: string, attacker: CalcSide, defender: CalcSide, used: KaizoMove, field: CalcField, chance: number, opts?: { defenderMoved?: boolean }];

describe('hitChance', () => {
  it.each<Row>([
    ['accuracy 0 always hits', a(), d(), SWIFT, {}, 1],
    ['accuracy 0 always hits, whatever the stages', a({ boosts: { accuracy: -6 } }), d({ boosts: { evasion: 6 } }), SWIFT, SAND, 1],
    ['a plain 100% move', a(), d(), TACKLE, {}, 1],
    ['a plain 70% move', a(), d(), ACC_70, {}, 0.7],
    ['Thunder always hits in rain', a(), d(), THUNDER, RAIN, 1],
    ['Thunder always hits in rain, even at -6', a({ boosts: { accuracy: -6 } }), d(), THUNDER, RAIN, 1],
    ['Thunder drops to 50 in sun', a(), d(), THUNDER, SUN, 0.5],
    ['Thunder with no weather', a(), d(), THUNDER, {}, 0.7],
    ['Cloud Nine on the attacker cancels the weather rules', a({}, ab(CLOUD_NINE)), d(), THUNDER, RAIN, 0.7],
    ['Air Lock on the defender cancels the weather rules', a(), d({}, ab(AIR_LOCK)), THUNDER, SUN, 0.7],
    ['Blizzard always hits in hail', a(), d(), BLIZZARD, HAIL, 1],
    ['Blizzard in rain', a(), d(), BLIZZARD, RAIN, 0.7],
    // The hack's overlay 16 gives Hurricane's ROM effect (141, unused in vanilla) exactly Thunder's checks.
    ['Hurricane always hits in rain', a(), d(), HURRICANE, RAIN, 1],
    ['Hurricane drops to 50 in sun', a(), d(), HURRICANE, SUN, 0.5],
    ['Hurricane with no weather', a(), d(), HURRICANE, {}, 0.7],
    ['Hurricane in sun under Cloud Nine', a({}, ab(CLOUD_NINE)), d(), HURRICANE, SUN, 0.7],
    ['the rain rule keys on the ROM effect, not the docs text', a(), d(), acc(70, { effectText: 'Always hits in rain' }), RAIN, 0.7],
    ['the hail rule keys on the ROM effect, not the docs text', a(), d(), acc(70, { effectText: 'Always hits in Hail' }), HAIL, 0.7],
    ['Compound Eyes gives x1.3', a({}, ab(COMPOUND_EYES)), d(), ACC_70, {}, 0.91],
    ['Compound Eyes is capped at 1', a({}, ab(COMPOUND_EYES)), d(), acc(80), {}, 1],
    ['-1 accuracy gives x3/4', a({ boosts: { accuracy: -1 } }), d(), TACKLE, {}, 0.75],
    ['+1 evasion gives x3/4', a(), d({ boosts: { evasion: 1 } }), TACKLE, {}, 0.75],
    ['-1 accuracy truncates 52.5 to 52, not Showdown\'s 0.525', a({ boosts: { accuracy: -1 } }), d(), ACC_70, {}, 0.52],
    ['-6 accuracy is the cartridge table\'s 33/100, not 1/3', a({ boosts: { accuracy: -6 } }), d(), TACKLE, {}, 0.33],
    ['+6 evasion', a(), d({ boosts: { evasion: 6 } }), TACKLE, {}, 0.33],
    ['-6 accuracy with +6 evasion is clamped to the table', a({ boosts: { accuracy: -6 } }), d({ boosts: { evasion: 6 } }), TACKLE, {}, 0.33],
    ['+1 accuracy is 133/100 (Showdown\'s 4/3 gives 93.3)', a({ boosts: { accuracy: 1 } }), d(), ACC_70, {}, 0.93],
    // Where truncation tells the cartridge table from Showdown's fractions (1/3 gives 30, 3/8 37, 3/7 42, 5/3 100).
    ...([[90, -6, 0.29], [100, -5, 0.36], [100, -4, 0.43], [60, 2, 0.99], [70, 5, 1]] as const).map(([accuracy, stage, chance]): Row =>
      [`${accuracy}% at ${stage} accuracy`, a({ boosts: { accuracy: stage } }), d(), acc(accuracy), {}, chance]),
    ['No Guard on the attacker, even at -6', a({ boosts: { accuracy: -6 } }, ab(NO_GUARD)), d(), ACC_70, {}, 1],
    ['No Guard on the defender', a(), d({}, ab(NO_GUARD)), ACC_70, SAND, 1],
    // The hack ROM's item data gives BrightPowder 11 (vanilla 10).
    ['BrightPowder gives the hack\'s x0.89', a(), d({}, { item: ITEM.BRIGHT_POWDER }), TACKLE, {}, 0.89],
    ['Lax Incense gives x0.89', a(), d({}, { item: ITEM.LAX_INCENSE }), TACKLE, {}, 0.89],
    ['Klutz cancels a held item', a(), d({}, { item: ITEM.BRIGHT_POWDER, ...ab(KLUTZ) }), TACKLE, {}, 1],
    ['Wide Lens gives x1.1', a({}, { item: ITEM.WIDE_LENS }), d(), ACC_70, {}, 0.77],
    ['Zoom Lens does nothing before the target moves', a({}, { item: ITEM.ZOOM_LENS }), d(), ACC_70, {}, 0.7],
    ['Zoom Lens gives x1.2 once the target has moved', a({}, { item: ITEM.ZOOM_LENS }), d(), ACC_70, {}, 0.84, { defenderMoved: true }],
    ['fog gives x6/10', a(), d(), TACKLE, FOG, 0.6],
    ['Gravity gives x10/6', a(), d(), acc(50), { gravity: true }, 0.83],
    ['Gravity is capped at 1', a(), d(), acc(60), { gravity: true }, 1],
    ['Cloud Nine cancels fog, in the cartridge\'s weather block', a({}, ab(CLOUD_NINE)), d(), TACKLE, FOG, 1],
    ['Sand Veil gives x0.8 in sand', a(), d({}, ab(SAND_VEIL)), TACKLE, SAND, 0.8],
    ['Sand Veil does nothing out of sand', a(), d({}, ab(SAND_VEIL)), TACKLE, {}, 1],
    ['Mold Breaker ignores Sand Veil', a({}, ab(MOLD_BREAKER)), d({}, ab(SAND_VEIL)), TACKLE, SAND, 1],
    ['Snow Cloak gives x0.8 in hail', a(), d({}, ab(SNOW_CLOAK)), TACKLE, HAIL, 0.8],
    ['Hustle gives x0.8 to a physical move', a({}, ab(HUSTLE)), d(), TACKLE, {}, 0.8],
    ['Hustle leaves a special move alone', a({}, ab(HUSTLE)), d(), acc(100, { category: 'special' }), {}, 1],
    ['Tangled Feet halves against a confused target', a(), d({ confused: true }, ab(TANGLED_FEET)), TACKLE, {}, 0.5],
    ['Tangled Feet does nothing unconfused', a(), d({}, ab(TANGLED_FEET)), TACKLE, {}, 1],
    ['Simple doubles the stages', a({ boosts: { accuracy: -1 } }, ab(SIMPLE)), d(), TACKLE, {}, 0.6],
    ['Unaware on the defender ignores accuracy stages', a({ boosts: { accuracy: 1 } }), d({}, ab(UNAWARE)), ACC_70, {}, 0.7],
    ['Unaware on the attacker ignores evasion stages', a({}, ab(UNAWARE)), d({ boosts: { evasion: 1 } }), ACC_70, {}, 0.7],
    // battle_controller_player.c:2888-2890.
    ['Foresight drops raised evasion', a(), d({ boosts: { evasion: 2 }, foresight: true }), ACC_70, {}, 0.7],
    ['Foresight keeps lowered evasion', a(), d({ boosts: { evasion: -1 }, foresight: true }), ACC_70, {}, 0.93],
    ['Foresight keeps the attacker\'s own stages', a({ boosts: { accuracy: -1 } }), d({ boosts: { evasion: 2 }, foresight: true }), TACKLE, {}, 0.75],
    // 70, Compound Eyes 91, fog 54, BrightPowder 48, Wide Lens 52; floating point would give 53.45.
    ['the modifiers in the cartridge\'s order, truncating after each', a({}, { item: ITEM.WIDE_LENS, ...ab(COMPOUND_EYES) }), d({}, { item: ITEM.BRIGHT_POWDER }), ACC_70, FOG, 0.52],
    // An OHKO move hits at its accuracy plus the level difference (BtlCmd_TryOHKOMove, battle_script.c:4334-4383).
    ['an OHKO move: 30 plus 10 levels', a(), d(), FISSURE, {}, 0.4],
    ['an OHKO move ignores stages and fog', a({ boosts: { accuracy: -6 } }), d(), FISSURE, FOG, 0.4],
    ['an OHKO move at an equal level', a(), d({}, { level: 15 }), FISSURE, {}, 0.3],
    ['an OHKO move on a higher level', d(), a(), FISSURE, {}, 0],
    ['an OHKO move on Sturdy', a(), d({}, ab(STURDY)), FISSURE, {}, 0],
    ['an OHKO move with No Guard', a({}, ab(NO_GUARD)), d(), FISSURE, {}, 1],
    ['an OHKO move with No Guard on a higher level', d({}, ab(NO_GUARD)), a(), FISSURE, {}, 0],
  ])('%s', (_, attacker, defender, used, field, chance, opts) => expect(hitChance(attacker, defender, used, field, opts)).toBe(chance));
});
