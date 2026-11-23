// The battle engine's move behaviours, table-driven from the docs' "Additional Effect" texts: every
// text of the three lists (effectMap.ts, noDamageEffects.ts) has an `ENGINE_EFFECTS` entry, keyed by the same
// normalised text. The docs' text decides behaviour, never the ROM's effect ID or the Showdown move a hack move is
// named after: when they disagree, the docs win. dex.ts builds each hack move's Showdown data from
// its entry (`showdownMoveData`).
//
// The kinds:
// - `plain`: a hit with no effect but what `EFFECT_MAP` gives the text (hits, recoil, drain, crit stage,
//   never-miss), and no Showdown callbacks.
// - `secondary`: a damaging move's chance effects, each its own draw at the labelled `effect` site (mod/scripts.ts) with
//   the ROM's effect chance unless the entry gives one. A status, a volatile and stat changes in one entry are
//   independent effects at the same chance, in that order, as the cartridge's two-effect scripts check them
//   (subscript_burn_or_flinch.s: `CheckEffectActivation` for the burn, then again for the flinch). A sure effect on the
//   user (`self` at 100) is Showdown's `self`, applied on hit (effect_script_0218.s: `MOVE_SIDE_EFFECT_ON_HIT`).
// - `status`: a status move's status, volatile or stat changes, on the user or the foe.
// - `heal`: a status move that heals the user by a fraction of its max HP.
// - `inherit`: a Showdown move whose implementation is the docs' text, run with the mod's draws and overrides for it
//   and the ROM's numbers, effect chance and flags (Struggle's, and the named mechanics).
// - `unmodelled`: not modelled, with the reason (what the cartridge does that Showdown's Gen 4 doesn't, or what
//   isn't checked); `unmodelledIn` reports the move, and docs/engine-model.md lists them. Such a move keeps its
//   behaviour source's Showdown data (`showdownMoveData`), so it runs, but no proof relies on it.
//
// A ROM effect chance of 0 on a `secondary` entry leaves the move with no effect: the cartridge's probabilistic checks
// pass iff `RandNext() % 100 < effectChance` (src/battle/battle_lib.c:1550-1561, :1570-1580; battle_script.c:8368-8378),
// which never holds at 0. The one such text in the docs is the unnamed move 468's "Lowers SpDef (Attack)".

import { byEffectText, EFFECT_MAP, normaliseEffectText } from '../battle/effectMap.js';
import type { KaizoMove } from '../battle/moves.js';

type StatusId = 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
type BoostId = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';

export type EngineEffect =
  | { kind: 'plain' }
  | { kind: 'secondary'; status?: StatusId; volatile?: 'flinch' | 'confusion'; boosts?: Partial<Record<BoostId, number>>; self?: boolean; chance?: number } // chance defaults to the ROM effect chance
  | { kind: 'status'; target: 'self' | 'foe'; status?: StatusId; volatile?: string; boosts?: Partial<Record<string, number>> }
  | { kind: 'heal'; fraction: [number, number] }
  | { kind: 'inherit'; from: string } // a Showdown move id whose implementation matches the docs text
  | { kind: 'unmodelled'; reason: string; plain: string };

const PLAIN: EngineEffect = { kind: 'plain' };
const unmodelled = (reason: string, plain: string): EngineEffect => ({ kind: 'unmodelled', reason, plain });
const inherit = (from: string): EngineEffect => ({ kind: 'inherit', from });

const chance = (fields: Omit<Extract<EngineEffect, { kind: 'secondary' }>, 'kind'>): EngineEffect => ({ kind: 'secondary', ...fields });
const onFoe = (fields: Omit<Extract<EngineEffect, { kind: 'status' }>, 'kind' | 'target'>): EngineEffect => ({ kind: 'status', target: 'foe', ...fields });
const onSelf = (fields: Omit<Extract<EngineEffect, { kind: 'status' }>, 'kind' | 'target'>): EngineEffect => ({ kind: 'status', target: 'self', ...fields });

/** Every docs effect text's engine behaviour, keyed by `normaliseEffectText`. */
export const ENGINE_EFFECTS: Record<string, EngineEffect> = byEffectText<EngineEffect>({
  // --- Plain hits, with EFFECT_MAP's mechanics (multi-hit, recoil, drain, crit stage, never-miss).
  'None': PLAIN,
  'Hits twice': PLAIN,
  'Hits target 2-5 times': PLAIN,
  '1/2 damage dealt recoil, fixed AI': PLAIN, // "fixed AI" and "VANILLA AI" are the trainer AI's, not the move's
  '1/2 damage dealt recoil, VANILLA AI': PLAIN,
  '1/3 damage dealt recoil': PLAIN,
  '1/4 damage dealt recoil': PLAIN,
  'Damages target; heals user up to 50% of damage dealt': PLAIN,
  'High crit ratio': PLAIN,
  'Always hits': PLAIN,
  'Priority +1': PLAIN, // the ROM's priority (1 for each of these moves)
  // The doubling can't happen: the docs give Dig and Dive no effect, so no Pokémon digs or dives (noDamageEffects.ts).
  '2x Damage on Pokemon using Dig': PLAIN,
  '2x Damage on Pokemon using Dive': PLAIN,

  // --- Chance effects of damaging moves.
  'Chance to Burn': chance({ status: 'brn' }),
  'Chance to Freeze': chance({ status: 'frz' }),
  'Chance to Paralyze': chance({ status: 'par' }),
  'Chance to Poison': chance({ status: 'psn' }),
  'Chance of Badly Poisoning': chance({ status: 'tox' }),
  'Chance to Confuse': chance({ volatile: 'confusion' }),
  'Chance to Flinch': chance({ volatile: 'flinch' }),
  'Hits twice; chance to poison': chance({ status: 'psn' }),
  'Chance of causing Burn; 1/3 damage dealt recoil': chance({ status: 'brn' }),
  'Chance of causing Paralysis; 1/3 damage dealt recoil': chance({ status: 'par' }),
  'Chance of causing Burn; increased Crit ratio': chance({ status: 'brn' }),
  'Chance of causing Poison; increased crit ratio': chance({ status: 'psn' }),
  'Chance of causing Burn; chance of causing Flinch': chance({ status: 'brn', volatile: 'flinch' }),
  'Chance of causing Freeze; chance of causing Flinch': chance({ status: 'frz', volatile: 'flinch' }),
  'Chance of causing Paralysis; chance of causing Flinch': chance({ status: 'par', volatile: 'flinch' }),
  // The thaw is the cartridge's, by the move's ROM effect (mod/conditions.ts `thawsUser`).
  'Thaws user; chance to Burn': chance({ status: 'brn' }),
  'Lowers Accuracy (Attack)': chance({ boosts: { accuracy: -1 } }),
  'Lowers Def (Attack)': chance({ boosts: { def: -1 } }),
  'Lowers SpAtk (Attack)': chance({ boosts: { spa: -1 } }),
  'Lowers Spd (Attack)': chance({ boosts: { spe: -1 } }),
  'Lowers SpDef (Attack)': chance({ boosts: { spd: -1 } }),
  'Chance of lowering target\'s SpDef harshly': chance({ boosts: { spd: -2 } }),
  'Chance of raising Atk': chance({ boosts: { atk: 1 }, self: true }),
  'Chance of raising Def': chance({ boosts: { def: 1 }, self: true }),
  'Chance of raising user\'s SpAtk': chance({ boosts: { spa: 1 }, self: true }),
  'Ancient Power boost': chance({ boosts: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, self: true }),
  // A sure drop on hit, whatever the ROM's chance (Hammer Arm's is 0): effect_script_0218.s, `MOVE_SIDE_EFFECT_ON_HIT`.
  'Lowers user\'s Spd': chance({ boosts: { spe: -1 }, self: true, chance: 100 }),

  // --- Status moves that inflict a status or confusion. Yawn's text is "Causes Sleep": the hack's Yawn puts its target
  // to sleep at once (ROM effect 1, the sleep effect), not Showdown's Yawn's next turn.
  'Causes Sleep': onFoe({ status: 'slp' }),
  'Badly Poisons': onFoe({ status: 'tox' }),
  'Guaranteed Poison': onFoe({ status: 'psn' }),
  'Guaranteed Paralysis': onFoe({ status: 'par' }),
  'Guaranteed Burn; activates Flash Fire': onFoe({ status: 'brn' }), // Flash Fire takes any Fire move (Showdown's)
  'Guaranteed Confusion (Status)': onFoe({ volatile: 'confusion' }),
  'Raises target\'s SpAtk and causes Confusion': onFoe({ boosts: { spa: 1 }, volatile: 'confusion' }),
  'Sharply raises target\'s Atk and causes Confusion': onFoe({ boosts: { atk: 2 }, volatile: 'confusion' }),

  // --- Status moves that change stat stages. The docs' stat wins over the Showdown namesake's: the hack's Fake Tears
  // and Metal Sound sharply lower Speed, Sweet Scent lowers evasion by 1 and Minimize sharply raises it.
  'Lowers Accuracy (Status)': onFoe({ boosts: { accuracy: -1 } }),
  'Lowers Atk (Status)': onFoe({ boosts: { atk: -1 } }),
  'Lowers Def (Status)': onFoe({ boosts: { def: -1 } }),
  'Lowers Evasion (Status)': onFoe({ boosts: { evasion: -1 } }),
  'Lowers Spd (Status)': onFoe({ boosts: { spe: -1 } }),
  'Lowers target\'s Atk and Def': onFoe({ boosts: { atk: -1, def: -1 } }),
  'Sharply lowers Accuracy (Status)': onFoe({ boosts: { accuracy: -2 } }),
  'Sharply lowers Atk (Status)': onFoe({ boosts: { atk: -2 } }),
  'Sharply lowers Def (Status)': onFoe({ boosts: { def: -2 } }),
  'Sharply lowers SpAtk (Status)': onFoe({ boosts: { spa: -2 } }), // Captivate: the docs give no gender condition
  'Sharply lowers Spd (Status)': onFoe({ boosts: { spe: -2 } }),
  'Raises Atk': onSelf({ boosts: { atk: 1 } }),
  'Raises Def': onSelf({ boosts: { def: 1 } }),
  'Raises Evasion': onSelf({ boosts: { evasion: 1 } }),
  'Raises SpAtk': onSelf({ boosts: { spa: 1 } }),
  'Raises user\'s Atk and Def': onSelf({ boosts: { atk: 1, def: 1 } }),
  'Raises user\'s Atk and Spd': onSelf({ boosts: { atk: 1, spe: 1 } }),
  'Raises user\'s Def and SpDef': onSelf({ boosts: { def: 1, spd: 1 } }), // the hack's Stockpile too: no stockpile count
  'Raises user\'s SpAtk and SpDef': onSelf({ boosts: { spa: 1, spd: 1 } }),
  'Sharply raises Atk (Status)': onSelf({ boosts: { atk: 2 } }),
  'Sharply raises Def (Status)': onSelf({ boosts: { def: 2 } }),
  'Sharply raises Evasion (Status)': onSelf({ boosts: { evasion: 2 } }),
  'Sharply raises SpAtk (Status)': onSelf({ boosts: { spa: 2 } }),
  'Sharply raises Spd (Status)': onSelf({ boosts: { spe: 2 } }),
  'Sharply raises SpDef (Status)': onSelf({ boosts: { spd: 2 } }),
  // Focus Energy's volatile: crit stage +2 (Showdown's `focusenergy` condition, which scripts.ts's crit site sums).
  'Sharply raises crit ratio': onSelf({ volatile: 'focusenergy' }),

  // --- Healing.
  'Restores up to 50% max HP': { kind: 'heal', fraction: [1, 2] }, // the hack's Lunar Dance too: it heals, no fainting

  // --- Inherited Showdown behaviours. Showdown's Struggle (typeless; recoil max HP / 4 rounded down, the
  // cartridge's, mod/moves.ts). Struggle is in no move slot, so a placeholder would never be named by `unmodelledIn`.
  'Struggle effect': { kind: 'inherit', from: 'struggle' },

  // The named mechanics: Showdown's Gen 4 move whose implementation is the docs' text, with the ROM's numbers and
  // flags (dex.ts `withRomFlags`) and the mod's overrides where the cartridge differs (mod/moves.ts, mod/procs.ts,
  // mod/scripts.ts; each cites its pokeplatinum lines).
  // Binding: every "Whirlpool effect" move has ROM effect 261 (BATTLE_EFFECT_WHIRLPOOL, effect_script_0261.s: the bind,
  // and double power on a diver, which no one is in the hack). The `partiallytrapped` condition (mod/conditions.ts) gives its length and chip.
  'Whirlpool effect': inherit('wrap'),
  // The user faints whatever happens to the hit (effect_script_0007.s:6-14); Damp stops it by the ROM effect (procs.ts);
  // the target's Defense is halved for a physical one (bl:6943-6945; Memento, a special Explosion here, reads SpDef).
  'Selfdestruct/ Explosion effect': inherit('explosion'),
  // Pursuit and the hack's Rage (a Fighting-type Pursuit): the switch-out hit runs the move itself (mod/moves.ts).
  'Pursuit effect': inherit('pursuit'),
  'Protect/ Detect effect': inherit('protect'),
  'Allows user to endure a fatal hit and survive at 1 HP': inherit('endure'),
  'Substitute effect': inherit('substitute'),
  'Baton Pass effect': inherit('batonpass'),
  'Switches user out after dealing damage': inherit('uturn'),
  'Whirlwind/ Roar effect': inherit('roar'), // the mod's level check and target pick; the ROM's flags (Whirlwind is no sound move)
  'Spikes effect': inherit('spikes'),
  'Toxic Spikes effect': inherit('toxicspikes'),
  'Stealth Rocks effect': inherit('stealthrock'),
  '1/2 damage from Physical attacks': inherit('reflect'),
  '1/2 damage from Special attacks': inherit('lightscreen'),
  'Safeguard effect': inherit('safeguard'),
  'Prevents lowering of stats': inherit('mist'),
  'Causes Rain': inherit('raindance'),
  'Causes Harsh Sunlight': inherit('sunnyday'),
  'Causes Sandstorm': inherit('sandstorm'),
  'Causes Hail': inherit('hail'), // under a permanent hail it starts five turns (mod/moves.ts)
  'Trick Room effect': inherit('trickroom'),
  '2x Spd for user\'s party for 3 turns': inherit('tailwind'),
  'Gravity effect': inherit('gravity'),
  'Locks target into last move used for 3-7 turns': inherit('encore'), // the mod's Encore condition
  'Disables last move used for 4-7 turns': inherit('disable'), // the mod's Disable condition
  'Torment effect': inherit('torment'),
  'Leech Seed effect': inherit('leechseed'),
  'Causes Sleep and restores all HP': inherit('rest'), // a known sleep counter of 3 (the mod's `slp`)
  'Sleep Talk effect': inherit('sleeptalk'), // the cartridge's list of moves to call (mod/moves.ts)
  'Pain Split effect': inherit('painsplit'),
  '2x last amount of damage received': inherit('counter'),
  'Mirror Coat effect': inherit('mirrorcoat'),
  'Focus Punch effect': inherit('focuspunch'),
  'Guaranteed Flinch; can only be used turn 1': inherit('fakeout'), // the cartridge's first-turn rule (mod/moves.ts)
  'All users on field faint in 3 turns': inherit('perishsong'),
  'Destiny Bond effect': inherit('destinybond'),
  'Renders the target\'s held item unusable': inherit('knockoff'),
  'Belly Drum effect': inherit('bellydrum'),
  'Resets stat changes': inherit('haze'),
  'Target is prevented from using moves shared with the user': inherit('imprison'), // the cartridge's shared-move check
  // Stomp: power ×2 on a target with Minimize's marker (effect_script_0150.s:6-8), which the hack's Minimize leaves by
  // its ROM effect (dex.ts); the flinch at the ROM's chance.
  'Causes flinch and 2x damage if target has used Minimize': inherit('stomp'),

  // Variable power. Showdown's Gen 4 move, with the cartridge's formula where Showdown's differs (mod/moves.ts).
  // In the hack Eruption is a recoil burn hit, Avalanche a freeze-and-flinch hit and Crush Grip a binding move (their
  // docs texts above), Magnitude's slot is Bulldoze and Return and Frustration are plain 121-power hits, so none
  // of them varies.
  'Higher power the less HP the user has': inherit('flail'), // Showdown's 64-pixel bands are bs:4940-4970's
  'Power= Base power x(user\'s current HP/ user\'s max HP)': inherit('waterspout'), // bs:6645-6656, at least 1
  // The stored monSpeedValues, not live Speed (bs:7123-7133).
  'Power = min(150; (25 x Target\'s Current Speed / User\'s Current Speed) + 1)': inherit('gyroball'),
  // The cartridge's weight bands on the ROM's Pokédex weights (bs:6808-6828; dex.ts `pokedexWeightKg`).
  'Inflicts greater damage on heavier targets': inherit('lowkick'),
  '2x power if target is at or below 1/2 HP': inherit('brine'), // effect_script_0221.s; the hack's Wring Out too
  '2x power if user is Poisoned; Paralyzed; or Burned.': inherit('facade'), // MON_CONDITION_FACADE_BOOST only
  'Power= 60 + (20x # of stat increases of target)': inherit('punishment'), // bs:7354-7372
  '2x Power if user moves after target': inherit('payback'), // the ROM's power ×2 (bs:7198-7208); the hack's Revenge too
  'Hidden Power effect': inherit('hiddenpower'), // from the IVs (bs:6007-6040), Showdown's Gen 4 formula
  'Present Effect': inherit('present'), // the mod's draw (mod/moves.ts)
  // bs:6843-6872; no usable weather: the ROM's type and power; the deep fog doubles the power, type unchanged (mod/moves.ts)
  'Type changes to match weather': inherit('weatherball'),
  'The less PP the move has; the greater its Power': inherit('trumpcard'), // sCurrentPPScaledPower (bs:7233-7250)
  // Doubled on the status, never through a substitute; the hit cures it (effect_script_0171.s, 0217.s).
  '2x power if target is Paralyzed; cures target of Paralysis': inherit('smellingsalts'),
  '2x power if target is asleep; wakes up target': inherit('wakeupslap'),

  // The accumulated cartridge items' moves.
  // Bug Bite and Pluck eat the target's berry, never through a substitute (bs:8116-8143, bl:5546-5548; mod/moves.ts).
  'Consumes target\'s berry': inherit('bugbite'),
  // Mean Look, Block, Spider Web: Showdown's `trapped` passes on Baton Pass as VOLATILE_CONDITION_MEAN_LOOK does
  // (condition.h:72-76), and ends when the trapper switches out other than by Baton Pass (bl:2055-2061).
  'Prevents target from switching out or fleeing': inherit('meanlook'),

  // --- The remaining placeholders. Each inherited move's Gen 4 Showdown implementation was checked
  // against its ROM effect's script (res/battle/scripts/effects/effect_script_NNNN.s and the commands it runs), with the
  // mod's overrides where they differ (mod/moves.ts, mod/scripts.ts).
  // Fixed damage: the type chart's immunity still holds (bl:7544-7556, ApplyTypeMultiplier sets INEFFECTIVE whatever
  // SYSCTL_IGNORE_TYPE_CHECKS), as in Showdown.
  'Deals damage equal to user\'s level': inherit('seismictoss'), // effect_script_0087.s; Night Shade too
  'Deals 40 damage': inherit('dragonrage'), // effect_script_0041.s
  'Inflicts 20 damage': inherit('sonicboom'), // effect_script_0130.s
  'Deals damage equal to 1/2 target\'s current hp': inherit('superfang'), // effect_script_0040.s: at least 1
  'Target\'s HP becomes equal to the user\'s current HP': inherit('endeavor'), // effect_script_0189.s
  'Damage= 1.5x damage dealt by the target\'s last attack': inherit('metalburst'), // bs:7153-7196; the hack's Bide too
  'OHKO': inherit('guillotine'), // the target's current HP (bs:4378, mod/scripts.ts); its hit rate is mod/accuracy.ts's
  // Hits and their conditions.
  'Damages sleeping target; heals user up to 50% of damage dealt': inherit('dreameater'), // effect_script_0008.s
  'Charging turn; high crit ratio': inherit('razorwind'), // effect_script_0039.s
  'Charging turn unless in Harsh Sunlight': inherit('solarbeam'), // effect_script_0151.s; halved in rain, sand, hail, deep fog (bl:7058)
  'Can only hit targets that have used Protect/ Detect': inherit('feint'), // BtlCmd_TryFeint (bs:7518-7530)
  'Fails unless the user has used all of its other moves at least once': inherit('lastresort'), // bs:7567-7580; a user knowing a move caller is noted (mod/moves.ts)
  'Can only be used while asleep; chance of causing Flinch': inherit('snore'), // effect_script_0092.s, the ROM's chance
  'False Swipe effect': inherit('falseswipe'), // effect_script_0101.s: leaves 1 HP
  'Pay Day effect': inherit('payday'), // effect_script_0034.s: prize money only
  'Recharge turn': inherit('roaroftime'), // the docs' text; the ROM's effect is 262, Volt Tackle's (docs/engine-spot-checks.md)
  'Uproar effect': inherit('uproar'), // the mod's uproar (mod/conditions.ts)
  // Only a flying target doubles it (effect_script_0149.s), and Fly is unmodelled, so where it is modelled it is a plain hit.
  '2x Damage on Pokemon using Bounce/Fly': inherit('gust'),
  // Showdown's Gen 4 Blizzard, with the ROM's freeze chance (Sheer Cold's 100, Ice Ball's 0); the hail rule is the
  // cartridge's by ROM effect (mod/accuracy.ts).
  'Always hits in Hail': inherit('blizzard'),
  'Always hits in rain; chance to Paralyze': inherit('thunder'), // effect_script_0152.s; the rain and sun rules by ROM effect
  // The hack's Hurricane (its own ROM effect 141): a confusion chance at the ROM's chance (30; the docs say 10), its
  // weather rule mod/accuracy.ts's (docs/engine-spot-checks.md).
  'Always hits in rain; chance to Confuse': chance({ volatile: 'confusion' }),
  'Chance of either Paralyzing; Burning; or Freezing target': inherit('triattack'), // the mod's draw; Aeroblast too
  'Removes Light Screen/ Reflect from target\'s side of the field': inherit('brickbreak'), // a note on an immune target (mod/moves.ts)
  'Splash effect': inherit('thief'), // the hack's Thief has Splash's effect (85): it does nothing (mod/moves.ts)
  'Metronome effect': inherit('metronome'), // the mod's draw; a call of an unmodelled move is noted (mod/moves.ts)
  'Assist effect': inherit('assist'), // the cartridge's pick (bs:6405-6450, mod/moves.ts)
  // Status moves.
  'Infatuates target of opposite gender': inherit('attract'), // subscript_infatuate.s; the mod's infatuation
  'Curse effect': inherit('curse'), // effect_script_0109.s; subscript_curse_ghost.s, subscript_curse_normal.s
  'Sharply raises a random stat of the target': inherit('acupressure'), // the cartridge's pick (bs:8932-8960, mod/moves.ts)
  'Copies all of target\'s stat boosts': inherit('psychup'), // the stages and Focus Energy (BtlCmd_CopyStatStages, bs:6042-6050; mod/moves.ts)
  'Swaps the user\'s Atk and SpAtk buffs with the target\'s Atk and SpAtk buffs': inherit('powerswap'), // effect_script_0243.s
  'Swaps the user\'s Def and SpDef buffs with the target\'s Def and SpDef buffs': inherit('guardswap'), // effect_script_0244.s
  'Swaps the user\'s Atk stat with its Def stat': inherit('powertrick'), // effect_script_0238.s
  // Wish heals the slot's Pokémon half its own max HP (bcp:1086-1104); the docs say the user's, so another recipient is
  // noted (mod/moves.ts).
  '1/2 of user\'s max HP is restored at the end of next turn': inherit('wish'),
  'Roost effect': inherit('roost'), // subscript_roost.s; the roosting battler's Flying rows are skipped (bl:2540-2543)
  // BtlCmd_WeatherHPRecovery (bs:5966-5980): Showdown's Gen 4 amounts, floored; a quarter in the deep fog (mod/moves.ts)
  'Synthesis effect': inherit('synthesis'),
  'Restores 1/16 of the user\'s max HP at the end of every turn': inherit('aquaring'), // effect_script_0251.s
  'Ingrain effect': inherit('ingrain'), // effect_script_0181.s
  'Cures user of Burn; Poison; or Paralysis': inherit('refresh'), // subscript_recover_psn_prz_brn.s
  'Prevents opponents from landing critical hits on the user\'s party for 5 turns': inherit('luckychant'), // effect_script_0240.s
  'User\'s party becomes immune to Ground-type attacks and grounded hazards for 5 turns': inherit('magnetrise'), // effect_script_0252.s
  'Ally\'s attack deals 1.5x damage this turn': inherit('helpinghand'), // no ally in singles: it fails (BtlCmd_TryHelpingHand)
  'Flees from wild single battle': inherit('teleport'), // fails in a trainer battle (effect_script_0153.s)
  'Redirects all moves to user': inherit('followme'), // succeeds in singles, changing nothing (bs:6261-6290, mod/moves.ts)
  'Reflects status moves back at their user': inherit('magiccoat'), // the ROM's Magic Coat bit (dex.ts `withRomFlags`)
  'Decreases PP of target\'s last move used by 4': inherit('spite'), // BtlCmd_TrySpite: up to 4
  'Grudge effect': inherit('grudge'), // effect_script_0194.s
  'Prevents the target from using its held item or having items used on it': inherit('embargo'), // subscript_embargo_start.s
  'Suppresses the target\'s Ability': inherit('gastroacid'), // effect_script_0239.s
  'Ignores type immunities': inherit('foresight'), // effect_script_0113.s; Odor Sleuth too
  'Causes all moves to ignore changes to the target\'s Evasiveness': inherit('miracleeye'), // effect_script_0216.s
  'Next move used by user guaranteed to hit': inherit('lockon'), // effect_script_0094.s; Mind Reader too

  // What the engine doesn't model: each reason names what the cartridge does that Showdown's Gen 4 doesn't (or what
  // wasn't checked), with its pokeplatinum lines. docs/engine-model.md lists them with the hack's moves.
  'Secret Power effect': unmodelled('its added effect depends on the battle terrain (BtlCmd_GetTerrainSecondaryEffect, bs:8063-8087), which the trainer data does not give', 'its added effect depends on where the battle takes place, which the planner doesn\'t know'),
  'Nature Power effect': unmodelled('the move it becomes depends on the battle terrain (BtlCmd_GetTerrainMove, bs:8036-8062), which the trainer data does not give', 'the move it turns into depends on where the battle takes place, which the planner doesn\'t know'),
  'Camouflage effect': unmodelled('the type it gives depends on the battle terrain (BtlCmd_TryCamouflage, bs:7997-8035), which the trainer data does not give', 'the type it gives depends on where the battle takes place, which the planner doesn\'t know'),
  'Future Sight effect': unmodelled('the cartridge computes the damage at use with the move\'s own type for items and abilities but no STAB or type chart, and rolls the hit when it lands (bs:6065-6097, subscript_future_sight_damage.s); Showdown\'s Gen 4 Future Sight is typeless with a fixed power of 80 or 120', 'its damage may differ from the game, which works it out in its own way'),
  'Hits the target up to 3 times; increases power by 10 with each hit': unmodelled('the power of each hit cannot be read: effect 104 adds 10 to a power that starts at 0 each use, so 10, 20, 30 whatever the ROM\'s power (effect_script_0104.s), and Triple Axel and Fury Cutter run the hack\'s own effect 88 (Psywave\'s slot)', 'the power of each hit can\'t be read from the game, so its damage is a guess'),
  'Deals 1/2 user\'s max HP to user if it misses': unmodelled('crash damage: the docs say half the user\'s max HP, the decompilation half the damage it would have dealt, at most half the target\'s max HP (subscript_crash_on_miss.s); a spot check decides', 'how much damage the user takes when it misses isn\'t certain'),
  'Chatter effect': unmodelled('its confusion chance comes from the user\'s recorded Chatot cry (BtlCmd_CheckChatterActivation, bs:8397-8430: 0, 10 or 30, with 1 in 100 even at 0), which the engine does not have; the ROM\'s chance is never read', 'its confusion chance depends on the Chatot\'s recorded cry, which the planner doesn\'t have'),
  'Power and effect determined by held item': unmodelled('the flung item\'s effect by its hold effect (subscript_fling.s) and the ROM\'s fling powers are not modelled', 'what the thrown item does, and the move\'s power, aren\'t predicted'),
  'Natural Gift effect': unmodelled('the berry\'s type and power (BtlCmd_CalcNaturalGiftParams, bs:8088-8115) are not checked against Showdown\'s table', 'the berry\'s type and power haven\'t been checked'),
  'Transform effect': unmodelled('what Transform copies (subscript_transform_into_target.s: the moves\' PP, the weight and the rest) is not checked against Showdown\'s', 'what it copies (PP, weight and so on) hasn\'t been fully checked'),
  'Copies user-selected move': unmodelled('the copied move\'s PP and the moves it cannot copy (BtlCmd_TryMimic, bs:4476-4534) are not checked against Showdown\'s', 'which moves it can copy, and their PP, haven\'t been checked'),
  'Sketch effect': unmodelled('it rewrites a move slot (BtlCmd_TrySketch, bs:4839-4900), not checked against Showdown\'s', 'it rewrites a move slot, which hasn\'t been checked'),
  'If the target has not moved yet; the user copies their move and uses it with 1.5x power': unmodelled('the moves it cannot copy (Move_MeFirstCanCopy) and its 1.5x (BtlCmd_TryMeFirst, bs:7286-7326) are not checked against Showdown\'s flags', 'which moves it can copy, and its 1.5x power, haven\'t been checked'),
  'User uses the last move that was used in battle': unmodelled('which move is the battle\'s last (movePrev, BtlCmd_TryCopycat, bs:7328-7340) is not matched to Showdown\'s lastMove', 'which move counts as the last one used hasn\'t been checked'),
  'Mirror Move effect': unmodelled('the cartridge copies the last move that targeted its user (moveCopied) and refuses by Encore\'s ROM-effect table (BtlCmd_SetMirrorMove, bs:3483-3520); Showdown\'s Gen 4 Mirror Move uses its own list of IDs', 'which moves it can copy may differ from the game'),
  '2x damage if the target has already taken damage this turn': unmodelled('the cartridge doubles after any HP loss through subscript_update_hp this turn (its target\'s own Curse, Substitute and Belly Drum costs too, effect_script_0231.s); Showdown\'s hurtThisTurn counts only damage through spreadDamage', 'whether it doubles can differ from the game when the target hurt itself (Curse, Substitute, Belly Drum)'),
  'User regains a consumed held item': unmodelled('the cartridge keeps the item to restore per battler slot (recycleItem, set by RemoveItem, bs:8972-8980, never cleared on a switch), a berry Bug Bite or Pluck took from it included; Showdown keeps lastItem per Pokémon', 'which item it gives back after a switch may differ from the game'),
  'Heal Bell effect': unmodelled('which Soundproof Pokémon it skips (BtlCmd_TryPartyStatusRefresh, subscript_heal_bell.s) is not checked against Showdown\'s', 'which Soundproof Pokémon it skips hasn\'t been checked'),
  'Changes the target\'s Ability to Insomnia': unmodelled('which abilities it fails against and whether it wakes its target (subscript_give_target_insomnia.s) are not checked against Showdown\'s', 'which abilities it fails against, and whether it wakes the target, haven\'t been checked'),
  'User copies target\'s Ability': unmodelled('which abilities it can copy (effect_script_0178.s, subscript_copy_ability.s) is not checked against Showdown\'s', 'which abilities it can copy haven\'t been checked'),
  'User swaps Abilities with the target': unmodelled('which abilities it can swap (subscript_exchange_abilities.s) is not checked against Showdown\'s', 'which abilities it can swap haven\'t been checked'),
  'Fly effect': unmodelled('the flying turn\'s exceptions are Showdown\'s by move ID (Gust, Twister, Thunder, Hurricane); the cartridge\'s are by ROM effect (SYSCTL_HIT_DURING_FLY), so the hack\'s Twister and Hurricane differ', 'which moves can still hit the flying Pokémon may differ from the game'),
  'Shadow Force effect': unmodelled('the vanishing turn\'s exceptions are the cartridge\'s by ROM effect (SYSCTL_HIT_DURING_SHADOW_FORCE, effect_script_0272.s), not checked against Showdown\'s', 'which moves can still hit the vanished Pokémon haven\'t been checked'),
  'Beat Up effect': unmodelled('Gen 4 Beat Up\'s per-member hits (BtlCmd_BeatUp, bs:6173-6260) are not checked against Showdown\'s', 'the hits of each party member haven\'t been checked'),
  'Cures user of any status condition and afflicts the target with it': unmodelled('not checked against BtlCmd_CheckCanShareStatus and subscript_give_target_own_status.s; no trainer has it', 'it hasn\'t been checked against the game, but no trainer uses it'),
  // Its clearing of the deep fog is modelled (subscript_defog.s:64-67, mod/moves.ts `defogOnHit`); the rest is not.
  'Defog effect': unmodelled('only its clearing of the deep fog is checked against subscript_defog.s (:64-67); Showdown\'s Defog also clears the hazards on its user\'s own side, which the script does not (:5-62 read the defender\'s side only); no trainer has it', 'its effect on entry hazards may differ from the game, but no trainer uses it'),
  'Next move deals 2x damage if it is Electric-type': unmodelled('how long the charge lasts (MOVE_EFFECT_CHARGE) is not checked against Showdown\'s, and its ROM effect 174 also raises Special Defense, which the docs leave out; no trainer has it', 'how long the charge lasts, and its extra Special Defense boost, haven\'t been checked, but no trainer uses it'),
  'Conversion2 effect': unmodelled('its type pick is a random draw left raw (BtlCmd_TryConversion2, bs:4765-4838); no trainer has it', 'the type it picks is a random draw the planner can\'t predict, but no trainer uses it'),
  'Type= Type of Plate held by user': unmodelled('the plate\'s type under Klutz and Embargo (effect_script_0268.s\'s hold-effect checks) is not checked against Showdown\'s Judgment; no trainer has it', 'which type it becomes with Klutz or Embargo hasn\'t been checked, but no trainer uses it'),
});

/** The reason for a move whose effect text has no entry: a text that isn't the docs' (or a new docs text). */
export const NO_ENTRY_REASON = 'no engine entry for its effect text';
/** What the page says for it, and for the two mismatches in `engineEffect`. */
export const NO_ENTRY_PLAIN = "the planner has no rule for this move's effect";

/**
 * The engine behaviour of `move`: its effect text's `ENGINE_EFFECTS` entry. A text with no entry is unmodelled, and so
 * is a status-move entry (`status`, `heal`) on a damaging move or a damaging-move entry (`secondary`) on a status move,
 * which the docs' texts never pair.
 */
export function engineEffect(move: KaizoMove): EngineEffect {
  const key = normaliseEffectText(move.effectText);
  const effect = Object.hasOwn(ENGINE_EFFECTS, key) ? ENGINE_EFFECTS[key]! : undefined;
  if (effect === undefined) return { kind: 'unmodelled', reason: NO_ENTRY_REASON, plain: NO_ENTRY_PLAIN };
  const statusMove = move.category === 'status';
  if ((effect.kind === 'status' || effect.kind === 'heal') && !statusMove) return { kind: 'unmodelled', reason: `a status-move effect on a ${move.category} move`, plain: NO_ENTRY_PLAIN };
  if (effect.kind === 'secondary' && statusMove) return { kind: 'unmodelled', reason: 'a damaging-move effect on a status move', plain: NO_ENTRY_PLAIN };
  return effect;
}

/** An entry the engine builds the Showdown behaviour of itself (`behaviourFields`). */
export type TableEffect = Extract<EngineEffect, { kind: 'plain' | 'secondary' | 'status' | 'heal' }>;

export const isTableEffect = (effect: EngineEffect): effect is TableEffect =>
  effect.kind === 'plain' || effect.kind === 'secondary' || effect.kind === 'status' || effect.kind === 'heal';

/**
 * The Showdown move fields of a table-built behaviour for `move` (whose effect text has `effect`): the
 * `EFFECT_MAP` mechanics for the text, then the entry's own effects. Fields only, no callbacks.
 */
export function behaviourFields(effect: TableEffect, move: KaizoMove): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const key = normaliseEffectText(move.effectText);
  const spec = Object.hasOwn(EFFECT_MAP, key) ? EFFECT_MAP[key]! : {};
  if (spec.hits !== undefined) fields['multihit'] = Array.isArray(spec.hits) ? [...spec.hits] : spec.hits;
  if (spec.recoil !== undefined) fields['recoil'] = [...spec.recoil];
  if (spec.drain !== undefined) fields['drain'] = [...spec.drain];
  if (spec.critStage !== undefined) fields['critRatio'] = 1 + spec.critStage; // Showdown counts crit stages from 1
  if (spec.ignoresAccuracy) fields['accuracy'] = true;
  if (spec.alwaysCrit) fields['willCrit'] = true;
  switch (effect.kind) {
    case 'plain':
      break;
    case 'secondary': {
      const rate = effect.chance ?? move.effectChance;
      if (rate <= 0) break; // never passes the cartridge's `RandNext() % 100 < effectChance`
      if (effect.self && effect.boosts && rate >= 100) {
        fields['self'] = { boosts: { ...effect.boosts } }; // sure, on hit: Showdown's `self`
        break;
      }
      const secondaries: Record<string, unknown>[] = [];
      if (effect.status) secondaries.push({ chance: rate, status: effect.status });
      if (effect.volatile) secondaries.push({ chance: rate, volatileStatus: effect.volatile });
      if (effect.boosts) secondaries.push(effect.self ? { chance: rate, self: { boosts: { ...effect.boosts } } } : { chance: rate, boosts: { ...effect.boosts } });
      fields['secondaries'] = secondaries;
      break;
    }
    case 'status':
      if (effect.status) fields['status'] = effect.status;
      if (effect.volatile) fields['volatileStatus'] = effect.volatile;
      if (effect.boosts) fields['boosts'] = { ...effect.boosts };
      break;
    case 'heal':
      fields['heal'] = [...effect.fraction];
      break;
  }
  return fields;
}
