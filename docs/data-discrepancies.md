# Where the ROM disagrees with the official docs and PKCalc

When the docs or PKCalc change: `npm run record:diffs`, review the diff, commit.
This file and `test/real/accepted-diffs.json` are written by `scripts/recordDiscrepancies.ts`; edit the explanations in `src/check/groups.ts`.

`npm run test:real` compares the player's ROM (`plat-kaizo-nightmare-update-final.nds`) with the official docs fetched at 2026-11-08T15:18:22.834Z: 507 species, 507 level-up learnsets, 470 moves, and the 2,101 Pokémon of 483 matches (474 docs trainers + 9 shared ROM copies).
Base stats, types and abilities agree apart from one docs typo (Fearow); six cat Pokémon have another growth rate; some learnsets and moves differ.
Most trainer differences are harmless (levels the docs never caught up with, the same moves in another order, docs spellings), and a short list are real changes.
The ROM's nature differs from the docs' on 327 Pokémon; the docs turn out to be stale there, and the planner uses the ROM's.

## How to read this

- Every difference is listed with both values in `test/real/accepted-diffs.json`, under a key `area/key/field`. The test fails when a difference appears, disappears or changes value, and when this file lacks a difference's group or has the wrong count.
- Trainer keys read `Split: Trainer [ROM index] mon N (species as the docs write it)`. Counts are differences (one per field), not trainers.
- PKCalc keys (areas `pkcalc-*`) read `Split: Trainer [ROM index]`, plus ` mon N (species as PKCalc names it)` for a set. The JSON names PKCalc's side `pkcalc` instead of `docs`.
- Damage-roll keys (area `calc`) read `Split: Trainer [ROM index] mon N (species) Move vs. Profile Llevel`, or `… hit by Profile Llevel Move`; there the `rom` side is our calc's 16 rolls and `pkcalc` is PKCalc's.
- Which side the planner uses: for trainer Pokémon, the ROM. Levels, species and forms, abilities, items and moves come from the ROM, and so does the nature wherever the decoder knows it (`natureKnown`); the docs' nature is used only where it does not. Every disagreement on a trainer is disputed, to be settled by in-game spot checks.
- For species, learnsets and moves the ROM is what the game reads. In the battle engine the docs win for move behaviour.
- Two mismatches were our own bugs, fixed with a failing test first: the docs parser missed the bare item "None" (Leader Fantina), and the trainer matcher paired the three SwimmerF Wang fights and one Gardenia Split rival copy with the wrong ROM trainers. Neither is listed here.

## Species (Personal tab): 7

Base stats, types, abilities and growth rate of each species. The game uses the ROM's values.

### Fearow's Sp. Atk, a docs typo (1)

The docs' own BST (472) only adds up with the ROM's 61.

| Key | ROM | Docs |
|---|---|---|
| `species/Fearow/spa` | 61 | 31 |

### Growth rates of the cat Pokémon (6)

The ROM gives all six cat Pokémon the Erratic rate; the docs still show the vanilla rate. The game uses the ROM's rate, and so does the save reader when it works out a boxed Pokémon's level from its experience.

| Key | ROM | Docs |
|---|---|---|
| `species/Meowth/growthRate` | Erratic | Medium Fast |
| `species/Persian/growthRate` | Erratic | Medium Fast |
| `species/Skitty/growthRate` | Erratic | Fast |
| `species/Delcatty/growthRate` | Erratic | Fast |
| `species/Glameow/growthRate` | Erratic | Fast |
| `species/Purugly/growthRate` | Erratic | Fast |

## Learnsets (Level-Up Learnsets tab): 29

### Level-up learnsets (29)

Each difference holds both whole learnsets in the JSON; the table says what differs. 478 of 507 learnsets agree exactly, so the decoder is sound: these look like late edits the docs never got, plus a few docs slips. The game uses the ROM's learnsets.

| Species | What differs |
|---|---|
| Pidgeot | ROM only: L22 Heat Wave; docs only: L22 Twister |
| Vulpix | ROM only: L68 Mystical Fire; docs only: L50 Mystical Fire, L68 Blast Burn |
| Diglett | docs only: L4 Dig |
| Psyduck | ROM only: L17 Disable; docs only: L18 Disable |
| Primeape | docs only: L47 Rage |
| Rhydon | ROM only: L100 Rock Wrecker |
| Tangela | ROM only: L52 Roar; docs only: L74 Frenzy Plant |
| Lapras | ROM only: L60 Roar, L70 Take Down |
| Bayleef | docs only: L54 Frenzy Plant |
| Lanturn | ROM only: L84 Thunderbolt |
| Magcargo | ROM only: L85 Magma Storm; docs only: L66 Magma Storm |
| Remoraid | docs only: L93 Hydro Cannon |
| Meditite | docs only: L100 Meditate |
| Roselia | ROM only: L1 Petal Dance; docs only: L1 Mega Drain |
| Trapinch | docs only: L57 Hyper Beam |
| Vibrava | ROM only: L65 Bug Buzz; docs only: L35 Bug Buzz |
| Anorith | ROM only: L1 Fury Cutter; docs only: L37 Fury Cutter |
| Armaldo | ROM only: L1 Fury Cutter; docs only: L37 Fury Cutter |
| Castform | ROM only: L30 Weather Ball, L70 Hurricane; docs only: L30 Water Ball |
| Registeel | docs only: L41 Selfdestruct |
| Wormadam | ROM only: L48 Synthesis |
| Mothim | ROM only: L35 Ominous Wind |
| Drifblim | docs only: L1 Water Ball |
| Chatot | ROM only: L50 Roar, L75 Chatter; docs only: L21 Chatter |
| Rhyperior | docs only: L100 Rock Wrecker |
| Tangrowth | ROM only: L55 Whirlwind, L55 Roar |
| Rotom | ROM only: L30 Teleport |
| Wormadam (S) | ROM only: L45 Earthquake |
| Wormadam (T) | docs only: L29 Metal Sound |

## Moves (Moves tab): 15

Power, type, accuracy, PP, priority, category and effect chance; effects are not compared, as the docs warn the game file shows some wrongly on purpose.

### Move data (15)

The docs' Moves tab (and its Move Changes tab, where it covers these moves) gives the docs' values; the ROM's move file holds the others. It is not a decoder slip: the other 460 moves agree on every field. The docs warn that some moves exported from the game deliberately show the wrong effect, and that may extend to these numbers; the files cannot tell. The spec has the docs win for move behaviour in the battle engine, while the trainer AI scores with what the ROM holds. An in-game spot check should confirm the odd ones, above all Constrict (255 power, Psychic, priority -1 in the ROM) and the PP values (Swords Dance has 2 PP in the ROM).

| Key | ROM | Docs |
|---|---|---|
| `move/Swords Dance/pp` | 2 | 30 |
| `move/Constrict/power` | 255 | 100 |
| `move/Constrict/type` | Psychic | Ice |
| `move/Constrict/priority` | -1 | 0 |
| `move/Hurricane/effectChance` | 30 | 10 |
| `move/Triple Axel/power` | 20 | 40 |
| `move/Triple Axel/accuracy` | 95 | 100 |
| `move/Substitute/pp` | 3 | 2 |
| `move/Triple Kick/accuracy` | 95 | 100 |
| `move/Spite/pp` | 3 | 10 |
| `move/Fury Cutter/power` | 20 | 30 |
| `move/Fury Cutter/accuracy` | 95 | 100 |
| `move/Ice Ball/pp` | 8 | 5 |
| `move/Rock Wrecker/power` | 30 | 40 |
| `move/Rock Wrecker/accuracy` | 90 | 100 |

## Trainers that matched nothing: 8 in the docs, 445 in the ROM

483 matches pair docs trainers with ROM trainers: 426 exact, 48 on species and forms but not levels, and 9 further ROM copies with a docs trainer's exact party. These docs trainers matched none (`docsOnly` in the JSON):

| Docs trainer | Why |
|---|---|
| Gardenia Split: Maid Yoki | No ROM trainer has her party (six Pokémon at level 67). |
| Byron Split: Pkmn Ranger Allison | The Byron Split lists these one-Pokémon Rangers again; their ROM trainers went to the Galactic Split's copies. |
| Byron Split: Pkmn Ranger Jeffery | The Byron Split lists these one-Pokémon Rangers again; their ROM trainers went to the Galactic Split's copies. |
| Byron Split: Pkmn Ranger Taylor | The Byron Split lists these one-Pokémon Rangers again; their ROM trainers went to the Galactic Split's copies. |
| Candice Split: Ace Trainer Blake | The docs list a Porygon; the ROM trainer has Porygon2. |
| Galactic Split: GalacticF Rosalind | Listed twice in the docs; the second listing (with level 1 placeholder Pokémon) has no ROM trainer left. |
| Galactic Split: Galactic Puck | Listed twice in the docs; the second listing (with level 1 placeholder Pokémon) has no ROM trainer left. |
| Galactic Split: GalacticF Laomedeia | The docs list 3 Pokémon; the ROM trainer has 4. |

The other way round, 445 ROM trainers match no docs trainer: rematches, unused entries, and copies the docs leave out (such as a rival's team for another starter or player gender). The test pins their indexes (`romOnly` in the JSON) rather than explaining each one.

## Trainer levels: 195

### Levels on level-mismatch matches (195)

These docs trainers fit a ROM trainer on species and forms but not on levels, so they were matched without levels. The game uses the ROM's levels. Most are late-game Galactic and Elite Four Split trainers, one to ten levels apart: the docs predate a level rebalance, as their natures confirm (see the natures).

| Trainer | Pokémon: ROM level (docs level) |
|---|---|
| Roark Split: School KidfChristine [ROM 345] | 1 Sandshrew: 1 (5) |
| Gardenia Split: Trainer Dawn/Lucas [ROM 613] | 5 Chimchar: 15 (16); 6 Piplup: 15 (16) |
| Gardenia Split: Trainer Dawn/Lucas [ROM 614] | 4 Turtwig: 15 (16); 6 Piplup: 15 (16) |
| Gardenia Split: Trainer Dawn/Lucas [ROM 618] | 4 Turtwig: 15 (16); 6 Prinplup: 15 (16) |
| Wake Split: Collector Ripper [ROM 272] | 1 Umbreon: 47 (46); 2 Espeon: 49 (48); 3 Vaporeon: 47 (46); 4 Glaceon: 47 (46); 5 Jolteon: 47 (46); 6 Leafeon: 47 (46) |
| Byron Split: Policeman Bobby [ROM 88] | 1 Grumpig: 57 (56) |
| Byron Split: Lady Celeste [ROM 893] | 1 Jumpluff: 60 (56) |
| Byron Split: Waiter Doppio [ROM 897] | 1 Bronzor: 57 (56) |
| Byron Split: Maid Mocha [ROM 898] | 1 Mismagius: 62 (55) |
| Byron Split: GalacticF Luna [ROM 66] | 6 Lunatone: 50 (51) |
| Byron Split: Leader Cyrus [ROM 913] | 5 Salamence: 55 (54) |
| Byron Split: Worker Dillan [ROM 844] | 1 Skarmory: 98 (96); 2 Machamp: 96 (91); 3 Charizard: 95 (90); 4 Aggron: 96 (92); 5 Camerupt: 97 (87) |
| Byron Split: Worker Conrad [ROM 846] | 1 Houndoom: 94 (87); 2 Rotom: 95 (90); 3 Blastoise: 96 (90); 4 Toxicroak: 96 (90); 5 Lucario: 95 (88) |
| Byron Split: GalacticF Galatea [ROM 505] | 1 Clefable: 55 (56); 2 Gardevoir: 54 (57); 3 Togekiss: 54 (57); 4 Miltank: 55 (56) |
| Byron Split: Galactic Hippocamp [ROM 457] | 1 Hippowdon: 55 (57); 4 Starmie: 55 (57) |
| Byron Split: Galactic Psamanthe [ROM 506] | 1 Probopass: 55 (57); 2 Cacturne: 56 (58); 3 Garchomp: 55 (56) |
| Byron Split: Galactic Sao [ROM 305] | 1 Tropius: 55 (57); 2 Cherrim: 57 (58); 3 Rapidash: 54 (56); 4 Girafarig: 55 (57) |
| Byron Split: Galactic Neso [ROM 289] | 1 Camerupt: 55 (57); 2 Exeggutor: 54 (56); 3 Solrock: 55 (57); 4 Castform: 56 (57) |
| Byron Split: GalacticF Halimede [ROM 446] | 1 Vespiquen: 54 (56); 2 Rampardos: 53 (57); 3 Slowking: 55 (56); 4 Dusknoir: 53 (57) |
| Byron Split: Galactic Naid [ROM 379] | 1 Dragonair: 56 (57); 2 Ludicolo: 55 (56); 3 Surskit: 55 (57); 4 Whiscash: 55 (57) |
| Byron Split: GalacticF Nereid [ROM 378] | 1 Qwilfish: 55 (57); 2 Dewgong: 56 (57); 3 Huntail: 55 (56); 4 Gorebyss: 55 (56) |
| Byron Split: Galactic Triton [ROM 835] | 1 Seaking: 57 (58); 2 Kingdra: 56 (57); 3 Kingler: 57 (58); 4 Empoleon: 57 (58) |
| Byron Split: Galactic Neptune [ROM 836] | 2 Lapras: 58 (59); 3 Swampert: 57 (58); 4 Relicanth: 60 (61) |
| Candice Split: Ace Trainer Tenzing [ROM 828] | 1 Glalie: 72 (71); 2 Walrein: 71 (70); 3 Alakazam: 70 (69); 4 Rotom-Frost: 73 (72); 5 Tyranitar: 70 (69) |
| Galactic Split: Galactic Prospero [ROM 550] | 2 Rampardos: 86 (84); 3 Tangrowth: 87 (86); 4 Gallade: 90 (88); 5 Charizard: 88 (86); 6 Dusknoir: 88 (85) |
| Galactic Split: GalacticfUranus [ROM 560] | 1 Articuno: 91 (86); 2 Cloyster: 94 (88); 3 Suicune: 92 (87); 4 Steelix: 92 (86); 5 Gardevoir: 93 (91); 6 Glaceon: 93 (85) |
| Galactic Split: Leader Cyrus [ROM 403] | 1 Deoxys-Defense: 92 (95); 2 Rampardos: 94 (98); 3 Heatran: 94 (95); 4 Registeel: 95 (96); 5 Dusknoir: 96 (97); 6 Regigigas: 93 (94) |
| Galactic Split: Galactic Io [ROM 653] | 1 Camerupt: 86 (90); 2 Miltank: 88 (92); 3 Drapion: 87 (90); 4 Salamence: 86 (89); 5 PorygonZ: 87 (91); 6 Magmortar: 87 (92) |
| Galactic Split: Commander Saturn [ROM 409] | 1 Uxie: 92 (94); 2 Zapdos: 92 (94); 3 Metagross: 93 (95); 4 Rhydon: 95 (97); 5 Wailord: 93 (100) |
| Galactic Split: GalacticfSquad Deimos [ROM 533] | 1 Smeargle: 87 (92); 2 Hypno: 87 (92); 3 Houndoom: 87 (92); 4 Spiritomb: 88 (92); 5 Vileplume: 89 (93); 6 Dugtrio: 89 (93) |
| Galactic Split: Galactic Oberon [ROM 582] | 1 Slaking: 92 (90); 2 Tyranitar: 91 (87); 3 Walrein: 89 (87); 4 Breloom: 90 (86); 5 Lucario: 90 (86); 6 Raichu: 89 (87) |
| Galactic Split: GalacticF Titania [ROM 583] | 2 Altaria: 88 (86); 3 Xatu: 90 (87); 4 Jumpluff: 92 (88); 5 Celebi: 93 (90); 6 Yanmega: 90 (85) |
| Galactic Split: GalacticF Terra [ROM 562] | 1 Blastoise: 88 (85); 2 Dunsparce: 87 (85); 3 Blaziken: 88 (84); 4 Torterra: 92 (87); 5 Luxray: 89 (84); 6 Metagross: 87 (80) |
| Galactic Split: Galactic Luna [ROM 572] | 2 Drifblim: 87 (84); 3 Crobat: 87 (85); 4 Skarmory: 87 (84); 5 Salamence: 88 (82); 6 Lunatone: 90 (88) |
| Galactic Split: Galactic Prospero [ROM 526] | 6 Ninetales: 92 (91) |
| Galactic Split: Galactic Neptune [ROM 581] | 1 Empoleon: 90 (86); 2 Swampert: 91 (86); 3 Feraligatr: 90 (89); 4 Metagross: 89 (84); 5 Lapras: 92 (90); 6 Wailord: 88 (85) |
| Galactic Split: Galactic Triton [ROM 606] | 1 Zapdos: 90 (86); 2 Dragonite: 89 (85); 3 Magneton: 89 (85); 4 Rotom-Wash: 90 (84); 5 Mantine: 90 (84); 6 Gyarados: 90 (84) |
| Galactic Split: Commander Mars [ROM 528] | 1 Garchomp: 92 (95); 2 Aerodactyl: 92 (96); 3 Swampert: 93 (96); 4 Jirachi: 92 (95); 5 Ninetales: 95 (97); 6 Latias: 93 (94) |
| Galactic Split: Commander Jupiter [ROM 407] | 1 Gyarados: 92 (95); 2 Tangrowth: 95 (97); 3 Magnezone: 92 (95); 4 Tyranitar: 93 (96); 5 Regirock: 92 (95); 6 Latios: 92 (94) |
| Galactic Split: Cyrus [ROM 404] | 1 Palkia: 97 (100); 2 Dialga: 97 (100); 3 Deoxys-Attack: 95 (100); 4 Weavile: 98 (100); 5 Heatran: 95 (100); 6 Regigigas: 96 (100) |
| Elite Four Split: Roughneck Wyatt [ROM 234] | 1 Mamoswine: 91 (90); 2 Salamence: 90 (89); 3 Kingdra: 92 (91); 5 Infernape: 91 (89); 6 Umbreon: 93 (92) |
| Elite Four Split: Blackbelt Roku [ROM 226] | 3 Honchkrow: 91 (90); 5 Tyranitar: 91 (89) |
| Elite Four Split: Beauty Jasmine ❤ [ROM 222] | 1 Metagross: 91 (89); 2 Ninetales: 92 (91); 3 Snorlax: 92 (90); 4 Lanturn: 93 (92); 6 Mismagius: 93 (91) |
| Elite Four Split: Hiker J.J Ahern [ROM 237] | 1 Raichu: 96 (95); 2 Snorlax: 92 (90); 3 Gengar: 92 (91); 4 Aerodactyl: 92 (90); 5 Blastoise: 92 (91); 6 Charizard: 92 (91) |
| Elite Four Split: Bug Catcher Ford [ROM 235] | 1 Jolteon: 93 (91); 2 Snorlax: 94 (91); 3 Starmie: 95 (93); 4 Slowbro: 96 (95); 5 Dugtrio: 94 (92); 6 Aerodactyl: 94 (92) |
| Elite Four Split: Ruin Maniac Greg [ROM 230] | 1 Hippowdon: 93 (91); 2 Tangrowth: 95 (89); 3 Spiritomb: 92 (90); 4 Slowking: 91 (88); 5 Wobbuffet: 92 (90) |
| Elite Four Split: Idol Zoe, the best trainer in the game, best idol, and the hardest trainer you will ever face. [ROM 236] | 1 Piloswine: 95 (91); 2 Yanma: 95 (90); 3 Girafarig: 95 (91) |
| Elite Four Split: Dragon Tamer Clinton [ROM 231] | 1 Salamence: 94 (91); 2 Espeon: 95 (94); 3 Muk: 97 (96); 4 Dragonite: 95 (92); 5 Jynx: 95 (92); 6 Tropius: 96 (92) |

## Trainer species and forms: 9

Compared as one resolved species-and-form name. The docs write the bare species name where the ROM sets a form.

### Forms that change nothing for the planner (8)

Shellos and Gastrodon East (looks only), Castform Rainy (a weather form) and Unown letters.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Wake Split: Tuber Jared [ROM 107] mon 2 (Shellos)/species` | Shellos-East | Shellos |
| `trainer/Wake Split: Pkmn Ranger Erick [ROM 293] mon 2 (Gastrodon)/species` | Gastrodon-East | Gastrodon |
| `trainer/Byron Split: Galactic Squad Leda [ROM 75] mon 5 (Gastrodon)/species` | Gastrodon-East | Gastrodon |
| `trainer/Candice Split: Galactic Pan [ROM 399] mon 3 (Gastrodon)/species` | Gastrodon-East | Gastrodon |
| `trainer/Candice Split: Skier Madison [ROM 144] mon 1 (Castform)/species` | Castform-Rainy | Castform |
| `trainer/Candice Split: Skier Mirabelle [ROM 268] mon 3 (Castform)/species` | Castform-Rainy | Castform |
| `trainer/Galactic Split: Galactic Skymir [ROM 646] mon 1 (Unown)/species` | Unown-G | Unown |
| `trainer/Elite Four Split: Idol Zoe, the best trainer in the game, best idol, and the hardest trainer you will ever face. [ROM 236] mon 4 (Unown)/species` | Unown-Z | Unown |

### Worker Conrad's Rotom-Wash (1)

Rotom-Wash is form 2, with its own Personal row (504). In this hack's Personal tab it has the same types (Electric/Ghost) and base stats as Rotom. The planner uses the ROM's form.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Byron Split: Worker Conrad [ROM 846] mon 2 (Rotom)/species` | Rotom-Wash | Rotom |

## Trainer abilities: 13

Every difference here is disputed and the planner uses the ROM's ability until an in-game spot check settles it.

### Docs slips (3)

Cyrus's Giratina-Origin has a blank ability in the docs; its own Personal row (501) gives Levitate. Dragon Tamer Clinton's Espeon has the typo "Syncronize". Champion Cynthia's Shaymin-Sky gets the Land Forme's Natural Cure; the Sky Forme row (502) has Serene Grace only.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Galactic Split: CYRUS [ROM 780] mon 1 (GIRATINA-ORIGIN)/ability` | Levitate | (blank) |
| `trainer/Elite Four Split: Dragon Tamer Clinton [ROM 231] mon 2 (Espeon)/ability` | Synchronize | Syncronize |
| `trainer/Elite Four Split: Champion Cynthia [ROM 870] mon 3 (Shaymin-Sky)/ability` | Serene Grace | Natural Cure |

### Ability overrides the docs contradict (3)

The ROM's override byte (1 for the first ability, 2 for the second) sets these abilities, and all three are Garchomps on which the docs give the other one. The mapping itself is confirmed: over the 104 overridden Pokémon on matched trainers it gives the docs' ability for 101, against 40 with 1 and 2 swapped. Counting only the 67 whose species has two different abilities, that is 64 against 3. Garchomp's abilities are the same in the docs' Personal tab and the ROM (Sand Veil, then Rough Skin), so that is not the cause. The docs may be out of date for these fights; Commander Mars's Galactic Split fight is a level-mismatch match.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Candice Split: Commander Mars [ROM 405] mon 2 (Garchomp)/ability` | Sand Veil | Rough Skin |
| `trainer/Galactic Split: Commander Mars [ROM 528] mon 1 (Garchomp)/ability` | Rough Skin | Sand Veil |
| `trainer/Elite Four Split: Elite Four Bertha [ROM 867] mon 4 (Garchomp)/ability` | Sand Veil | Rough Skin |

### Second abilities in the docs where the plain rule gives the first (4)

No override and a known nature, so the ROM's ability comes from the plain-rule PID. That PID is always even, so it always picks the first ability; the docs give the second.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Galactic Split: GalacticfUranus [ROM 560] mon 1 (Articuno)/ability` | Snow Cloak | Snow Warning |
| `trainer/Galactic Split: GalacticfUranus [ROM 560] mon 4 (Steelix)/ability` | Solid Rock | Rock Head |
| `trainer/Galactic Split: GalacticfUranus [ROM 560] mon 6 (Glaceon)/ability` | Snow Cloak | Ice Body |
| `trainer/Galactic Split: GalacticF Cressida [ROM 511] mon 3 (Ursaring)/ability` | Guts | Quick Feet |

### Abilities picked by an untrusted PID (3)

No override and two abilities to choose from, so the PID's lowest bit picks one, but these Pokémon's PIDs are untrusted (`natureKnown` is false: an override comes earlier in the party). The ROM side is the plain-rule pick, the first ability. Pinned under the field `ability-cross-check`, like the natures.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Volkner Split: Psychic Destiny [ROM 285] mon 3 (Jolteon)/ability-cross-check` | Static | Rough Skin |
| `trainer/Galactic Split: GalacticfTethys [ROM 638] mon 2 (Whiscash)/ability-cross-check` | Hydration | Swift Swim |
| `trainer/Galactic Split: Commander Jupiter [ROM 407] mon 5 (Regirock)/ability-cross-check` | Solid Rock | Clear Body |

## Trainer items: 41

The planner uses the ROM's items.

### Items with no name yet (23)

The ROM's item ID is fine, but `@pkmn/dex` names only Gen 4 battle items, so these print as "(item N)" until a Gen 4 item table is added. Items 70 and 71 are the hack's Berserk Gene and RageCandyBar, which do matter in battle. Galactic Triton's "Beserk Gene" is also a docs typo.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Gardenia Split: Picnicker Karina [ROM 456] mon 3 (Spoink)/item` | (item 89) | Big Pearl |
| `trainer/Gardenia Split: Trainer Cheryl [ROM 608] mon 6 (Happiny)/item` | (item 231) | Lucky Egg |
| `trainer/Wake Split: Beauty Chelle [ROM 491] mon 6 (Meganium)/item` | (item 42) | Lava Cookie |
| `trainer/Volkner Split: Rich Boy Trey [ROM 335] mon 1 (Charizard)/item` | (item 92) | Big Nugget |
| `trainer/Volkner Split: Rich Boy Trey [ROM 335] mon 2 (Shiftry)/item` | (item 92) | Big Nugget |
| `trainer/Volkner Split: Rich Boy Trey [ROM 335] mon 3 (Grumpig)/item` | (item 92) | Big Nugget |
| `trainer/Galactic Split: Sis and Bro Dora & Diego [ROM 166] mon 2 (Floatzel)/item` | (item 450) | Bicycle |
| `trainer/Galactic Split: Sis and Bro Dora & Diego [ROM 166] mon 3 (Gengar)/item` | (item 442) | Town Map |
| `trainer/Galactic Split: Sis and Bro Dora & Diego [ROM 166] mon 5 (Vulpix)/item` | (item 261) | Blue Scarf |
| `trainer/Galactic Split: Mira [ROM 612] mon 1 (Kadabra)/item` | (item 262) | Pink Scarf |
| `trainer/Galactic Split: Clown Bob [ROM 383] mon 3 (Primeape)/item` | (item 92) | Big Nugget |
| `trainer/Galactic Split: GalacticfRosalind [ROM 509] mon 3 (Staraptor)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: Galactic Prometheus [ROM 629] mon 2 (Ursaring)/item` | (item 71) | RageCandyBar |
| `trainer/Galactic Split: Galactic Iapetus [ROM 569] mon 2 (Probopass)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: Leader Cyrus [ROM 403] mon 2 (Rampardos)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: Leader Cyrus [ROM 403] mon 5 (Dusknoir)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: Galactic Luna [ROM 572] mon 2 (Drifblim)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: GalacticF Angrboda [ROM 650] mon 1 (Wigglytuff)/item` | (item 71) | RageCandyBar |
| `trainer/Galactic Split: Galactic Neptune [ROM 581] mon 3 (Feraligatr)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: Galactic Triton [ROM 606] mon 6 (Gyarados)/item` | (item 70) | Beserk Gene |
| `trainer/Galactic Split: Commander Jupiter [ROM 407] mon 4 (Tyranitar)/item` | (item 70) | Berserk Gene |
| `trainer/Galactic Split: Cyrus [ROM 404] mon 4 (Weavile)/item` | (item 70) | Berserk Gene |
| `trainer/Elite Four Split: Idol Zoe, the best trainer in the game, best idol, and the hardest trainer you will ever face. [ROM 236] mon 6 (Buneary)/item` | (item 262) | Pink Scarf |

### Docs spellings of items (7)

The same item: "Leek" is the Gen 8 name for Stick, and "Lax Inscence" and "Jacoba Berry" are typos.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Fantina Split: Psychic Cheyenne [ROM 330] mon 4 (Haunter)/item` | Lax Incense | Lax Inscence |
| `trainer/Maylene Split: Pkmn BreederF Jennifer [ROM 47] mon 3 (Farfetchd)/item` | Stick | Leek |
| `trainer/Maylene Split: BirdKeeper Kahlil [ROM 56] mon 1 (Farfetchd)/item` | Stick | Leek |
| `trainer/Candice Split: Blackbelt Philip [ROM 258] mon 4 (Farfetchd)/item` | Stick | Leek |
| `trainer/Candice Split: Blackbelt Luke [ROM 148] mon 1 (Farfetchd)/item` | Stick | Leek |
| `trainer/Galactic Split: GalacticfAriel [ROM 553] mon 3 (Blissey)/item` | Jaboca Berry | Jacoba Berry |
| `trainer/Galactic Split: GalacticF Bebhionn [ROM 641] mon 1 (Vaporeon)/item` | Jaboca Berry | Jacoba Berry |

### Items on second ROM copies of a team (1)

Each Pokémon here is on a further ROM trainer with a docs trainer's exact party, and holds another item than the first copy's Pokémon in the same slot. The docs list one team for both copies, so they can agree with only one. The planner uses each copy's own item.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Elite Four Split: Elite Four Flint [ROM 874] mon 6 (Magmortar)/item` | Life Orb | Charcoal |

### Gambler John Keating's last three Pokémon: items (3)

The docs give his Staraptor, Kingler and Magmortar (Pokémon 4 to 6) other items than the ROM, and other moves too (see the trainer moves); his first three Pokémon agree with the docs. PKCalc has the ROM's items and moves for all three, which points to the docs being out of date for this team. The planner uses the ROM's.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Maylene Split: Gambler John Keating [ROM 228] mon 4 (Staraptor)/item` | Focus Band | Flame Plate |
| `trainer/Maylene Split: Gambler John Keating [ROM 228] mon 5 (Kingler)/item` | Quick Claw | Berserk Gene |
| `trainer/Maylene Split: Gambler John Keating [ROM 228] mon 6 (Magmortar)/item` | Flame Plate | Charcoal |

### Different items, cause unknown (7)

A real difference between the ROM and the docs that no group above explains, with no known cause. The planner uses the ROM's item; each is a candidate for an in-game spot check.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Galactic Split: Pkmn Ranger Jeffrey [ROM 96] mon 1 (Primeape)/item` | Choice Scarf | Choice Band |
| `trainer/Galactic Split: Galactic Ganymede [ROM 524] mon 1 (Steelix)/item` | Iron Ball | Focus Band |
| `trainer/Galactic Split: Galactic Ganymede [ROM 524] mon 3 (Magneton)/item` | Iron Ball | Focus Band |
| `trainer/Galactic Split: GalacticfHalimede [ROM 523] mon 3 (Rampardos)/item` | Life Orb | Focus Band |
| `trainer/Galactic Split: GalacticF Cordelia [ROM 514] mon 5 (Swampert)/item` | Leftovers | Wide Lens |
| `trainer/Galactic Split: Commander Jupiter [ROM 407] mon 3 (Magnezone)/item` | Chople Berry | Shuca Berry |
| `trainer/Elite Four Split: Barry #6 [ROM 479] mon 5 (Blaziken)/item` | White Herb | Expert Belt |

## Trainer moves: 108

Moves are compared by ID. The planner uses the ROM's moves and their order.

### SolarBeam or Solar-Beam (19)

The hack has two moves: SolarBeam (76, with a charging turn) and Solar-Beam (130, no charge, 15 PP). The docs' team tabs write "Solar-Beam" for both: of the docs' "Solar-Beam" Pokémon, 30 have move 130 in the ROM and 19 have move 76. In battle that is a charging turn or none.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Gardenia Split: Galactic Mercury [ROM 202] mon 3 (Nuzleaf)/moves` | SolarBeam, Dark Pulse, Selfdestruct, Fake Out | Solar-Beam, Dark Pulse, SelfDestruct, Fake Out |
| `trainer/Maylene Split: Jogger Wyatt [ROM 306] mon 2 (Arcanine)/moves` | Will-O-Wisp, Morning Sun, SolarBeam, Toxic | Will-O-Wisp, Morning Sun, Solar-Beam, Toxic |
| `trainer/Maylene Split: Pkmn Breeder Johnny [ROM 57] mon 2 (Magmar)/moves` | SolarBeam, Milk Drink, Magma Storm, Cross Chop | Solar-Beam, Milk Drink, Magma Storm, Cross Chop |
| `trainer/Byron Split: Galactic Io [ROM 847] mon 2 (Exeggutor)/moves` | Explosion, Sleep Powder, SolarBeam, Psychic | Explosion, Sleep Powder, Solar-Beam, Psychic |
| `trainer/Byron Split: Galactic Io [ROM 847] mon 5 (Magmortar)/moves` | Fire Blast, SolarBeam, Thunderbolt, HP Rock | Fire Blast, Solar-Beam, Thunderbolt, HP Rock |
| `trainer/Candice Split: Galactic Atlas [ROM 499] mon 3 (Exeggutor)/moves` | Explosion, SolarBeam, Psychic, Sleep Powder | Explosion, Solar-Beam, Psychic, Sleep Powder |
| `trainer/Candice Split: Galactic Hyperion [ROM 288] mon 2 (Charizard)/moves` | Heat Wave, Air Slash, Focus Blast, SolarBeam | Heat Wave, Air Slash, Focus Blast, Solar-Beam |
| `trainer/Volkner Split: Sailor Jack [ROM 337] mon 2 (Tropius)/moves` | SolarBeam, Air Slash, Twister, Weather Ball | Solar-Beam, Air Slash, Twister, Weather Ball |
| `trainer/Volkner Split: TuberF Holly [ROM 361] mon 1 (Remoraid)/moves` | Zap Cannon, SolarBeam, Fire Blast, Hyper Beam | Zap Cannon, Solar-Beam, Fire Blast, Hyper Beam |
| `trainer/Galactic Split: Galactic Prospero [ROM 550] mon 1 (Magcargo)/moves` | Stealth Rock, Memento, Magma Storm, SolarBeam | Stealth Rock, Memento, Magma Storm, Solar-Beam |
| `trainer/Galactic Split: Galactic Hyperion [ROM 628] mon 3 (Sunflora)/moves` | SolarBeam, Fire Ball, Earth Power, HP Ice | Solar-Beam, Fire Ball, Earth Power, HP Ice |
| `trainer/Galactic Split: Galactic Atlas [ROM 568] mon 4 (Tangrowth)/moves` | Seismic Toss, SolarBeam, Endure, Sleep Powder | Seismic Toss, Solar-Beam, Endure, Sleep Powder |
| `trainer/Galactic Split: Galactic Io [ROM 653] mon 6 (Magmortar)/moves` | Lava Plume, Thunderbolt, Earthquake, SolarBeam | Lava Plume, Thunderbolt, Earthquake, Solar-Beam |
| `trainer/Galactic Split: GalacticfSquad Deimos [ROM 533] mon 3 (Houndoom)/moves` | Fire Blast, Destiny Bond, SolarBeam, Dark Pulse | Fire Blast, Destiny Bond, Solar-Beam, Dark Pulse |
| `trainer/Galactic Split: GalacticfSquad Deimos [ROM 533] mon 5 (Vileplume)/moves` | Sleep Powder, Fire Ball, SolarBeam, HP Ground | Sleep Powder, Fire Ball, Solar-Beam, HP Ground |
| `trainer/Galactic Split: GalacticfDespina [ROM 507] mon 2 (Rapidash)/moves` | SolarBeam, Hypnosis, Hail Ball, Stomp | Solar-Beam, Hypnosis, Hail Ball, Stomp |
| `trainer/Elite Four Split: Elite Four Flint [ROM 868] mon 4 (Houndoom)/moves` | Fire Blast, Sucker Punch, SolarBeam, Dark Pulse | Fire Blast, Sucker Punch, Solar-Beam, Dark Pulse |
| `trainer/Elite Four Split: Elite Four Flint [ROM 874] mon 3 (Exeggutor)/moves` | Explosion, SolarBeam, AncientPower, Morning Sun | Explosion, Solar-Beam, AncientPower, Morning Sun |
| `trainer/Elite Four Split: Elite Four Flint [ROM 874] mon 4 (Houndoom)/moves` | Fire Blast, Sucker Punch, SolarBeam, Dark Pulse | Fire Blast, Sucker Punch, Solar-Beam, Dark Pulse |

### Docs spellings of moves (6)

The same move under another name: "HP Dark" for Hidden Power (trainer IVs of 31 make it Dark-type), "SmellingSalts", "Weather Ball Fire" for the hack's Fire Ball, "Accelerock" for the hack's Rollout (a 40-power Rock move with +1 priority), "Weather Ball" for Hail Ball, and "Water Ball" for Castform's Weather Ball.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Roark Split: Bug Catcher Sebastian [ROM 356] mon 1 (Burmy-Sandy)/moves` | Hidden Power, Protect, Snore, Bug Bite | HP Dark, Protect, Snore, Bug Bite |
| `trainer/Roark Split: Worker Colin [ROM 195] mon 4 (Machop)/moves` | SmellingSalt, Fire Punch, Low Kick, Rock Throw | SmellingSalts, Fire Punch, Low Kick, Rock Throw |
| `trainer/Gardenia Split: Aroma Lady Jenna [ROM 259] mon 3 (Weepinbell)/moves` | Sleep Powder, Fire Ball, Power Whip, Sucker Punch | Sleep Powder, Weather Ball Fire, Power Whip, Sucker Punch |
| `trainer/Byron Split: GalacticF Terra [ROM 67] mon 6 (Castform)/moves` | Weather Ball, Shock Wave, Aurora Beam, Water Pulse | Water Ball, Shock Wave, Aurora Beam, Water Pulse |
| `trainer/Galactic Split: GalacticF Titania [ROM 583] mon 3 (Xatu)/moves` | Hail Ball, Psycho Boost, Future Sight, U-turn | Weather Ball, Psycho Boost, Future Sight, U-Turn |
| `trainer/Elite Four Split: Blackbelt Roku [ROM 226] mon 5 (Tyranitar)/moves` | Rollout, Pursuit, Superpower, Avalanche | Accelerock, Pursuit, Superpower, Avalanche |

### Moves on second ROM copies of a team (1)

Each Pokémon here is on a further ROM trainer with a docs trainer's exact party, and has other moves than the first copy's Pokémon in the same slot, not just another order. The docs list one team for both copies, so they can agree with only one. The planner uses each copy's own moves.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Roark Split: School Kid Harrison [ROM 501] mon 1 (Vulpix)/moves` | Will-O-Wisp | Will-O-Wisp, Toxic, Hypnosis, Thunder Wave |

### Gambler John Keating's last three Pokémon: moves (3)

His Staraptor, Kingler and Magmortar (Pokémon 4 to 6) have moves the docs do not list, and their items differ too (see the trainer items); his first three Pokémon agree with the docs. PKCalc has the ROM's moves and items for all three, which points to the docs being out of date for this team. The planner uses the ROM's.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Maylene Split: Gambler John Keating [ROM 228] mon 4 (Staraptor)/moves` | Sky Attack, Double Team, Tailwind, Blaze Kick | Brave Bird, Double Team, Tailwind, Blaze Kick |
| `trainer/Maylene Split: Gambler John Keating [ROM 228] mon 5 (Kingler)/moves` | Crabhammer, Giga Impact, Fury Cutter, ViceGrip | Agility, ViceGrip, X-Scissor, Metal Claw |
| `trainer/Maylene Split: Gambler John Keating [ROM 228] mon 6 (Magmortar)/moves` | Milk Drink, Magma Storm, Hyper Beam, Metronome | Milk Drink, Mystical Fire, Hyper Beam, Metronome |

### Different moves, cause unknown (6)

A real difference between the ROM and the docs that no group above explains, with no known cause. The planner uses the ROM's moves; each is a candidate for an in-game spot check.

| Key | ROM | Docs |
|---|---|---|
| `trainer/Gardenia Split: Trainer Dawn/Lucas [ROM 613] mon 5 (Chimchar)/moves` | Fake Out, Mach Punch, Fire Punch | Ember, Karate Chop, Fire Punch |
| `trainer/Byron Split: Lady Celeste [ROM 893] mon 1 (Jumpluff)/moves` | Memento, Sleep Powder, Leech Seed, Protect | Memento, Substitute, Sleep Powder, Protect |
| `trainer/Candice Split: Commander Mars [ROM 405] mon 5 (Ninetales)/moves` | Blast Burn, Energy Ball, Memento, Rock Ball | Blast Burn, Energy Ball, Memento, Water Ball |
| `trainer/Galactic Split: Pkmn Ranger Jeffrey [ROM 96] mon 1 (Primeape)/moves` | Superpower, Gunk Shot, Earthquake, Shadow Claw | Close Combat, Gunk Shot, Earthquake, Shadow Claw |
| `trainer/Galactic Split: Pkmn Ranger Jeffrey [ROM 95] mon 1 (Arcanine)/moves` | Outrage, Flare Blitz, Earthquake, Superpower | Outrage, Flare Blitz, Bulldoze, Superpower |
| `trainer/Galactic Split: Leader Cyrus [ROM 403] mon 1 (Deoxys-Defense)/moves` | Spikes, Low Kick, Recover, Psycho Boost | Spikes, Future Sight, Recover, Psycho Boost |

### Same moves in another order (73)

The ROM holds the same moves as the docs, in other slots (field `move-order`). Mostly Elite Four Split trainers.

- Roark Split: Lass Natalie [ROM 3]: mon 2
- Roark Split: Clown Ronald [ROM 252]: mon 1
- Roark Split: Clown Ronald [ROM 255]: mon 1
- Roark Split: School Kid Harrison [ROM 342]: mon 1
- Fantina Split: Policeman Kevin [ROM 36]: mon 4
- Byron Split: Galactic Neptune [ROM 836]: mon 1
- Candice Split: GalacticF Pandora [ROM 394]: mon 2
- Candice Split: GalacticF Rhea [ROM 418]: mon 4
- Volkner Split: Rich Boy Trey [ROM 335]: mon 1
- Galactic Split: Pkmn Ranger Taylor [ROM 94]: mon 1
- Galactic Split: GalacticF Titania [ROM 583]: mon 1
- Elite Four Split: SwimmerF Miranda [ROM 189]: mon 1, 2, 3, 4
- Elite Four Split: SwimmerF Aubree [ROM 190]: mon 1, 3
- Elite Four Split: SwimmerF Paige [ROM 191]: mon 1
- Elite Four Split: Swimmer Wesley [ROM 183]: mon 2, 3, 4
- Elite Four Split: Sailor Zachariah [ROM 482]: mon 1, 3, 4
- Elite Four Split: Swimmer Francisco [ROM 185]: mon 3
- Elite Four Split: Cameraman Matt [ROM 233]: mon 1, 3, 4, 5, 6
- Elite Four Split: Roughneck Wyatt [ROM 234]: mon 6
- Elite Four Split: Blackbelt Roku [ROM 226]: mon 2, 6
- Elite Four Split: Beauty Jasmine ❤ [ROM 222]: mon 1, 2, 3, 4
- Elite Four Split: Aroma Lady Fadel [ROM 224]: mon 1, 2, 3, 5
- Elite Four Split: Clown Julia [ROM 229]: mon 1, 3
- Elite Four Split: Hiker J.J Ahern [ROM 237]: mon 1, 3
- Elite Four Split: Ruin Maniac Greg [ROM 230]: mon 1, 2, 3, 4, 5, 6
- Elite Four Split: Idol Zoe, the best trainer in the game, best idol, and the hardest trainer you will ever face. [ROM 236]: mon 1, 2, 3, 5
- Elite Four Split: Dragon Tamer Clinton [ROM 231]: mon 2, 3, 5
- Elite Four Split: Sinister Hooded Figure - [ROM 666]: mon 1, 2, 3, 5
- Elite Four Split: Barry #6 [ROM 481]: mon 1
- Elite Four Split: Barry #6 [ROM 479]: mon 1
- Elite Four Split: Barry #6 [ROM 480]: mon 1
- Elite Four Split: Elite Four Aaron [ROM 866]: mon 1, 3
- Elite Four Split: Elite Four Bertha [ROM 867]: mon 1, 3
- Elite Four Split: Elite Four Lucian [ROM 869]: mon 1, 2, 3, 5

## Trainer natures (cross-check): 327

A trainer Pokémon's nature comes from the ROM's plain Gen 4 rule (a PID from the trainer's index and class and the Pokémon's IVs, level and species) wherever the decoder knows it, that is where `natureKnown` holds: no gender or ability override earlier in the party. The docs' nature is used only where it does not. Every difference below is a disputed value: the planner uses the ROM's, and in-game spot checks will settle it.

1,953 matched Pokémon have a known ROM nature. A rival's docs nature "X/Y" (Trainer Dawn/Lucas) means X for the Dawn copy and Y for the Lucas copy; read that way, every rival nature agrees. Two docs cells are not natures at all: "Mantine" (Sailor Cesar's Mantine, ROM 279) and "Lonely0" (Galactic Prospero's Alakazam, ROM 526). Both Pokémon have a known ROM nature, so the planner never reads those cells.

### Natures on level-mismatch matches (137)

Here the docs' natures are what the plain rule gives at the docs' own levels: 163 of the 213 known natures fit that way, against 76 at the ROM's levels. So the docs' natures predate these trainers' level changes, and the docs' exporter itself used the plain rule.

- Roark Split: School KidfChristine [ROM 345]: 1 of 1
- Wake Split: Collector Ripper [ROM 272]: 6 of 6
- Byron Split: Policeman Bobby [ROM 88]: 1 of 1
- Byron Split: Lady Celeste [ROM 893]: 1 of 1
- Byron Split: Waiter Doppio [ROM 897]: 1 of 1
- Byron Split: Maid Mocha [ROM 898]: 1 of 1
- Byron Split: Leader Cyrus [ROM 913]: 6 of 6
- Byron Split: Worker Dillan [ROM 844]: 4 of 4
- Byron Split: Worker Conrad [ROM 846]: 5 of 5
- Byron Split: GalacticF Galatea [ROM 505]: 4 of 4
- Byron Split: Galactic Hippocamp [ROM 457]: 2 of 4
- Byron Split: Galactic Psamanthe [ROM 506]: 2 of 4
- Byron Split: Galactic Sao [ROM 305]: 4 of 4
- Byron Split: Galactic Neso [ROM 289]: 3 of 4
- Byron Split: GalacticF Halimede [ROM 446]: 1 of 1
- Byron Split: GalacticF Nereid [ROM 378]: 4 of 4
- Byron Split: Galactic Triton [ROM 835]: 3 of 4
- Galactic Split: Galactic Prospero [ROM 550]: 3 of 6
- Galactic Split: GalacticfUranus [ROM 560]: 5 of 6
- Galactic Split: Leader Cyrus [ROM 403]: 1 of 1
- Galactic Split: Commander Saturn [ROM 409]: 6 of 6
- Galactic Split: Galactic Oberon [ROM 582]: 6 of 6
- Galactic Split: GalacticF Titania [ROM 583]: 5 of 6
- Galactic Split: GalacticF Terra [ROM 562]: 6 of 6
- Galactic Split: Galactic Luna [ROM 572]: 5 of 6
- Galactic Split: Galactic Prospero [ROM 526]: 2 of 6
- Galactic Split: Galactic Neptune [ROM 581]: 5 of 6
- Galactic Split: Galactic Triton [ROM 606]: 6 of 6
- Galactic Split: Commander Jupiter [ROM 407]: 1 of 2
- Galactic Split: Cyrus [ROM 404]: 3 of 6
- Elite Four Split: Roughneck Wyatt [ROM 234]: 5 of 6
- Elite Four Split: Blackbelt Roku [ROM 226]: 2 of 6
- Elite Four Split: Beauty Jasmine ❤ [ROM 222]: 5 of 6
- Elite Four Split: Hiker J.J Ahern [ROM 237]: 6 of 6
- Elite Four Split: Bug Catcher Ford [ROM 235]: 4 of 6
- Elite Four Split: Ruin Maniac Greg [ROM 230]: 5 of 6
- Elite Four Split: Idol Zoe, the best trainer in the game, best idol, and the hardest trainer you will ever face. [ROM 236]: 2 of 6
- Elite Four Split: Dragon Tamer Clinton [ROM 231]: 5 of 6

### Natures on second ROM copies (14)

A further ROM trainer with a docs trainer's party has another trainer index, so another PID; the docs give one nature for both.

- Roark Split: Clown Ronald [ROM 255]: 3 of 3
- Roark Split: School Kid Harrison [ROM 501]: 1 of 1
- Fantina Split: Pokefan Martha [ROM 59]: 4 of 4
- Elite Four Split: Elite Four Flint [ROM 874]: 6 of 6

### Natures of Team Galactic (158)

Nearly every Galactic grunt, Squad member and Commander differs on every Pokémon. A search over other trainer indexes and classes found no rule that reproduces the docs' natures.

- Gardenia Split: Galactic Mercury [ROM 211]: 4 of 4
- Byron Split: GalacticF Terra [ROM 67]: 6 of 6
- Byron Split: GalacticF Venus [ROM 73]: 6 of 6
- Byron Split: Galactic Squad Leda [ROM 75]: 6 of 6
- Byron Split: GalacticF Amalthia [ROM 490]: 6 of 6
- Byron Split: Galactic Metis [ROM 489]: 6 of 6
- Byron Split: Galactic Themisto [ROM 68]: 5 of 6
- Byron Split: GalacticF Dia [ROM 72]: 6 of 6
- Byron Split: Galactic Thebe [ROM 81]: 6 of 6
- Byron Split: Galactic Squad Himalia [ROM 79]: 6 of 6
- Byron Split: Galactic Callisto [ROM 69]: 6 of 6
- Byron Split: Galactic Pluto [ROM 74]: 6 of 6
- Byron Split: Galactic Ganymede [ROM 78]: 6 of 6
- Byron Split: GalacticF Io [ROM 442]: 2 of 2
- Byron Split: Galactic Mercury [ROM 416]: 3 of 5
- Candice Split: Galactic Pan [ROM 399]: 4 of 4
- Candice Split: Galactic Daphnis [ROM 425]: 4 of 4
- Candice Split: Galactic Epimetheus [ROM 500]: 1 of 1
- Candice Split: Galactic Prometheus [ROM 447]: 4 of 4
- Candice Split: GalacticF Phoebe [ROM 400]: 3 of 3
- Candice Split: Galactic Iapetus [ROM 397]: 5 of 5
- Candice Split: Galactic Enceladus [ROM 386]: 3 of 3
- Candice Split: GalacticF Mimas [ROM 373]: 4 of 4
- Candice Split: GalacticF Pandora [ROM 394]: 1 of 1
- Candice Split: GalacticF Dione [ROM 390]: 2 of 2
- Candice Split: Galactic Atlas [ROM 499]: 3 of 3
- Candice Split: Galactic Hyperion [ROM 288]: 3 of 3
- Candice Split: GalacticF Tethys [ROM 417]: 4 of 4
- Candice Split: GalacticF Rhea [ROM 418]: 4 of 4
- Candice Split: Commander Saturn [ROM 408]: 5 of 5
- Candice Split: Galactic Titan [ROM 433]: 2 of 2
- Candice Split: GalacticF Venus [ROM 426]: 4 of 4
- Candice Split: Galactic Luna [ROM 286]: 2 of 3
- Candice Split: Galactic Squad Deimos [ROM 420]: 6 of 6
- Candice Split: Galactic Squad Phobos [ROM 427]: 6 of 6
- Candice Split: Commander Mars [ROM 405]: 1 of 1
- Candice Split: GalacticF Terra [ROM 387]: 4 of 4
- Galactic Split: GalacticF Umbriel [ROM 530]: 3 of 3

### Other natures (18)

Pokémon of other trainers, mostly one or two per trainer.

- Byron Split: Waiter Affogato [ROM 899]: 1 of 1
- Byron Split: Sailor Cesar [ROM 279]: 1 of 5
- Byron Split: Leader Byron [ROM 250]: 1 of 6
- Candice Split: Veteran Anton [ROM 827]: 5 of 5
- Galactic Split: Pkmn Ranger Jeffrey [ROM 96]: 1 of 1
- Galactic Split: Pkmn Ranger Taylor [ROM 94]: 1 of 1
- Galactic Split: Scientist Caliban [ROM 547]: 1 of 6
- Elite Four Split: Barry #6 [ROM 479]: 2 of 6
- Elite Four Split: Elite Four Bertha [ROM 867]: 1 of 3
- Elite Four Split: Elite Four Flint [ROM 868]: 3 of 6
- Elite Four Split: Elite Four Lucian [ROM 869]: 1 of 1

## Against PKCalc

`npm run test:real` also compares the ROM with PKCalc (https://pkcalc.anastarawneh.com), the community damage calculator for this hack, fetched at 2026-11-08T03:42:46.079Z: the AI flags, party order and sets of each match that joins a PKCalc trainer. It also checks PKCalc's import of the player's save against our save reader (`test/real/boxVsPkcalc.test.ts`). Those must agree exactly, and nothing about the save is pinned, so that check has no entries here.

Each match is joined to a PKCalc trainer key by its docs name (`joinPkcalc` in `src/check/pkcalc.ts`): 479 of the 483 matches join one, and 4 do not (below). 10 of PKCalc's 485 trainer keys join no match: Pokémon Trainer Barry #1 [Chimchar]; Pokémon Trainer Barry #1 [Piplup]; Pokémon Trainer Barry #1 [Turtwig]; Pokémon Trainer Dawn @ Jubilife City [Grotle]; Pokémon Trainer Dawn @ Jubilife City [Monferno]; Pokémon Trainer Lucas @ Jubilife City [Prinplup]; Lady Emi; Ace Trainer Blake; Pokémon Ranger Allison; Galactic Laomedeia #2. These are teams the docs leave out or that match no docs trainer (see the docs-only trainers above).

AI flags and party order agree for all 479 joined trainers: `pkcalc-ai` and `pkcalc-party-order` have no groups, so a difference there stops `npm run record:diffs` until one explains it. Of the joined trainers' 2,097 Pokémon, 91 have a set that differs in some field.

## PKCalc: matched trainers that join no PKCalc trainer: 4

Pinned with the ROM party against null (field `key`), so a trainer PKCalc adds later fails the test until it is recorded.

### School Kids (3)

PKCalc lists no School Kid trainers at all.

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-join/Roark Split: School Kid Harrison [ROM 342]/key` | Vulpix | (none) |
| `pkcalc-join/Roark Split: School Kid Harrison [ROM 501]/key` | Vulpix | (none) |
| `pkcalc-join/Roark Split: School KidfChristine [ROM 345]/key` | Sandshrew | (none) |

### The Ranger the docs call Jeffrey twice (1)

The docs name both of the Galactic Split's one-Pokémon Rangers Jeffrey. PKCalc calls this one (Primeape) Pokémon Ranger Allison and the other (Arcanine) Jeffrey, so the docs' name finds only the other's key, which his party fits.

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-join/Galactic Split: Pkmn Ranger Jeffrey [ROM 96]/key` | Primeape | (none) |

## PKCalc: trainer sets: 94

Level, ability, item, moves (by ID, through PKCalc's own move table, so "Feint Attack" is the docs' "Faint Attack") and nature of each ROM Pokémon against the PKCalc set of its species. The nature compared is the one the planner uses: the ROM's where it is known (`nature`), the docs' where it is not (`nature-from-docs`).

### Natures on second ROM copies of a team (17)

PKCalc has one set per trainer key, and both ROM copies of a docs trainer's team join that key. Another trainer index means another plain-rule PID, so the copies' natures differ. Each nature here is on the copy whose nature PKCalc does not list: the other copy has PKCalc's nature (field `nature-other-copy`, checked by `diffPkcalc`). For Galactic Mercury's first fight PKCalc lists the shared copy, ROM 296, rather than ROM 211. Every other Pokémon whose ROM nature is known has PKCalc's nature (a difference without a copy to explain it has no group), which supports the plain rule.

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-sets/Roark Split: Clown Ronald [ROM 255] mon 1 (Mime Jr.)/nature-other-copy` | Gentle | Bashful |
| `pkcalc-sets/Roark Split: Clown Ronald [ROM 255] mon 2 (Snubbull)/nature-other-copy` | Bashful | Modest |
| `pkcalc-sets/Roark Split: Clown Ronald [ROM 255] mon 3 (Cleffa)/nature-other-copy` | Careful | Calm |
| `pkcalc-sets/Gardenia Split: Galactic Mercury [ROM 211] mon 1 (Glameow)/nature-other-copy` | Rash | Naughty |
| `pkcalc-sets/Gardenia Split: Galactic Mercury [ROM 211] mon 2 (Wynaut)/nature-other-copy` | Adamant | Timid |
| `pkcalc-sets/Gardenia Split: Galactic Mercury [ROM 211] mon 3 (Skorupi)/nature-other-copy` | Naughty | Bold |
| `pkcalc-sets/Gardenia Split: Galactic Mercury [ROM 211] mon 4 (Staryu)/nature-other-copy` | Naive | Quirky |
| `pkcalc-sets/Fantina Split: Pokefan Martha [ROM 59] mon 1 (Bonsly)/nature-other-copy` | Lonely | Calm |
| `pkcalc-sets/Fantina Split: Pokefan Martha [ROM 59] mon 2 (Clefairy)/nature-other-copy` | Quiet | Hasty |
| `pkcalc-sets/Fantina Split: Pokefan Martha [ROM 59] mon 3 (Wailmer)/nature-other-copy` | Modest | Bashful |
| `pkcalc-sets/Fantina Split: Pokefan Martha [ROM 59] mon 4 (Smoochum)/nature-other-copy` | Quiet | Hasty |
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 1 (Groudon)/nature-other-copy` | Jolly | Naughty |
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 2 (Uxie)/nature-other-copy` | Naive | Docile |
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 3 (Exeggutor)/nature-other-copy` | Docile | Modest |
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 4 (Houndoom)/nature-other-copy` | Modest | Naive |
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 5 (Charizard)/nature-other-copy` | Bold | Adamant |
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 6 (Magmortar)/nature-other-copy` | Sassy | Naive |

### Elite Four Flint's second copy: SolarBeam for Solar-Beam (1)

A real difference between the ROM's two copies of Flint's team, not a spelling. ROM 874 gives Exeggutor SolarBeam (move 76, with a charging turn) where the first copy, ROM 868, and PKCalc have Solar-Beam (move 130, no charging turn). The docs write "Solar-Beam" for both moves.

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 3 (Exeggutor)/moves-other-copy` | Explosion, SolarBeam, AncientPower, Morning Sun | Explosion, Solar-Beam, Ancient Power, Morning Sun |

### Elite Four Flint's second copy: Life Orb for Charcoal (1)

ROM 874's Magmortar holds Life Orb where the first copy, ROM 868, and PKCalc have Charcoal; the docs agree with ROM 868 too (see the trainer items above).

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-sets/Elite Four Split: Elite Four Flint [ROM 874] mon 6 (Magmortar)/item-other-copy` | Life Orb | Charcoal |

### Abilities of Shaymin-Sky and Giratina-Origin (2)

PKCalc gives these forms their base forms' abilities (Natural Cure, Pressure), as the docs do for Shaymin-Sky. The ROM gives each form's own Personal row (502, 501): Serene Grace and Levitate, which is what the game uses.

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-sets/Galactic Split: CYRUS [ROM 780] mon 1 (Giratina-Origin)/ability` | Levitate | Pressure |
| `pkcalc-sets/Elite Four Split: Champion Cynthia [ROM 870] mon 3 (Shaymin-Sky)/ability` | Serene Grace | Natural Cure |

### Abilities picked by an untrusted PID, against PKCalc (2)

Pokémon from the docs' list of these above, where PKCalc gives the docs' ability: the PID's lowest bit picks it, and these PIDs are untrusted (`natureKnown` is false).

| Key | ROM | PKCalc |
|---|---|---|
| `pkcalc-sets/Volkner Split: Psychic Destiny [ROM 285] mon 3 (Jolteon)/ability-cross-check` | Static | Rough Skin |
| `pkcalc-sets/Galactic Split: GalacticfTethys [ROM 638] mon 2 (Whiscash)/ability-cross-check` | Hydration | Swift Swim |

### Natures the ROM cannot give: the docs' against PKCalc's (71)

Where `natureKnown` is false (an override earlier in the party), the planner takes the docs' nature. PKCalc agrees with the docs on 77 of these 148 Pokémon: 73 of 121 on exact and shared matches, but only 4 of 27 on level-mismatch matches, where the docs' natures are stale. Of the 71 that differ, PKCalc's nature is the plain-rule one on 2. Where PKCalc gets these natures is unknown; it may know the hack's rule for overridden parties. Disputed, like the docs' natures: in-game spot checks will settle them.

| Key | Docs (used) | PKCalc |
|---|---|---|
| `pkcalc-sets/Byron Split: GalacticF Io [ROM 442] mon 3 (Drapion)/nature-from-docs` | Mild | Quiet |
| `pkcalc-sets/Byron Split: GalacticF Io [ROM 442] mon 4 (Salamence)/nature-from-docs` | Lax | Timid |
| `pkcalc-sets/Byron Split: GalacticF Io [ROM 442] mon 5 (Gengar)/nature-from-docs` | Calm | Gentle |
| `pkcalc-sets/Byron Split: GalacticF Io [ROM 442] mon 6 (Porygon-Z)/nature-from-docs` | Calm | Bold |
| `pkcalc-sets/Byron Split: Worker Dillan [ROM 844] mon 5 (Camerupt)/nature-from-docs` | Quiet | Quirky |
| `pkcalc-sets/Byron Split: GalacticF Halimede [ROM 446] mon 2 (Rampardos)/nature-from-docs` | Hasty | Modest |
| `pkcalc-sets/Byron Split: GalacticF Halimede [ROM 446] mon 3 (Slowking)/nature-from-docs` | Lax | Naive |
| `pkcalc-sets/Byron Split: GalacticF Halimede [ROM 446] mon 4 (Dusknoir)/nature-from-docs` | Mild | Calm |
| `pkcalc-sets/Byron Split: Galactic Naid [ROM 379] mon 2 (Ludicolo)/nature-from-docs` | Quiet | Hasty |
| `pkcalc-sets/Byron Split: Galactic Naid [ROM 379] mon 3 (Surskit)/nature-from-docs` | Bold | Impish |
| `pkcalc-sets/Byron Split: Galactic Naid [ROM 379] mon 4 (Whiscash)/nature-from-docs` | Adamant | Docile |
| `pkcalc-sets/Candice Split: Galactic Epimetheus [ROM 500] mon 2 (Lumineon)/nature-from-docs` | Sassy | Rash |
| `pkcalc-sets/Candice Split: Galactic Epimetheus [ROM 500] mon 3 (Carnivine)/nature-from-docs` | Serious | Rash |
| `pkcalc-sets/Candice Split: Galactic Epimetheus [ROM 500] mon 4 (Weezing)/nature-from-docs` | Lax | Docile |
| `pkcalc-sets/Candice Split: GalacticF Pandora [ROM 394] mon 2 (Vespiquen)/nature-from-docs` | Bold | Timid |
| `pkcalc-sets/Candice Split: GalacticF Pandora [ROM 394] mon 3 (Crobat)/nature-from-docs` | Careful | Rash |
| `pkcalc-sets/Candice Split: GalacticF Dione [ROM 390] mon 3 (Pinsir)/nature-from-docs` | Careful | Quirky |
| `pkcalc-sets/Candice Split: Galactic Titan [ROM 433] mon 3 (Steelix)/nature-from-docs` | Docile | Adamant |
| `pkcalc-sets/Candice Split: Galactic Titan [ROM 433] mon 4 (Snorlax)/nature-from-docs` | Impish | Quirky |
| `pkcalc-sets/Candice Split: Galactic Mercury [ROM 419] mon 2 (Solrock)/nature-from-docs` | Adamant | Hardy |
| `pkcalc-sets/Candice Split: Galactic Mercury [ROM 419] mon 3 (Castform)/nature-from-docs` | Timid | Mild |
| `pkcalc-sets/Candice Split: Galactic Mercury [ROM 419] mon 4 (Gengar)/nature-from-docs` | Calm | Quiet |
| `pkcalc-sets/Candice Split: Commander Mars [ROM 405] mon 2 (Garchomp)/nature-from-docs` | Bashful | Lonely |
| `pkcalc-sets/Candice Split: Commander Mars [ROM 405] mon 3 (Swampert)/nature-from-docs` | Lonely | Bold |
| `pkcalc-sets/Candice Split: Commander Mars [ROM 405] mon 4 (Jirachi)/nature-from-docs` | Bashful | Naughty |
| `pkcalc-sets/Candice Split: Commander Mars [ROM 405] mon 5 (Ninetales)/nature-from-docs` | Adamant | Quirky |
| `pkcalc-sets/Candice Split: Commander Mars [ROM 405] mon 6 (Mesprit)/nature-from-docs` | Relaxed | Naughty |
| `pkcalc-sets/Candice Split: Ace Trainer Tenzing [ROM 828] mon 1 (Glalie)/nature-from-docs` | Sassy | Naive |
| `pkcalc-sets/Candice Split: Ace Trainer Tenzing [ROM 828] mon 2 (Walrein)/nature-from-docs` | Serious | Jolly |
| `pkcalc-sets/Candice Split: Ace Trainer Tenzing [ROM 828] mon 3 (Alakazam)/nature-from-docs` | Brave | Sassy |
| `pkcalc-sets/Candice Split: Ace Trainer Tenzing [ROM 828] mon 4 (Rotom-Frost)/nature-from-docs` | Quiet | Serious |
| `pkcalc-sets/Candice Split: Ace Trainer Tenzing [ROM 828] mon 5 (Tyranitar)/nature-from-docs` | Quirky | Rash |
| `pkcalc-sets/Candice Split: Skier Anas [ROM 269] mon 1 (Slowbro)/nature-from-docs` | Docile | Lax |
| `pkcalc-sets/Candice Split: Skier Anas [ROM 269] mon 2 (Piloswine)/nature-from-docs` | Naughty | Brave |
| `pkcalc-sets/Candice Split: Skier Anas [ROM 269] mon 3 (Stantler)/nature-from-docs` | Hardy | Naughty |
| `pkcalc-sets/Candice Split: Skier Anas [ROM 269] mon 4 (Jynx)/nature-from-docs` | Sassy | Hasty |
| `pkcalc-sets/Candice Split: Skier Anas [ROM 269] mon 5 (Empoleon)/nature-from-docs` | Relaxed | Naive |
| `pkcalc-sets/Candice Split: Skier Savannah [ROM 270] mon 2 (Slowking)/nature-from-docs` | Naughty | Lonely |
| `pkcalc-sets/Candice Split: Skier Savannah [ROM 270] mon 3 (Glaceon)/nature-from-docs` | Naughty | Relaxed |
| `pkcalc-sets/Candice Split: Skier Savannah [ROM 270] mon 4 (Arcanine)/nature-from-docs` | Gentle | Bashful |
| `pkcalc-sets/Candice Split: Skier Savannah [ROM 270] mon 5 (Tentacruel)/nature-from-docs` | Lax | Docile |
| `pkcalc-sets/Candice Split: Ace Trainer Alicia [ROM 271] mon 1 (Cloyster)/nature-from-docs` | Naughty | Quirky |
| `pkcalc-sets/Candice Split: Ace Trainer Alicia [ROM 271] mon 2 (Gardevoir)/nature-from-docs` | Careful | Adamant |
| `pkcalc-sets/Candice Split: Ace Trainer Alicia [ROM 271] mon 3 (Weavile)/nature-from-docs` | Lax | Careful |
| `pkcalc-sets/Candice Split: Ace Trainer Alicia [ROM 271] mon 4 (Ninetales)/nature-from-docs` | Careful | Lax |
| `pkcalc-sets/Candice Split: Ace Trainer Alicia [ROM 271] mon 5 (Dragonite)/nature-from-docs` | Docile | Hasty |
| `pkcalc-sets/Galactic Split: Pkmn Ranger Jeffrey [ROM 95] mon 1 (Arcanine)/nature-from-docs` | Relaxed | Naughty |
| `pkcalc-sets/Galactic Split: Leader Cyrus [ROM 403] mon 2 (Rampardos)/nature-from-docs` | Quirky | Brave |
| `pkcalc-sets/Galactic Split: Leader Cyrus [ROM 403] mon 3 (Heatran)/nature-from-docs` | Bold | Rash |
| `pkcalc-sets/Galactic Split: Leader Cyrus [ROM 403] mon 4 (Registeel)/nature-from-docs` | Bashful | Sassy |
| `pkcalc-sets/Galactic Split: Leader Cyrus [ROM 403] mon 5 (Dusknoir)/nature-from-docs` | Jolly | Lonely |
| `pkcalc-sets/Galactic Split: Leader Cyrus [ROM 403] mon 6 (Regigigas)/nature-from-docs` | Relaxed | Bold |
| `pkcalc-sets/Galactic Split: Commander Mars [ROM 528] mon 1 (Garchomp)/nature-from-docs` | Brave | Mild |
| `pkcalc-sets/Galactic Split: Commander Mars [ROM 528] mon 2 (Aerodactyl)/nature-from-docs` | Naughty | Sassy |
| `pkcalc-sets/Galactic Split: Commander Mars [ROM 528] mon 3 (Swampert)/nature-from-docs` | Careful | Docile |
| `pkcalc-sets/Galactic Split: Commander Mars [ROM 528] mon 6 (Latias)/nature-from-docs` | Timid | Naive |
| `pkcalc-sets/Galactic Split: Commander Jupiter [ROM 407] mon 3 (Magnezone)/nature-from-docs` | Modest | Docile |
| `pkcalc-sets/Galactic Split: Commander Jupiter [ROM 407] mon 6 (Latios)/nature-from-docs` | Timid | Lonely |
| `pkcalc-sets/Elite Four Split: Elite Four Aaron [ROM 866] mon 3 (Vespiquen)/nature-from-docs` | Relaxed | Lonely |
| `pkcalc-sets/Elite Four Split: Elite Four Aaron [ROM 866] mon 4 (Surskit)/nature-from-docs` | Serious | Mild |
| `pkcalc-sets/Elite Four Split: Elite Four Aaron [ROM 866] mon 5 (Flygon)/nature-from-docs` | Sassy | Lonely |
| `pkcalc-sets/Elite Four Split: Elite Four Aaron [ROM 866] mon 6 (Kingler)/nature-from-docs` | Hardy | Naughty |
| `pkcalc-sets/Elite Four Split: Elite Four Bertha [ROM 867] mon 4 (Garchomp)/nature-from-docs` | Serious | Adamant |
| `pkcalc-sets/Elite Four Split: Elite Four Bertha [ROM 867] mon 6 (Aerodactyl)/nature-from-docs` | Timid | Lonely |
| `pkcalc-sets/Elite Four Split: Elite Four Lucian [ROM 869] mon 3 (Gengar)/nature-from-docs` | Careful | Modest |
| `pkcalc-sets/Elite Four Split: Elite Four Lucian [ROM 869] mon 4 (Lugia)/nature-from-docs` | Relaxed | Mild |
| `pkcalc-sets/Elite Four Split: Elite Four Lucian [ROM 869] mon 5 (Cresselia)/nature-from-docs` | Naughty | Calm |
| `pkcalc-sets/Elite Four Split: Elite Four Lucian [ROM 869] mon 6 (Latias)/nature-from-docs` | Quirky | Mild |
| `pkcalc-sets/Elite Four Split: Champion Cynthia [ROM 870] mon 3 (Shaymin-Sky)/nature-from-docs` | Timid | Rash |
| `pkcalc-sets/Elite Four Split: Champion Cynthia [ROM 870] mon 5 (Giratina)/nature-from-docs` | Quirky | Naughty |
| `pkcalc-sets/Elite Four Split: Champion Cynthia [ROM 870] mon 6 (Arceus)/nature-from-docs` | Careful | Naughty |

## PKCalc: damage rolls: 12

`test/real/calcVsPkcalc.test.ts` runs our damage calc and PKCalc's own (its fork of the Smogon calc, in its page in headless Chromium, offline once loaded) on identical inputs: species, level, gender, nature, IVs, EVs, item, ability, move and field, with our base stats, types and move numbers passed as overrides, as PKCalc's page does from its editable fields (`src/check/pkcalcCalc.ts`). Each calc compares the 16 rolls of one hit (a multi-hit move's first), normal (field `rolls`) and as a critical hit (`crit-rolls`).

The grid: 3 opponents in each of the 10 splits (the first, the first double battle or else the middle one, and the last), every Pokémon of each against 3 profiles of the player's party on 2026-11-08 (Monferno, Delibird, Phanpy) at the split's level cap, both ways, with each attacker's first 2 damaging moves (Psywave left out). That is 1,716 calcs and 3,432 roll comparisons over 144 trainer Pokémon of 30 trainers and 153 moves; 3,194 comparisons deal damage on our side. 3,420 agree exactly.

Keys read `Split: Trainer [ROM index] mon N (species) Move vs. Profile Llevel` for the trainer's move and `… mon N (species) hit by Profile Llevel Move` for the profile's; ours is the `rom` side. A field suffix names a cause that `diffCalc` shows by giving PKCalc our choice and getting our rolls back. Two mechanical differences were our bugs, fixed with a failing test first, and are not listed: the hack's Plates boost 1.5x (the docs' Items tab gives them power 50, vanilla 20), and the Explosion effect halves only physical Defense, so the special Memento hits full Special Defense. A third fix changed Fling: its power is the held item's fling power in the ROM's item data, as the game reads it. Before, an item `@pkmn/dex` knew no fling power for read as 0 damage, and then as a 130-power worst case, which the ROM's Nugget (250) and Bicycle (150) exceed.

### OHKO moves: ours deal the target's HP when they hit (12)

When an OHKO move hits, the cartridge sets the damage to the target's current HP (`BtlCmd_TryOHKOMove`, pokeplatinum src/battle/battle_script.c:4334-4383), so our rolls are the target's HP and the KO chance is conditional on the hit, 1 or 0 for each of its entries, with accuracy only in `hitChance`. PKCalc runs the move on its power-1 numbers. The suffix `-ohko` goes only to an OHKO move whose 16 rolls are all exactly the target's HP; one that cannot land (Sturdy, a type immunity) deals 0 and gets no such label.

| Key | Ours | PKCalc |
|---|---|---|
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 1 (Steelix) Fissure vs. Monferno L100/rolls-ohko` | 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238 | 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 8 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 1 (Steelix) Fissure vs. Monferno L100/crit-rolls-ohko` | 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238 | 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 18 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 1 (Steelix) Fissure vs. Phanpy L100/rolls-ohko` | 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315 | 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 1 (Steelix) Fissure vs. Phanpy L100/crit-rolls-ohko` | 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315 | 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 3 (Machamp) Fissure vs. Monferno L100/rolls-ohko` | 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238 | 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 8 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 3 (Machamp) Fissure vs. Monferno L100/crit-rolls-ohko` | 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238 | 12, 12, 12, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 16 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 3 (Machamp) Fissure vs. Phanpy L100/rolls-ohko` | 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315 | 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 3 (Machamp) Fissure vs. Phanpy L100/crit-rolls-ohko` | 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315 | 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 4 (Wailord) Fissure vs. Monferno L100/rolls-ohko` | 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238 | 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 4 (Wailord) Fissure vs. Monferno L100/crit-rolls-ohko` | 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238, 238 | 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 4 (Wailord) Fissure vs. Phanpy L100/rolls-ohko` | 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315 | 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3 |
| `calc/Elite Four Split: Sinister Hooded Figure - [ROM 666] mon 4 (Wailord) Fissure vs. Phanpy L100/crit-rolls-ohko` | 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315, 315 | 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6 |
