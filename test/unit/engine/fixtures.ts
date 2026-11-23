// The engine tests' shared data: a small `LoadedData` with ROM species and moves, the docs rows that name them, and
// `buildMoves` over it. Every value is the hack's own (ROM and docs) unless its comment says the fixture invents it.
// Add species, moves and trainers here; never change a value another test relies on.

import { calculate, Generations, Move as CalcMove, Pokemon as CalcPokemon } from '@smogon/calc';
import { buildMoves, type KaizoMove } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { LoadedData, ResolvedMon, ResolvedTrainer } from '../../../src/battle/types.js';
import type { BattleInput } from '../../../src/contracts/engine.js';
import type { DocMove } from '../../../src/docs/types.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { computeStats } from '../../../src/rom/stats.js';
import type { RomTrainer } from '../../../src/rom/trainers.js';
import type { MoveRecord, SpeciesRecord, Stats } from '../../../src/rom/types.js';
import { docSpecies, loadedData, romSpecies, romTrainer, stats } from '../../fixtures/loadedData.js';

/** ROM Personal rows. Types and abilities are ROM IDs. */
const SPECIES: readonly SpeciesRecord[] = [
  romSpecies(263, { baseStats: stats(38, 30, 41, 30, 41, 60), types: [0, 0], abilities: [82, 82] }), // Zigzagoon: Normal, Gluttony
  // Monferno: Fire/Fighting, Blaze.
  romSpecies(391, { baseStats: stats(64, 78, 52, 78, 52, 81), types: [10, 1], abilities: [66, 66], genderRatio: 31, growthRate: 3 }),
  // Castform: the hack raises Def, SpA, SpD and Spe (vanilla has 70 in every stat). Normal, Forecast.
  romSpecies(351, { baseStats: stats(70, 70, 75, 110, 75, 100), types: [0, 0], abilities: [59, 0] }),
  // Deoxys and its Attack form's own row (496). Psychic, Magic Guard (vanilla: Pressure).
  romSpecies(386, { baseStats: stats(90, 150, 70, 150, 70, 150), types: [14, 14], abilities: [98, 0], genderRatio: 255, growthRate: 5 }),
  romSpecies(496, { baseStats: stats(90, 200, 20, 200, 20, 150), types: [14, 14], abilities: [98, 0], genderRatio: 255, growthRate: 5 }),
  // Bidoof, invented: the hack keeps vanilla Bidoof (59/45/40/35/40/31, Normal, Simple/Unaware); the fixture makes it a
  // Water/Dragon type with Swift Swim and Levitate, so every patched field differs from vanilla.
  romSpecies(399, { baseStats: stats(101, 102, 103, 104, 105, 106), types: [11, 16], abilities: [33, 26] }),
  // Pikachu: the hack's own row (Electric; ability 120).
  romSpecies(25, { baseStats: stats(35, 55, 30, 50, 40, 90), types: [13, 13], abilities: [120, 0] }),
  // Giratina and its Origin form's own row (501), the hack's: Ghost/Dragon, Pressure (Origin: Levitate).
  romSpecies(487, { baseStats: stats(150, 100, 120, 100, 120, 90), types: [7, 16], abilities: [46, 0], genderRatio: 255, growthRate: 5 }),
  romSpecies(501, { baseStats: stats(150, 120, 100, 120, 100, 90), types: [7, 16], abilities: [26, 0], genderRatio: 255, growthRate: 5 }),
  // Shedinja, the hack's: Bug/Ghost, Wonder Guard.
  romSpecies(292, { baseStats: stats(1, 100, 5, 100, 10, 80), types: [6, 7], abilities: [25, 0], genderRatio: 255, growthRate: 1 }),
  // Charmander (Fire, weak to Rock) and Machop (Fighting, resists it), the hack's rows.
  romSpecies(4, { baseStats: stats(39, 52, 43, 60, 50, 65), types: [10, 10], abilities: [66, 66], genderRatio: 31, growthRate: 3 }),
  romSpecies(66, { baseStats: stats(70, 75, 50, 35, 35, 35), types: [1, 1], abilities: [99, 99], genderRatio: 63, growthRate: 3 }),
  // Magikarp (Water, Swift Swim; 10.0 kg, exactly a Low Kick weight bound) and Shaymin with its Sky Forme's
  // own row (502: Grass/Flying, Serene Grace), the hack's rows. The weights are the ROM's Pokédex weights (dex.ts).
  romSpecies(129, { baseStats: stats(20, 10, 55, 15, 20, 80), types: [11, 11], abilities: [33, 0], genderRatio: 127, growthRate: 5 }),
  romSpecies(492, { baseStats: stats(100, 100, 100, 100, 100, 100), types: [12, 12], abilities: [30, 0], genderRatio: 255, growthRate: 3 }),
  romSpecies(502, { baseStats: stats(100, 103, 75, 120, 75, 127), types: [12, 2], abilities: [32, 0], genderRatio: 255, growthRate: 3 }),
  // For the damage order: the hack's rows: dual types for the type-chart order tests.
  romSpecies(442, { baseStats: stats(50, 92, 108, 92, 108, 35), types: [7, 17], abilities: [46, 0], genderRatio: 127, growthRate: 3 }), // Spiritomb: Ghost/Dark
  romSpecies(94, { baseStats: stats(60, 65, 60, 130, 75, 110), types: [7, 3], abilities: [26, 0], genderRatio: 127, growthRate: 3 }), // Gengar: Ghost/Poison
  romSpecies(6, { baseStats: stats(78, 84, 78, 109, 85, 100), types: [10, 2], abilities: [66, 0], genderRatio: 31, growthRate: 3 }), // Charizard: Fire/Flying
  romSpecies(357, { baseStats: stats(99, 68, 83, 72, 87, 51), types: [12, 2], abilities: [34, 0], genderRatio: 127, growthRate: 5 }), // Tropius: Grass/Flying
];

const DOC_SPECIES = [
  docSpecies(263, 'ZIGZAGOON'), docSpecies(351, 'CASTFORM'), docSpecies(386, 'DEOXYS'), docSpecies(391, 'MONFERNO'),
  docSpecies(399, 'BIDOOF'), docSpecies(496, 'Deoxys (A)'), docSpecies(25, 'PIKACHU'),
  docSpecies(487, 'GIRATINA'), docSpecies(501, 'Giratina (O)'), docSpecies(292, 'SHEDINJA'),
  docSpecies(4, 'CHARMANDER'), docSpecies(66, 'MACHOP'),
  docSpecies(129, 'MAGIKARP'), docSpecies(492, 'SHAYMIN'), docSpecies(502, 'Shaymin (S)'),
  docSpecies(442, 'SPIRITOMB'), docSpecies(94, 'GENGAR'), docSpecies(6, 'CHARIZARD'), docSpecies(357, 'TROPIUS'),
];

/** ROM moves, each with its docs row: the docs' name and effect text (the row's other cells, which nothing reads, copy the ROM). */
const MOVES: readonly [MoveRecord, DocMove][] = [
  move({ id: 4, effect: 0, category: 'special', power: 100, type: 11, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 114 }, 'Water Ball', 'None'),
  move({ id: 30, effect: 0, category: 'special', power: 100, type: 10, accuracy: 100, pp: 25, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Fire Ball', 'None'), // Showdown's aliases send "fireball" to G-Max Fireball
  move({ id: 33, effect: 0, category: 'physical', power: 35, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Tackle', 'None'),
  move({ id: 52, effect: 4, category: 'special', power: 40, type: 10, accuracy: 100, pp: 25, effectChance: 10, target: 0, priority: 0, flags: 82 }, 'Ember', 'Chance to Burn'),
  move({ id: 59, effect: 260, category: 'special', power: 120, type: 15, accuracy: 70, pp: 5, effectChance: 20, target: 4, priority: 0, flags: 146 }, 'Blizzard', 'Always hits in Hail'), // freezes 20% of the time; Showdown's Gen 4 Blizzard 10%
  move({ id: 73, effect: 84, category: 'status', power: 0, type: 12, accuracy: 0, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Leech Seed', 'Leech Seed effect'), // never misses; Showdown's Gen 4 Leech Seed has 90 accuracy
  move({ id: 76, effect: 151, category: 'special', power: 120, type: 12, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'SolarBeam', 'Charging turn unless in Harsh Sunlight'),
  move({ id: 130, effect: 0, category: 'special', power: 120, type: 12, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Solar-Beam', 'None'), // the same Showdown ID as SolarBeam (76)
  move({ id: 132, effect: 0, category: 'special', power: 255, type: 14, accuracy: 100, pp: 15, effectChance: 0, target: 4, priority: -1, flags: 18 }, 'Constrict', 'None'), // no effect chance; Showdown's Constrict lowers Speed 10% of the time
  move({ id: 212, effect: 106, category: 'status', power: 0, type: 0, accuracy: 0, pp: 5, effectChance: 0, target: 0, priority: 1, flags: 22 }, 'Mean Look', 'Prevents target from switching out or fleeing'),
  move({ id: 369, effect: 228, category: 'physical', power: 80, type: 6, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'U-turn', 'Switches user out after dealing damage'),
  // Invented: vanilla Guillotine's numbers, for a move whose `unmodelled` is set (the calc has no OHKO).
  move({ id: 12, effect: 38, category: 'physical', power: 1, type: 0, accuracy: 30, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 19 }, 'Guillotine', 'OHKO'),
  // Invented: vanilla Beat Up's numbers. Showdown's Gen 4 Beat Up logs each hitter by bare name.
  move({ id: 251, effect: 154, category: 'physical', power: 10, type: 17, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 18 }, 'Beat Up', 'Beat Up effect'),
  // The hack's own, for the labelled chance sites.
  move({ id: 25, effect: 0, category: 'physical', power: 140, type: 0, accuracy: 90, pp: 8, effectChance: 0, target: 0, priority: 0, flags: 179 }, 'Mega Kick', 'None'), // a plain 90-accuracy hit
  move({ id: 31, effect: 29, category: 'physical', power: 15, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Fury Attack', 'Hits target 2-5 times'),
  move({ id: 87, effect: 152, category: 'special', power: 120, type: 13, accuracy: 70, pp: 10, effectChance: 30, target: 0, priority: 0, flags: 146 }, 'Thunder', 'Always hits in rain; chance to Paralyze'),
  move({ id: 140, effect: 141, category: 'special', power: 120, type: 2, accuracy: 70, pp: 8, effectChance: 30, target: 0, priority: 0, flags: 50 }, 'Hurricane', 'Always hits in rain; chance to Confuse'), // Barrage's slot; the docs give a 10% chance, the ROM 30
  move({ id: 163, effect: 43, category: 'physical', power: 70, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Slash', 'High crit ratio'),
  // The hack's own.
  move({ id: 248, effect: 148, category: 'special', power: 120, type: 14, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 0 }, 'Future Sight', 'Future Sight effect'),
  move({ id: 282, effect: 188, category: 'physical', power: 80, type: 17, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 19 }, 'Knock Off', 'Renders the target\'s held item unusable'),
  // The hack's own (ROM effect 0, a plain hit at 121).
  move({ id: 216, effect: 0, category: 'physical', power: 121, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Return', 'None'),
  move({ id: 218, effect: 0, category: 'physical', power: 121, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Frustration', 'None'),
  // Invented: Return's numbers under a name no Showdown move has, so it runs as a neutral plain hit (no callbacks). Its
  // ID is no ROM move's.
  move({ id: 999, effect: 0, category: 'physical', power: 121, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Hit', 'None'),
  // The hack's own, for the counters, durations and the remaining chance sites.
  move({ id: 147, effect: 1, category: 'status', power: 0, type: 12, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Spore', 'Causes Sleep'),
  move({ id: 214, effect: 97, category: 'status', power: 0, type: 0, accuracy: 0, pp: 20, effectChance: 0, target: 1, priority: 1, flags: 0 }, 'Sleep Talk', 'Sleep Talk effect'),
  move({ id: 156, effect: 37, category: 'status', power: 0, type: 14, accuracy: 0, pp: 3, effectChance: 0, target: 16, priority: 0, flags: 72 }, 'Rest', 'Causes Sleep and restores all HP'),
  move({ id: 172, effect: 125, category: 'physical', power: 70, type: 10, accuracy: 100, pp: 25, effectChance: 10, target: 0, priority: 0, flags: 19 }, 'Flame Wheel', 'Thaws user; chance to Burn'),
  move({ id: 109, effect: 49, category: 'status', power: 0, type: 7, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Confuse Ray', 'Guaranteed Confusion (Status)'),
  move({ id: 86, effect: 67, category: 'status', power: 0, type: 13, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Thunder Wave', 'Guaranteed Paralysis'),
  move({ id: 213, effect: 120, category: 'status', power: 0, type: 0, accuracy: 100, pp: 15, effectChance: 0, target: 4, priority: 0, flags: 22 }, 'Attract', 'Infatuates target of opposite gender'),
  move({ id: 50, effect: 86, category: 'status', power: 0, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Disable', 'Disables last move used for 4-7 turns'),
  move({ id: 227, effect: 90, category: 'status', power: 0, type: 0, accuracy: 100, pp: 3, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Encore', 'Locks target into last move used for 3-7 turns'),
  move({ id: 253, effect: 159, category: 'special', power: 50, type: 0, accuracy: 100, pp: 10, effectChance: 0, target: 2, priority: 0, flags: 50 }, 'Uproar', 'Uproar effect'),
  move({ id: 35, effect: 261, category: 'physical', power: 15, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Wrap', 'Whirlpool effect'),
  move({ id: 182, effect: 111, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 3, flags: 0 }, 'Protect', 'Protect/ Detect effect'),
  move({ id: 203, effect: 116, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 3, flags: 64 }, 'Endure', 'Allows user to endure a fatal hit and survive at 1 HP'),
  move({ id: 118, effect: 83, category: 'status', power: 0, type: 0, accuracy: 0, pp: 40, effectChance: 0, target: 1, priority: 0, flags: 64 }, 'Metronome', 'Metronome effect'),
  move({ id: 217, effect: 122, category: 'physical', power: 1, type: 0, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 18 }, 'Present', 'Present Effect'),
  move({ id: 46, effect: 28, category: 'status', power: 0, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: -6, flags: 82 }, 'Roar', 'Whirlwind/ Roar effect'),
  move({ id: 18, effect: 28, category: 'status', power: 0, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: -6, flags: 82 }, 'Whirlwind', 'Whirlwind/ Roar effect'),
  move({ id: 165, effect: 254, category: 'physical', power: 50, type: 0, accuracy: 0, pp: 1, effectChance: 0, target: 0, priority: 0, flags: 99 }, 'Struggle', 'Struggle effect'),
  move({ id: 273, effect: 179, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 0, flags: 128 }, 'Wish', '1/2 of user\'s max HP is restored at the end of next turn'),
  move({ id: 77, effect: 66, category: 'status', power: 0, type: 3, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 86 }, 'PoisonPowder', 'Guaranteed Poison'),
  move({ id: 45, effect: 18, category: 'status', power: 0, type: 0, accuracy: 100, pp: 40, effectChance: 0, target: 4, priority: 0, flags: 86 }, 'Growl', 'Lowers Atk (Status)'), // a filler with no chance and 40 PP (Mean Look has 5 and priority +1)
  move({ id: 161, effect: 36, category: 'special', power: 95, type: 0, accuracy: 100, pp: 10, effectChance: 30, target: 0, priority: 0, flags: 18 }, 'Tri Attack', 'Chance of either Paralyzing; Burning; or Freezing target'),
  // Invented: vanilla numbers under vanilla names for moves the hack changed (its 269 is HP Dark, 200
  // Outrage with recoil and no lock, 222 Bulldoze, 149 Triple Axel), so each runs its Showdown namesake's behaviour.
  // Psywave never misses here (vanilla: 80), so its test sees the damage pick alone.
  move({ id: 269, effect: 176, category: 'status', power: 0, type: 17, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 22 }, 'Taunt', 'Taunt effect'),
  move({ id: 200, effect: 27, category: 'physical', power: 120, type: 16, accuracy: 100, pp: 15, effectChance: 0, target: 2, priority: 0, flags: 51 }, 'Outrage', 'None'),
  move({ id: 222, effect: 126, category: 'physical', power: 1, type: 4, accuracy: 100, pp: 30, effectChance: 0, target: 8, priority: 0, flags: 50 }, 'Magnitude', 'None'),
  move({ id: 149, effect: 88, category: 'special', power: 1, type: 14, accuracy: 0, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 18 }, 'Psywave', 'None'),
  // Invented: vanilla Gen 4 numbers under vanilla names, so each runs its Showdown namesake's behaviour
  // (recoil, drain, the substitute, False Swipe's last HP, Bide's stored damage) for the knock-out-roll collapse tests.
  move({ id: 38, effect: 198, category: 'physical', power: 120, type: 0, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Double-Edge', 'Recoil'),
  move({ id: 202, effect: 3, category: 'special', power: 60, type: 12, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Giga Drain', 'Drains half the damage dealt'),
  move({ id: 164, effect: 79, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 0, flags: 0 }, 'Substitute', 'Substitute effect'),
  move({ id: 206, effect: 101, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 40, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'False Swipe', 'Leaves the target with at least 1 HP'),
  move({ id: 117, effect: 26, category: 'physical', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 1, flags: 51 }, 'Bide', 'Bide effect'),
  // The hack's own, for the table-driven move effects. Several are moves
  // whose docs text differs from their Showdown namesake's behaviour, so the docs' text visibly decides.
  move({ id: 315, effect: 253, category: 'special', power: 120, type: 10, accuracy: 100, pp: 5, effectChance: 10, target: 0, priority: 0, flags: 178 }, 'Overheat', 'Chance of causing Burn; 1/3 damage dealt recoil'), // Showdown's Overheat drops the user's SpA instead
  move({ id: 336, effect: 10, category: 'status', power: 0, type: 0, accuracy: 0, pp: 3, effectChance: 0, target: 16, priority: 0, flags: 8 }, 'Howl', 'Raises Atk'),
  move({ id: 232, effect: 139, category: 'physical', power: 50, type: 8, accuracy: 100, pp: 35, effectChance: 10, target: 0, priority: 0, flags: 19 }, 'Metal Claw', 'Chance of raising Atk'),
  move({ id: 43, effect: 19, category: 'status', power: 0, type: 0, accuracy: 100, pp: 30, effectChance: 0, target: 4, priority: 0, flags: 22 }, 'Leer', 'Lowers Def (Status)'),
  move({ id: 306, effect: 69, category: 'physical', power: 120, type: 0, accuracy: 95, pp: 10, effectChance: 50, target: 0, priority: 0, flags: 19 }, 'Crush Claw', 'Lowers Def (Attack)'),
  move({ id: 281, effect: 1, category: 'status', power: 0, type: 0, accuracy: 70, pp: 10, effectChance: 100, target: 0, priority: 0, flags: 22 }, 'Yawn', 'Causes Sleep'), // a 70%-accurate sleep move; Showdown's Yawn makes its target drowsy instead
  move({ id: 461, effect: 32, category: 'status', power: 0, type: 14, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 1, flags: 128 }, 'Lunar Dance', 'Restores up to 50% max HP'), // Showdown's Lunar Dance faints its user
  move({ id: 44, effect: 31, category: 'physical', power: 60, type: 17, accuracy: 100, pp: 25, effectChance: 30, target: 0, priority: 0, flags: 19 }, 'Bite', 'Chance to Flinch'),
  move({ id: 352, effect: 76, category: 'special', power: 60, type: 11, accuracy: 0, pp: 20, effectChance: 20, target: 0, priority: 0, flags: 178 }, 'Water Pulse', 'Chance to Confuse'), // its calc base is Swift, which never confuses
  move({ id: 313, effect: 60, category: 'status', power: 0, type: 17, accuracy: 100, pp: 3, effectChance: 0, target: 0, priority: 0, flags: 86 }, 'Fake Tears', 'Sharply lowers Spd (Status)'), // Showdown's Fake Tears lowers Special Defense
  move({ id: 359, effect: 218, category: 'physical', power: 100, type: 1, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Hammer Arm', 'Lowers user\'s Spd'), // a sure drop with a ROM effect chance of 0
  // The hack's own.
  move({ id: 143, effect: 262, category: 'physical', power: 120, type: 2, accuracy: 100, pp: 5, effectChance: 20, target: 0, priority: 0, flags: 50 }, 'Sky Attack', 'Chance of causing Paralysis; 1/3 damage dealt recoil'), // no contact bit; its calc base Tackle makes contact
  move({ id: 20, effect: 71, category: 'special', power: 75, type: 10, accuracy: 0, pp: 20, effectChance: 100, target: 0, priority: 0, flags: 115 }, 'Mystical Fire', 'Lowers SpAtk (Attack)'), // the contact bit; its calc base Swift makes no contact
  move({ id: 424, effect: 273, category: 'physical', power: 90, type: 10, accuracy: 100, pp: 15, effectChance: 10, target: 0, priority: 0, flags: 51 }, 'Fire Fang', 'Chance of causing Burn; chance of causing Flinch'),
  move({ id: 207, effect: 118, category: 'status', power: 0, type: 0, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 86 }, 'Swagger', 'Sharply raises target\'s Atk and causes Confusion'),
  move({ id: 116, effect: 47, category: 'status', power: 0, type: 0, accuracy: 0, pp: 5, effectChance: 0, target: 16, priority: 0, flags: 72 }, 'Focus Energy', 'Sharply raises crit ratio'),
  move({ id: 451, effect: 276, category: 'special', power: 50, type: 13, accuracy: 100, pp: 10, effectChance: 100, target: 0, priority: 0, flags: 50 }, 'Charge Beam', 'Chance of raising user\'s SpAtk'), // a 100% chance: Showdown's move-level `self`
  move({ id: 445, effect: 265, category: 'status', power: 0, type: 0, accuracy: 100, pp: 3, effectChance: 0, target: 4, priority: 0, flags: 86 }, 'Captivate', 'Sharply lowers SpAtk (Status)'), // the docs give no gender condition and no Oblivious exception
  // The hack's own, for the named mechanics. PP are the ROM's.
  move({ id: 153, effect: 7, category: 'physical', power: 250, type: 0, accuracy: 100, pp: 5, effectChance: 0, target: 8, priority: 0, flags: 50 }, 'Explosion', 'Selfdestruct/ Explosion effect'),
  move({ id: 120, effect: 7, category: 'physical', power: 200, type: 0, accuracy: 100, pp: 5, effectChance: 0, target: 8, priority: 0, flags: 50 }, 'Selfdestruct', 'Selfdestruct/ Explosion effect'),
  move({ id: 262, effect: 7, category: 'special', power: 255, type: 17, accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 16 }, 'Memento', 'Selfdestruct/ Explosion effect'), // a special Dark Explosion in the hack
  move({ id: 228, effect: 128, category: 'physical', power: 70, type: 17, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 147 }, 'Pursuit', 'Pursuit effect'),
  move({ id: 99, effect: 128, category: 'physical', power: 70, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Rage', 'Pursuit effect'), // a Fighting-type Pursuit in the hack
  move({ id: 446, effect: 266, category: 'status', power: 0, type: 5, accuracy: 0, pp: 20, effectChance: 0, target: 128, priority: 1, flags: 4 }, 'Stealth Rock', 'Stealth Rocks effect'),
  move({ id: 191, effect: 112, category: 'status', power: 0, type: 4, accuracy: 0, pp: 20, effectChance: 0, target: 128, priority: 1, flags: 4 }, 'Spikes', 'Spikes effect'),
  move({ id: 390, effect: 249, category: 'status', power: 0, type: 3, accuracy: 0, pp: 20, effectChance: 0, target: 128, priority: 1, flags: 68 }, 'Toxic Spikes', 'Toxic Spikes effect'),
  move({ id: 252, effect: 158, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 10, effectChance: 100, target: 0, priority: 3, flags: 19 }, 'Fake Out', 'Guaranteed Flinch; can only be used turn 1'),
  move({ id: 197, effect: 111, category: 'status', power: 0, type: 1, accuracy: 0, pp: 5, effectChance: 0, target: 16, priority: 3, flags: 0 }, 'Detect', 'Protect/ Detect effect'),
  move({ id: 226, effect: 127, category: 'status', power: 0, type: 0, accuracy: 0, pp: 40, effectChance: 0, target: 16, priority: 1, flags: 0 }, 'Baton Pass', 'Baton Pass effect'),
  move({ id: 115, effect: 65, category: 'status', power: 0, type: 14, accuracy: 0, pp: 20, effectChance: 0, target: 32, priority: 0, flags: 72 }, 'Reflect', '1/2 damage from Physical attacks'),
  move({ id: 113, effect: 35, category: 'status', power: 0, type: 14, accuracy: 0, pp: 30, effectChance: 0, target: 32, priority: 0, flags: 72 }, 'Light Screen', '1/2 damage from Special attacks'),
  move({ id: 219, effect: 124, category: 'status', power: 0, type: 0, accuracy: 0, pp: 25, effectChance: 0, target: 32, priority: 0, flags: 72 }, 'Safeguard', 'Safeguard effect'),
  move({ id: 54, effect: 46, category: 'status', power: 0, type: 15, accuracy: 0, pp: 30, effectChance: 0, target: 32, priority: 0, flags: 8 }, 'Mist', 'Prevents lowering of stats'),
  move({ id: 240, effect: 136, category: 'status', power: 0, type: 11, accuracy: 0, pp: 5, effectChance: 0, target: 64, priority: 0, flags: 0 }, 'Rain Dance', 'Causes Rain'),
  move({ id: 241, effect: 137, category: 'status', power: 0, type: 10, accuracy: 0, pp: 5, effectChance: 0, target: 64, priority: 0, flags: 0 }, 'Sunny Day', 'Causes Harsh Sunlight'),
  move({ id: 201, effect: 115, category: 'status', power: 0, type: 5, accuracy: 0, pp: 10, effectChance: 0, target: 64, priority: 0, flags: 0 }, 'Sandstorm', 'Causes Sandstorm'),
  move({ id: 258, effect: 164, category: 'status', power: 0, type: 15, accuracy: 0, pp: 10, effectChance: 0, target: 64, priority: 0, flags: 2 }, 'Hail', 'Causes Hail'),
  move({ id: 433, effect: 259, category: 'status', power: 0, type: 14, accuracy: 0, pp: 5, effectChance: 0, target: 64, priority: 7, flags: 16 }, 'Trick Room', 'Trick Room effect'), // priority +7 in the hack
  move({ id: 366, effect: 225, category: 'status', power: 0, type: 2, accuracy: 0, pp: 30, effectChance: 0, target: 32, priority: 5, flags: 8 }, 'Tailwind', '2x Spd for user\'s party for 3 turns'),
  move({ id: 356, effect: 215, category: 'status', power: 0, type: 14, accuracy: 0, pp: 5, effectChance: 0, target: 64, priority: 1, flags: 0 }, 'Gravity', 'Gravity effect'),
  move({ id: 259, effect: 165, category: 'status', power: 0, type: 17, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 86 }, 'Torment', 'Torment effect'),
  move({ id: 220, effect: 91, category: 'status', power: 0, type: 0, accuracy: 0, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 18 }, 'Pain Split', 'Pain Split effect'),
  move({ id: 68, effect: 89, category: 'physical', power: 1, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 1, priority: -5, flags: 1 }, 'Counter', '2x last amount of damage received'),
  move({ id: 243, effect: 144, category: 'special', power: 1, type: 14, accuracy: 100, pp: 20, effectChance: 0, target: 1, priority: -5, flags: 0 }, 'Mirror Coat', 'Mirror Coat effect'),
  move({ id: 264, effect: 170, category: 'physical', power: 150, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: -3, flags: 131 }, 'Focus Punch', 'Focus Punch effect'),
  move({ id: 389, effect: 0, category: 'physical', power: 80, type: 17, accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 2, flags: 115 }, 'Sucker Punch', 'None'), // a plain priority hit in the hack: ROM effect 0, no fail condition
  move({ id: 195, effect: 114, category: 'status', power: 0, type: 0, accuracy: 0, pp: 5, effectChance: 0, target: 64, priority: 0, flags: 128 }, 'Perish Song', 'All users on field faint in 3 turns'),
  move({ id: 194, effect: 98, category: 'status', power: 0, type: 7, accuracy: 0, pp: 5, effectChance: 0, target: 16, priority: 0, flags: 0 }, 'Destiny Bond', 'Destiny Bond effect'),
  move({ id: 187, effect: 142, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 0, flags: 72 }, 'Belly Drum', 'Belly Drum effect'),
  move({ id: 114, effect: 25, category: 'status', power: 0, type: 15, accuracy: 0, pp: 30, effectChance: 0, target: 64, priority: 0, flags: 0 }, 'Haze', 'Resets stat changes'),
  move({ id: 286, effect: 192, category: 'status', power: 0, type: 14, accuracy: 0, pp: 10, effectChance: 0, target: 16, priority: 0, flags: 0 }, 'Imprison', 'Target is prevented from using moves shared with the user'),
  move({ id: 23, effect: 150, category: 'physical', power: 90, type: 4, accuracy: 100, pp: 20, effectChance: 30, target: 0, priority: 0, flags: 83 }, 'Stomp', 'Causes flinch and 2x damage if target has used Minimize'),
  move({ id: 107, effect: 108, category: 'status', power: 0, type: 0, accuracy: 0, pp: 20, effectChance: 0, target: 16, priority: 0, flags: 8 }, 'Minimize', 'Sharply raises Evasion (Status)'),
  // Invented, for the ROM-flag tests: Tackle's numbers with no Protect bit (flags 113 = 115 less 0x02).
  move({ id: 998, effect: 0, category: 'physical', power: 35, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 113 }, 'Unblockable Hit', 'None'),
  // Invented, for Sleep Talk's list: a plain hit whose ROM effect is SolarBeam's charge effect (151), which the
  // cartridge's Sleep Talk leaves out by effect (Move_IsMultiTurn, battle_lib.c:2975-2992).
  move({ id: 997, effect: 151, category: 'physical', power: 35, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Charge Hit', 'None'),
  // Invented, for Wonder Guard: a Water hit with Fire Fang's ROM effect (273, FLINCH_BURN_HIT), which the cartridge's
  // Wonder Guard never stops (MoveIsOnDamagingTurn, battle_lib.c:7588-7605).
  move({ id: 996, effect: 273, category: 'physical', power: 65, type: 11, accuracy: 100, pp: 15, effectChance: 10, target: 0, priority: 0, flags: 51 }, 'Fang Hit', 'Chance of causing Burn; chance of causing Flinch'),
  // The hack's own, for the variable-power moves and the rest.
  move({ id: 175, effect: 99, category: 'physical', power: 1, type: 0, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Flail', 'Higher power the less HP the user has'),
  move({ id: 323, effect: 190, category: 'special', power: 150, type: 11, accuracy: 100, pp: 5, effectChance: 0, target: 4, priority: 0, flags: 18 }, 'Water Spout', 'Power= Base power x(user\'s current HP/ user\'s max HP)'),
  move({ id: 360, effect: 219, category: 'physical', power: 1, type: 8, accuracy: 100, pp: 8, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Gyro Ball', 'Power = min(150; (25 x Target\'s Current Speed / User\'s Current Speed) + 1)'),
  move({ id: 67, effect: 196, category: 'physical', power: 1, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Low Kick', 'Inflicts greater damage on heavier targets'),
  move({ id: 447, effect: 196, category: 'special', power: 1, type: 12, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Grass Knot', 'Inflicts greater damage on heavier targets'),
  move({ id: 362, effect: 221, category: 'special', power: 65, type: 11, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Brine', '2x power if target is at or below 1/2 HP'),
  move({ id: 378, effect: 221, category: 'special', power: 75, type: 0, accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Wring Out', '2x power if target is at or below 1/2 HP'), // Brine's effect in the hack, not Wring Out's HP scaling
  move({ id: 263, effect: 169, category: 'physical', power: 80, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 83 }, 'Facade', '2x power if user is Poisoned; Paralyzed; or Burned.'),
  move({ id: 386, effect: 245, category: 'physical', power: 1, type: 17, accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Punishment', 'Power= 60 + (20x # of stat increases of target)'),
  move({ id: 371, effect: 230, category: 'physical', power: 60, type: 17, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Payback', '2x Power if user moves after target'),
  move({ id: 279, effect: 230, category: 'physical', power: 60, type: 1, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Revenge', '2x Power if user moves after target'), // Payback's effect in the hack
  move({ id: 237, effect: 135, category: 'special', power: 1, type: 0, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Hidden Power', 'Hidden Power effect'),
  move({ id: 311, effect: 203, category: 'special', power: 50, type: 0, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Weather Ball', 'Type changes to match weather'),
  move({ id: 376, effect: 235, category: 'special', power: 1, type: 0, accuracy: 0, pp: 1, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Trump Card', 'The less PP the move has; the greater its Power'),
  move({ id: 265, effect: 171, category: 'physical', power: 90, type: 0, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 19 }, 'SmellingSalt', '2x power if target is Paralyzed; cures target of Paralysis'),
  move({ id: 358, effect: 217, category: 'physical', power: 60, type: 1, accuracy: 100, pp: 10, effectChance: 100, target: 0, priority: 0, flags: 51 }, 'Wake-Up Slap', '2x power if target is asleep; wakes up target'),
  move({ id: 450, effect: 224, category: 'physical', power: 60, type: 6, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Bug Bite', 'Consumes target\'s berry'),
  move({ id: 335, effect: 106, category: 'status', power: 0, type: 0, accuracy: 0, pp: 5, effectChance: 0, target: 0, priority: 7, flags: 22 }, 'Block', 'Prevents target from switching out or fleeing'),
  move({ id: 329, effect: 260, category: 'special', power: 70, type: 15, accuracy: 50, pp: 5, effectChance: 100, target: 0, priority: 0, flags: 18 }, 'Sheer Cold', 'Always hits in Hail'), // Blizzard's effect at a ROM chance of 100: a sure freeze
  move({ id: 301, effect: 260, category: 'physical', power: 120, type: 15, accuracy: 70, pp: 8, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Ice Ball', 'Always hits in Hail'), // Blizzard's effect at a ROM chance of 0: never freezes
  move({ id: 174, effect: 109, category: 'status', power: 0, type: 9, accuracy: 0, pp: 3, effectChance: 0, target: 0, priority: 0, flags: 64 }, 'Curse', 'Curse effect'),
  move({ id: 280, effect: 186, category: 'physical', power: 75, type: 1, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Brick Break', 'Removes Light Screen/ Reflect from target\'s side of the field'),
  move({ id: 69, effect: 87, category: 'physical', power: 1, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 179 }, 'Seismic Toss', 'Deals damage equal to user\'s level'),
  move({ id: 162, effect: 40, category: 'physical', power: 1, type: 17, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 83 }, 'Super Fang', 'Deals damage equal to 1/2 target\'s current hp'),
  move({ id: 283, effect: 189, category: 'physical', power: 1, type: 9, accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Endeavor', 'Target\'s HP becomes equal to the user\'s current HP'),
  move({ id: 82, effect: 41, category: 'special', power: 1, type: 16, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Dragon Rage', 'Deals 40 damage'),
  move({ id: 368, effect: 227, category: 'physical', power: 1, type: 8, accuracy: 100, pp: 10, effectChance: 0, target: 1, priority: -2, flags: 16 }, 'Metal Burst', 'Damage= 1.5x damage dealt by the target\'s last attack'),
  move({ id: 266, effect: 172, category: 'status', power: 0, type: 0, accuracy: 0, pp: 20, effectChance: 0, target: 16, priority: 3, flags: 0 }, 'Follow Me', 'Redirects all moves to user'),
  move({ id: 355, effect: 214, category: 'status', power: 0, type: 2, accuracy: 0, pp: 8, effectChance: 0, target: 16, priority: 0, flags: 72 }, 'Roost', 'Roost effect'),
  move({ id: 235, effect: 132, category: 'status', power: 0, type: 12, accuracy: 0, pp: 5, effectChance: 0, target: 16, priority: 0, flags: 72 }, 'Synthesis', 'Synthesis effect'),
  move({ id: 367, effect: 226, category: 'status', power: 0, type: 0, accuracy: 0, pp: 30, effectChance: 0, target: 512, priority: 0, flags: 72 }, 'Acupressure', 'Sharply raises a random stat of the target'),
  move({ id: 274, effect: 180, category: 'status', power: 0, type: 0, accuracy: 0, pp: 35, effectChance: 0, target: 1, priority: 0, flags: 0 }, 'Assist', 'Assist effect'),
  move({ id: 168, effect: 85, category: 'physical', power: 40, type: 17, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 83 }, 'Thief', 'Splash effect'), // Splash's effect (85) in the hack: it does nothing
  move({ id: 173, effect: 92, category: 'special', power: 80, type: 0, accuracy: 100, pp: 15, effectChance: 30, target: 0, priority: 0, flags: 50 }, 'Snore', 'Can only be used while asleep; chance of causing Flinch'),
  // The hack's own.
  move({ id: 244, effect: 143, category: 'status', power: 0, type: 0, accuracy: 0, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 72 }, 'Psych Up', 'Copies all of target\'s stat boosts'),
  move({ id: 387, effect: 246, category: 'physical', power: 130, type: 0, accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 51 }, 'Last Resort', 'Fails unless the user has used all of its other moves at least once'),
  // For the damage order: plain hits of one type each, under names no Showdown move has, so they run with no callbacks.
  move({ id: 974, effect: 117, category: 'physical', power: 30, type: 5, accuracy: 90, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Roll', 'None'), // ROM effect 117 (Rollout's)
  move({ id: 973, effect: 155, category: 'physical', power: 90, type: 2, accuracy: 95, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Fly', 'None'), // ROM effect 155 (Fly's): a charge-turn move
  move({ id: 977, effect: 147, category: 'physical', power: 40, type: 4, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Quake', 'None'), // ROM effect 147 (Earthquake's)
  move({ id: 976, effect: 149, category: 'special', power: 40, type: 2, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Gust', 'None'), // ROM effect 149 (Gust's)
  move({ id: 975, effect: 261, category: 'special', power: 40, type: 11, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Surf', 'None'), // ROM effect 261 (Surf's)
  move({ id: 978, effect: 150, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Stomp', 'None'), // ROM effect 150 (Stomp's), the docs' text none
  move({ id: 980, effect: 0, category: 'special', power: 75, type: 10, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Fire', 'None'),
  move({ id: 981, effect: 0, category: 'special', power: 95, type: 15, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Ice', 'None'),
  move({ id: 982, effect: 0, category: 'special', power: 80, type: 7, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Ghost', 'None'),
  move({ id: 983, effect: 0, category: 'physical', power: 120, type: 1, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Fighting', 'None'),
  move({ id: 984, effect: 0, category: 'physical', power: 100, type: 5, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Rock', 'None'),
  move({ id: 985, effect: 0, category: 'special', power: 80, type: 12, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Grass', 'None'),
  move({ id: 986, effect: 0, category: 'special', power: 90, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Special', 'None'),
  move({ id: 987, effect: 0, category: 'special', power: 80, type: 11, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 50 }, 'Plain Water', 'None'),
  move({ id: 988, effect: 0, category: 'physical', power: 80, type: 6, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Plain Bug', 'None'),
  // The hack's own. Defog clears the deep fog (subscript_defog.s:64-65).
  move({ id: 432, effect: 258, category: 'status', power: 0, type: 2, accuracy: 0, pp: 1, effectChance: 0, target: 0, priority: 0, flags: 18 }, 'Defog', 'Defog effect'),
  move({ id: 236, effect: 132, category: 'status', power: 0, type: 0, accuracy: 0, pp: 5, effectChance: 0, target: 16, priority: 0, flags: 136 }, 'Moonlight', 'Synthesis effect'),
];

function move(rom: MoveRecord, name: string, effectText: string): [MoveRecord, DocMove] {
  const doc: DocMove = {
    id: rom.id, name, effectText, category: rom.category, power: rom.power, type: '', accuracy: rom.accuracy, pp: rom.pp,
    effectChance: rom.effectChance, targets: '', priority: rom.priority, contact: false,
  };
  return [rom, doc];
}

/** The ROM records of `FIXTURE_MOVES`, by ID. */
export const FIXTURE_MOVES: ReadonlyMap<number, MoveRecord> = new Map(MOVES.map(([rom]) => [rom.id, rom]));

/**
 * ROM trainers for the engine's bag-item tests, by trainer index; the engine reads only `items` (ROM item IDs) from
 * them. Invented: the hack's own bags hold Full Restores, X Defend, X Accuracy, X Special and Poké Balls.
 */
export const BAG = { none: 1, fullRestore: 2, potions: 3, pokeBall: 4, battleItems: 5, mixedHp: 6, mixedStat: 7 } as const;

const TRAINERS: readonly RomTrainer[] = [
  romTrainer(BAG.none, []),
  romTrainer(BAG.fullRestore, [], { items: [23] }), // Full Restore
  romTrainer(BAG.potions, [], { items: [17, 57, 17, 26] }), // Potion, X Attack, Potion, Super Potion
  romTrainer(BAG.pokeBall, [], { items: [4] }), // Poké Ball: no effect the engine models
  romTrainer(BAG.battleItems, [], { items: [56, 55, 61, 27] }), // Dire Hit, Guard Spec., X Special, Full Heal
  romTrainer(BAG.mixedHp, [], { items: [17, 18, 27, 25] }), // Potion, Antidote, Full Heal, Hyper Potion
  romTrainer(BAG.mixedStat, [], { items: [57, 56, 61, 24] }), // X Attack, Dire Hit, X Special, Max Potion
  // `aiFlags` name the mask's bits as the ROM reader does (rom/trainers.ts, `AI_FLAG_NAMES`); bit 31 has no name.
  romTrainer(8, [], { aiMask: 0x00000007, aiFlags: ['Basic', 'EvalAttack', 'Expert'] }),
  romTrainer(9, [], { aiMask: 0x80000041, aiFlags: ['Basic', 'BatonPass'] }),
];

/**
 * Every item whose hold effect or parameter is not 0, `[item ID, hold effect, parameter]`, from the hack ROM's item data
 * (bytes 2 and 3 of each entry, `decodeItem` in src/rom/items.ts). The engine reads its held-item numbers from these, so
 * the fixture runs the hack's own: King's Rock 11 where vanilla has 10, the Plates 50, the weather rocks 7, Jaboca and
 * Rowap 6, and Ganlon, Apicot and Shoal Salt (item 70) 0.
 */
export const ROM_ITEM_HOLD: readonly (readonly [number, number, number])[] = [
  [17, 0, 20], [23, 0, 255], [24, 0, 255], [25, 0, 200], [26, 0, 50], [30, 0, 50], [31, 0, 60], [32, 0, 80],
  [33, 0, 100], [38, 0, 10], [39, 0, 255], [40, 0, 10], [41, 0, 255], [42, 12, 0], [43, 1, 20], [54, 12, 0],
  [68, 0, 50], [69, 0, 150], [70, 36, 0], [71, 1, 100], [76, 0, 200], [77, 0, 250], [79, 0, 100], [112, 2, 20],
  [135, 3, 20], [136, 4, 20], [149, 5, 0], [150, 6, 0], [151, 7, 0], [152, 8, 0], [153, 9, 0], [154, 10, 10],
  [155, 1, 10], [156, 11, 0], [157, 12, 0], [158, 13, 25], [159, 14, 8], [160, 15, 8], [161, 16, 8], [162, 17, 8],
  [163, 18, 8], [184, 19, 0], [185, 20, 0], [186, 21, 0], [187, 22, 0], [188, 23, 0], [189, 24, 0], [190, 25, 0],
  [191, 26, 0], [192, 27, 0], [193, 28, 0], [194, 29, 0], [195, 30, 0], [196, 31, 0], [197, 32, 0], [198, 33, 0],
  [199, 34, 0], [200, 35, 0], [201, 36, 4], [202, 37, 0], [203, 38, 4], [204, 39, 4], [205, 40, 0], [206, 41, 4],
  [207, 42, 4], [208, 43, 4], [209, 44, 4], [210, 45, 4], [211, 46, 6], [212, 47, 6], [213, 48, 11], [214, 49, 0],
  [215, 50, 0], [216, 51, 0], [217, 52, 20], [218, 53, 0], [219, 54, 0], [220, 55, 0], [221, 56, 11], [222, 57, 20],
  [223, 58, 10], [224, 59, 0], [225, 60, 0], [226, 61, 0], [227, 62, 0], [228, 63, 0], [229, 64, 0], [230, 65, 10],
  [231, 66, 0], [232, 67, 0], [233, 68, 20], [234, 69, 10], [235, 70, 10], [236, 71, 0], [237, 72, 20], [238, 73, 20],
  [239, 74, 20], [240, 75, 20], [241, 76, 20], [242, 77, 20], [243, 78, 20], [244, 79, 20], [245, 80, 20], [246, 81, 20],
  [247, 82, 20], [248, 83, 20], [249, 84, 20], [250, 85, 20], [251, 86, 20], [252, 87, 0], [253, 88, 8], [254, 78, 20],
  [255, 48, 11], [256, 89, 0], [257, 90, 0], [258, 91, 0], [259, 92, 0], [265, 93, 10], [266, 94, 10], [267, 95, 10],
  [268, 96, 20], [269, 97, 3], [270, 98, 30], [271, 99, 0], [272, 100, 0], [273, 101, 0], [274, 102, 0], [275, 103, 0],
  [276, 104, 20], [277, 105, 10], [278, 106, 0], [279, 107, 0], [280, 108, 0], [281, 109, 16], [282, 110, 7], [283, 111, 7],
  [284, 112, 7], [285, 113, 7], [286, 114, 0], [287, 115, 0], [288, 116, 8], [289, 50, 0], [290, 50, 0], [291, 50, 0],
  [292, 50, 0], [293, 50, 0], [294, 50, 0], [295, 123, 0], [296, 124, 30], [297, 125, 0], [298, 126, 50], [299, 127, 50],
  [300, 128, 50], [301, 129, 50], [302, 130, 50], [303, 131, 50], [304, 132, 50], [305, 133, 50], [306, 134, 50], [307, 135, 50],
  [308, 136, 50], [309, 137, 50], [310, 138, 50], [311, 139, 50], [312, 140, 50], [313, 141, 50], [314, 83, 20], [315, 73, 20],
  [316, 107, 0], [317, 78, 20], [318, 74, 20], [319, 58, 10], [320, 59, 0], [321, 142, 0], [322, 143, 0], [323, 144, 0],
  [324, 145, 0], [325, 146, 0], [326, 67, 0], [327, 56, 10],
];

/** A fresh fixture `LoadedData` (a test may change it): the species, moves and trainers above, and the name index over them. */
export function fixtureData(): LoadedData {
  const data = loadedData({
    species: SPECIES.map((row) => structuredClone(row)), trainers: TRAINERS.map((trainer) => structuredClone(trainer)),
    docSpecies: DOC_SPECIES, docTrainers: [],
  });
  for (const [rom, doc] of MOVES) {
    data.rom.moves[rom.id] = { ...rom };
    data.docs.moves.push({ ...doc });
  }
  data.names = buildNameIndex(data.docs);
  data.rom.items = Array.from({ length: 468 }, (_, id) => ({ id, flingPower: 30, holdEffect: 0, holdParam: 0 }));
  for (const [item, holdEffect, holdParam] of ROM_ITEM_HOLD) data.rom.items[item] = { ...data.rom.items[item]!, holdEffect, holdParam };
  return data;
}

/** A fresh fixture `LoadedData` and `buildMoves` over it: what `installKaizoDex` takes. */
export function fixtureDex(): { data: LoadedData; moves: Map<number, KaizoMove> } {
  const data = fixtureData();
  return { data, moves: buildMoves(data) };
}

// Battle-ready Pokémon and trainers over the fixture species and moves.

const SPECIES_NAMES: Record<number, string> = {
  25: 'Pikachu', 263: 'Zigzagoon', 351: 'Castform', 386: 'Deoxys', 391: 'Monferno', 399: 'Bidoof',
  487: 'Giratina', 292: 'Shedinja',
  4: 'Charmander', 66: 'Machop',
  442: 'Spiritomb', 94: 'Gengar', 6: 'Charizard', 357: 'Tropius',
  129: 'Magikarp', 492: 'Shaymin',
};

const allStats = (value: number): Stats => stats(value, value, value, value, value, value);

function speciesRow(species: number): SpeciesRecord {
  const row = SPECIES.find((record) => record.id === species);
  if (row === undefined) throw new Error(`No fixture species ${species}`);
  return row;
}

/**
 * A fixture player Pokémon in party slot 0: form 0, male, Hardy, 31 IVs, no EVs, the species' first ability, no item,
 * full PP without PP Ups, healthy and at full HP (the formula's, over `fields`' IVs, EVs and nature), with its species'
 * base friendship (70 for every fixture species: the value the engine's battle fixtures give the save's).
 */
export function playerMon(species: number, level: number, moves: number[], fields: Partial<PlayerMon> = {}): PlayerMon {
  const row = speciesRow(species);
  const ivs = fields.ivs ?? allStats(31);
  const evs = fields.evs ?? allStats(0);
  const nature = fields.nature ?? { value: 0, source: 'rom', disputed: false, alternatives: [] };
  const hp = computeStats(row.baseStats, ivs, evs, level, nature.value ?? 0).hp;
  return {
    friendship: row.baseFriendship, // a fresh Pokémon's: its species' base friendship (BattleMon.friendship)
    species, form: 0, name: SPECIES_NAMES[species]!, nickname: SPECIES_NAMES[species]!, level, gender: 'M', ivs, evs, nature,
    ability: { value: row.abilities[0], source: 'rom', disputed: false, alternatives: [] }, item: 0, moves: [...moves],
    pp: moves.map((move) => FIXTURE_MOVES.get(move)!.pp), ppUps: moves.map(() => 0), baseStats: { ...row.baseStats },
    types: [...row.types], status: { kind: 'none' }, currentHp: hp, location: { kind: 'party', slot: 0 }, notes: [],
    ...fields,
  };
}

/**
 * A fixture trainer Pokémon: form 0, male, a known Hardy nature from the ROM, 31 IVs, no EVs, the species' first ability,
 * no item, and its species' base friendship (as `resolveTrainer` gives it).
 */
export function resolvedMon(species: number, level: number, moves: number[], fields: Partial<ResolvedMon> = {}): ResolvedMon {
  const row = speciesRow(species);
  return {
    friendship: row.baseFriendship, // as Pokemon_InitWith gives a trainer's Pokémon (BattleMon.friendship)
    species, form: 0, name: SPECIES_NAMES[species]!, level, gender: 'M', ivs: allStats(31), evs: allStats(0),
    nature: { value: 0, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: row.abilities[0], source: 'rom', disputed: false, alternatives: [] },
    item: 0, moves: [...moves], baseStats: { ...row.baseStats }, types: [...row.types], ...fields,
  };
}

/** A fixture single-battle trainer for ROM trainer `romIndex` (whose bag the engine reads; see `BAG`), with no AI flags. */
export function resolvedTrainer(romIndex: number, party: ResolvedMon[], fields: Partial<ResolvedTrainer> = {}): ResolvedTrainer {
  return {
    id: `fixture-split/youngster-tristan/${romIndex}`, name: 'Youngster Tristan', split: 'Fixture Split', location: 'Route 202',
    order: 0, romIndex, trainerClass: 2, battleType: 'single', aiFlags: [], field: null, tags: { starred: false, raw: [] },
    levelMismatch: false, party, variants: [], ...fields,
  };
}

// The chance-enumeration fixture.

/** Fixture species and move IDs. */
export const ID = {
  zigzagoon: 263, castform: 351, deoxys: 386, monferno: 391, bidoof: 399, pikachu: 25,
  waterBall: 4, guillotine: 12, fireBall: 30, tackle: 33, ember: 52, leechSeed: 73, meanLook: 212, beatUp: 251, uTurn: 369,
  megaKick: 25, furyAttack: 31, thunder: 87, hurricane: 140, slash: 163, blizzard: 59, futureSight: 248, knockOff: 282,
  return: 216, frustration: 218, plainHit: 999,
  spore: 147, sleepTalk: 214, rest: 156, flameWheel: 172, confuseRay: 109, thunderWave: 86, attract: 213, disable: 50,
  encore: 227, uproar: 253, wrap: 35, protect: 182, endure: 203, metronome: 118, present: 217, roar: 46, whirlwind: 18,
  struggle: 165, wish: 273, poisonPowder: 77, growl: 45, triAttack: 161, taunt: 269, outrage: 200, magnitude: 222, psywave: 149,
  doubleEdge: 38, gigaDrain: 202, substitute: 164, falseSwipe: 206, bide: 117,
  overheat: 315, howl: 336, metalClaw: 232, leer: 43, crushClaw: 306, yawn: 281, lunarDance: 461, bite: 44, waterPulse: 352,
  fakeTears: 313, hammerArm: 359,
  skyAttack: 143, mysticalFire: 20, fireFang: 424, swagger: 207, focusEnergy: 116, chargeBeam: 451, captivate: 445,
  giratina: 487, shedinja: 292, charmander: 4, machop: 66,
  explosion: 153, selfdestruct: 120, memento: 262, pursuit: 228, rage: 99, stealthRock: 446, spikes: 191, toxicSpikes: 390,
  fakeOut: 252, detect: 197, batonPass: 226, reflect: 115, lightScreen: 113, safeguard: 219, mist: 54, rainDance: 240,
  sunnyDay: 241, sandstorm: 201, hail: 258, trickRoom: 433, tailwind: 366, gravity: 356, torment: 259, painSplit: 220,
  counter: 68, mirrorCoat: 243, focusPunch: 264, suckerPunch: 389, perishSong: 195, destinyBond: 194, bellyDrum: 187,
  haze: 114, imprison: 286, stomp: 23, minimize: 107, unblockable: 998, chargeHit: 997, fangHit: 996,
  magikarp: 129, shaymin: 492,
  flail: 175, waterSpout: 323, gyroBall: 360, lowKick: 67, grassKnot: 447, brine: 362, wringOut: 378, facade: 263,
  punishment: 386, payback: 371, revenge: 279, hiddenPower: 237, weatherBall: 311, trumpCard: 376, smellingSalt: 265,
  wakeUpSlap: 358, bugBite: 450, block: 335,
  sheerCold: 329, iceBall: 301, curse: 174, brickBreak: 280, seismicToss: 69, superFang: 162, endeavor: 283, dragonRage: 82,
  metalBurst: 368, followMe: 266, roost: 355, synthesis: 235, acupressure: 367, assist: 274, thief: 168, snore: 173,
  psychUp: 244, lastResort: 387,
  // Species and plain hits (fire 75, ice 95, ghost 80, fighting 120, rock 100, grass 80, special 90, water 80, bug 80).
  plainStomp: 978, plainRoll: 974, plainFly: 973, plainQuake: 977, plainGust: 976, plainSurf: 975, spiritomb: 442, gengar: 94, charizard: 6, tropius: 357, plainFire: 980, plainIce: 981, plainGhost: 982, plainFighting: 983, plainRock: 984,
  plainGrass: 985, plainSpecial: 986, plainWater: 987, plainBug: 988,
  defog: 432, moonlight: 236,
} as const;

/** ROM ability IDs. */
export const ABILITY = {
  drizzle: 2, battleArmor: 4, sturdy: 5, cloudNine: 13, compoundEyes: 14, sereneGrace: 32, swiftSwim: 33, chlorophyll: 34,
  drought: 70, airLock: 76, simple: 86, skillLink: 92, quickFeet: 95, noGuard: 99, stall: 100, klutz: 103, superLuck: 105,
  slowStart: 112,
  static: 9, effectSpore: 27, poisonPoint: 38, earlyBird: 48, flameBody: 49, cuteCharm: 56, shedSkin: 61, magicGuard: 98,
  badDreams: 123,
  soundproof: 43, truant: 54,
  oblivious: 12, roughSkin: 24,
  damp: 6, intimidate: 22, wonderGuard: 25, levitate: 26, pressure: 46,
  unaware: 109,
  rivalry: 79,
  gluttony: 82, sandStream: 45, snowWarning: 117,
} as const;

/** ROM held-item IDs. */
export const ITEM = {
  custapBerry: 210, brightPowder: 213, machoBrace: 215, quickClaw: 217, scopeLens: 232, laxIncense: 255, wideLens: 265,
  zoomLens: 276, ironBall: 278, laggingTail: 279, choiceScarf: 287, fullIncense: 316,
  kingsRock: 221, focusBand: 230, leftovers: 234, gripClaw: 286, razorFang: 327,
  silkScarf: 251,
  lightBall: 236,
  ganlonBerry: 202, apicotBerry: 205, shoalSalt: 70, // the hack's pinch items with hold-effect parameter 0
  whiteHerb: 214, griseousOrb: 112,
  lightClay: 269, dampRock: 285,
  sitrusBerry: 158,
  oranBerry: 155, leppaBerry: 154, berryJuice: 43, liechiBerry: 201, jabocaBerry: 211, rowapBerry: 212, muscleBand: 266,
  icyRock: 282, smoothRock: 283, heatRock: 284, flamePlate: 298, splashPlate: 299, dreadPlate: 312,
  lavaCookie: 42, oldGateau: 54, shoalShell: 71,
} as const;

/** A known ROM ability, as `PlayerMon.ability` and `ResolvedMon.ability` hold one. */
export const knownAbility = (value: number) => ({ value, source: 'rom', disputed: false, alternatives: [] as number[] }) as const;

/**
 * The Ember turn: the player's Monferno (L30; Ember, Tackle) against the trainer's Zigzagoon (L20), single-type
 * neutral. Zigzagoon knows only `enemyMoves` (default Mean Look, which draws no chance), so with Mean Look the turn's
 * chances are Ember's alone: crit, damage roll and the 10% burn.
 */
export function emberTurn(enemyMoves: number[] = [ID.meanLook], playerFields: Partial<PlayerMon> = {}): BattleInput {
  return {
    player: [playerMon(ID.monferno, 30, [ID.ember, ID.tackle], playerFields)],
    trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, enemyMoves)]), field: {},
  };
}

/**
 * Ember's 16 damage values in the Ember turn, from @smogon/calc's Gen 4 formula on the fixture's exact Pokémon. Both
 * sides: Hardy, 31 IVs, no EVs.
 */
export function emberRolls(isCrit: boolean): number[] {
  const gen = Generations.get(4);
  const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const monferno = new CalcPokemon(gen, 'Monferno', {
    level: 30, nature: 'Hardy', ability: 'Blaze', ivs, evs,
    overrides: { baseStats: { hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, types: ['Fire', 'Fighting'] },
  });
  const zigzagoon = new CalcPokemon(gen, 'Zigzagoon', {
    level: 20, nature: 'Hardy', ability: 'Gluttony', ivs, evs,
    overrides: { baseStats: { hp: 38, atk: 30, def: 41, spa: 30, spd: 41, spe: 60 }, types: ['Normal'] },
  });
  const ember = new CalcMove(gen, 'Ember', { isCrit, overrides: { basePower: 40, type: 'Fire', category: 'Special' } });
  const damage = calculate(gen, monferno, zigzagoon, ember).damage;
  if (!Array.isArray(damage) || damage.length !== 16) throw new Error('Expected 16 damage rolls');
  return damage as number[];
}

/**
 * ROM trainers for the trainer-identity tests, by trainer index. Invented: raw u32 AI masks (the
 * second has the high bit set, to show the mask is kept unsigned).
 */
export const AI_TRAINER = { first: 8, second: 9 } as const;
export const AI_MASK = { first: 0x00000007, second: 0x80000041 } as const;
