// The `platkaizo` mod's ability and item procs: Showdown's Gen 4 handlers with the cartridge's draws as
// labelled picks (chance.ts) and the cartridge's conditions for drawing. Citations are pokeplatinum (bl =
// src/battle/battle_lib.c, bcp = src/battle/battle_controller_player.c, res/items/data/*.json for item parameters).
// BrightPowder and Lax Incense act in the hit rate (mod/accuracy.ts). The hack's own item changes are
// mod/items.ts's, and every item parameter here is the ROM's (mod/itemData.ts).
//
// | Proc                                    | Cartridge                                            | Label                        |
// |-----------------------------------------|------------------------------------------------------|------------------------------|
// | Static, Poison Point, Flame Body         | `r % 10 < 3` on a contact hit (bl:4214-4230, :4303-4337) | `abilityProc`, the status |
// | Effect Spore                            | `r % 10 < 3`, then `r % 3`: poison, paralysis, sleep (bl:4273-4301) | `abilityProc`    |
// | Cute Charm                              | `r % 10 < 3` (bl:4339-4356)                          | `abilityProc`, `attract`     |
// | Shed Skin                               | `r % 10 < 3` at the end of turn (bl:3567-3587)       | `abilityProc`, `cure`        |
// | King's Rock, Razor Fang                 | `r % 100 < param` (the ROM's: 11 and 10) on a move with the King's Rock flag (bcp:4645-4669) | `itemProc`, `flinch` (scripts.ts) |
// | Focus Band                              | `r % 100 < param` (the ROM's: 10) (bcp:3386-3388)   | `itemProc`, `endure`         |

import PS from 'pokemon-showdown';
import type { Side } from '../../contracts/engine.js';
import { type ChanceOption, pickLabelled } from '../chance.js';
import { installedMoves } from '../dex.js';
import { heldParam } from './itemData.js';
import { pinchSwitchIn } from './items.js';
import { belowWeight, residueWeights, U16 } from '../odds.js';
import { addUnmodelledNote } from '../unmodelled.js';

const sideOf = (pokemon: Pokemon): Side => pokemon.side.id as Side;

/** Showdown's Gen 4 Bad Dreams handler (data/abilities.ts, `baddreams`), which the mod's wraps. */
const GEN4_BAD_DREAMS = (PS.Dex.mod('gen4').data.Abilities['baddreams'] as unknown as { onResidual: (this: Battle, pokemon: Pokemon) => unknown }).onResidual;

const yesNo = (yes: bigint, yesName: string, noName: string): ChanceOption[] => [{ weight: yes, outcome: yesName }, { weight: U16 - yes, outcome: noName }];

/** `MOVE_FLAG_MAKES_CONTACT` and `MOVE_FLAG_TRIGGERS_KINGS_ROCK`: bits 0 and 5 of the ROM's move flags (generated/move_flags.txt). */
const CONTACT_FLAG = 0x01;
const KINGS_ROCK_FLAG = 0x20;

/**
 * Whether `move` has a ROM flag. A hack move has the ROM's flags, which the cartridge reads; a move the hack doesn't
 * define (none in a battle, short of Showdown's own pseudo-moves) falls back to `fallback`.
 */
function romFlag(move: ActiveMove, flag: number, fallback: boolean): boolean {
  const kaizo = installedMoves().get(move.num);
  return kaizo === undefined ? fallback : (kaizo.flags & flag) !== 0;
}

/** `RandNext() % 10 < 3`: 19662 of the draws. */
const ABILITY_PROC = belowWeight(10, 3);

/** Effect Spore's status, `RandNext() % 3` (bl:4282-4293): 0 poison, 1 paralysis, 2 sleep. */
const EFFECT_SPORE: readonly ChanceOption[] = (['psn', 'par', 'slp'] as const).map((status, i) => ({ weight: residueWeights(3)[i]!, outcome: status }));

/**
 * Whether a hit on the holder can trigger its contact ability (bl:4200-4230): the attacker alive, damage taken, the
 * move's ROM contact flag, and (for the status ones) an attacker with no status.
 */
const contactHit = (damage: number, move: ActiveMove, source: Pokemon, needsNoStatus: boolean): boolean =>
  !!damage && romFlag(move, CONTACT_FLAG, !!move.flags['contact']) && source.hp > 0 && (!needsNoStatus || !source.status);

/** Static, Poison Point or Flame Body: `status` on a contact attacker for 19662 of the draws. */
function contactStatus(id: string, status: string) {
  return function onDamagingHit(this: Battle, damage: number, target: Pokemon, source: Pokemon, move: ActiveMove) {
    if (!contactHit(damage, move, source, true)) return;
    if (pickLabelled(this, 'abilityProc', sideOf(target), id, yesNo(ABILITY_PROC, status, 'none')) === 0) source.trySetStatus(status, target);
  };
}

/** `BATTLE_EFFECT_HALVE_DEFENSE` and `BATTLE_EFFECT_FLINCH_BURN_HIT` (generated/move_battle_effects.txt: 7, 273). */
export const HALVE_DEFENSE_EFFECT = 7;
const FLINCH_BURN_HIT_EFFECT = 273;

/** The ROM effect of `move`, or undefined for a move the hack doesn't define. */
const romEffectOf = (move: ActiveMove): number | undefined => installedMoves().get(move.num)?.romEffect;

/** The mod's `Abilities` entries, merged over Showdown's Gen 4 ones. */
export const KAIZO_ABILITIES: Record<string, Record<string, unknown>> = {
  // Damp stops every move with Explosion's ROM effect: effect 7's script checks it first (effect_script_0007.s:5,
  // `CheckIgnorableAbility ... BTLSCR_ALL_BATTLERS, ABILITY_DAMP`), so the hack's Memento too. Showdown's checks the
  // IDs of Explosion and Self-Destruct (data/abilities.ts `damp.onAnyTryMove`).
  damp: {
    onAnyTryMove(this: Battle, target: Pokemon, _source: Pokemon, effect: ActiveMove) {
      const rom = romEffectOf(effect);
      if (rom === undefined ? !['explosion', 'selfdestruct'].includes(effect.id) : rom !== HALVE_DEFENSE_EFFECT) return;
      this.attrLastMove('[still]');
      this.add('cant', this.effectState['target'] as Pokemon, 'ability: Damp', effect, `[of] ${target}`);
      return false;
    },
  },
  // Wonder Guard never stops a move with the ROM effect FLINCH_BURN_HIT: `MoveIsOnDamagingTurn` (bl:7588-7605) counts
  // it as a charging move, never on its damaging turn (the cartridge's Fire Fang bug). Showdown's Gen 4 Wonder Guard
  // lets Fire Fang through by ID (data/mods/gen4/abilities.ts `wonderguard`); the rest of its check is unchanged.
  wonderguard: {
    onTryHit(this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) {
      const rom = romEffectOf(move);
      if (rom === undefined ? move.id === 'firefang' : rom === FLINCH_BURN_HIT_EFFECT) return;
      if (target === source || move.category === 'Status' || move.type === '???') return;
      if (target.runEffectiveness(move) <= 0 || !target.runImmunity(move)) {
        this.add('-immune', target, '[from] ability: Wonder Guard');
        return null;
      }
    },
  },
  static: { onDamagingHit: contactStatus('static', 'par') },
  poisonpoint: { onDamagingHit: contactStatus('poisonpoint', 'psn') },
  flamebody: { onDamagingHit: contactStatus('flamebody', 'brn') },
  effectspore: {
    onDamagingHit(this: Battle, damage: number, target: Pokemon, source: Pokemon, move: ActiveMove) {
      if (!contactHit(damage, move, source, true)) return;
      if (pickLabelled(this, 'abilityProc', sideOf(target), 'effectspore', yesNo(ABILITY_PROC, 'proc', 'none')) !== 0) return;
      const status = EFFECT_SPORE[pickLabelled(this, 'abilityProc', sideOf(target), 'effectspore', EFFECT_SPORE)]!.outcome;
      source.trySetStatus(status, target);
    },
  },
  cutecharm: {
    // The attacker not attracted already and the holder alive (bl:4340-4347); the genders are the subscript's check.
    onDamagingHit(this: Battle, damage: number, target: Pokemon, source: Pokemon, move: ActiveMove) {
      if (!contactHit(damage, move, source, false) || source.volatiles['attract'] || target.hp <= 0) return;
      if (pickLabelled(this, 'abilityProc', sideOf(target), 'cutecharm', yesNo(ABILITY_PROC, 'attract', 'none')) === 0) {
        source.addVolatile('attract', this.effectState['target'] as Pokemon);
      }
    },
  },
  shedskin: {
    onResidualOrder: 10,
    onResidualSubOrder: 3,
    onResidual(this: Battle, pokemon: Pokemon) {
      if (!pokemon.hp || !pokemon.status) return;
      if (pickLabelled(this, 'abilityProc', sideOf(pokemon), 'shedskin', yesNo(ABILITY_PROC, 'cure', 'none')) !== 0) return;
      this.add('-activate', pokemon, 'ability: Shed Skin');
      pokemon.cureStatus();
    },
  },
  baddreams: {
    // MON_COND_CHECK_STATE_BAD_DREAMS is the sleeper's own condition (bcp:1484-1503), in its list; Showdown's is the
    // holder's, in the holder's list. Where it hurts, the end of turn's order can differ: noted.
    onResidual(this: Battle, pokemon: Pokemon) {
      if (pokemon.hp && pokemon.foes().some((target) => target.status === 'slp')) addUnmodelledNote(this, BAD_DREAMS_NOTE);
      return GEN4_BAD_DREAMS.call(this, pokemon);
    },
  },
};

/** The note for Bad Dreams hurting a sleeper, which the cartridge does in the sleeper's end-of-turn list. */
export const BAD_DREAMS_NOTE = 'engine: Bad Dreams runs in its holder\'s end-of-turn list, the cartridge\'s in the sleeper\'s';

/** King's Rock's and Razor Fang's `effectParam` in vanilla (res/items/data/kings_rock.json, razor_fang.json): 10. The hack's King's Rock is 11. */
const VANILLA_FLINCH_ITEM_POWER = 10;
/** Focus Band's `effectParam` in vanilla (res/items/data/focus_band.json): 10. */
const VANILLA_FOCUS_BAND_POWER = 10;

/**
 * King's Rock and Razor Fang (`HOLD_EFFECT_SOMETIMES_FLINCH`): a flinch for `r % 100 < itemPower` on a move with the
 * ROM's King's Rock flag (bcp:4645-4669), not Showdown's list of move names. Serene Grace never touches it: the
 * cartridge reads the raw `itemPower` there, while Serene Grace doubles only the move's own effect chance (bl:1552-1556,
 * :1571-1575). It runs as a secondary effect, whose draw scripts.ts labels `itemProc` by the item and weighs by
 * `kaizoItemPower` (so a doubled `chance` changes nothing); it is also added after Showdown's Serene Grace
 * (`onModifyMovePriority` −2, data/abilities.ts `serenegrace`), so the effect's own `chance` stays the item's.
 */
function flinchItem(item: string) {
  return {
    onModifyMovePriority: -3,
    onModifyMove(this: Battle, move: ActiveMove) {
      if (move.category === 'Status' || !romFlag(move, KINGS_ROCK_FLAG, false)) return;
      const power = heldParam(item, VANILLA_FLINCH_ITEM_POWER);
      (move.secondaries ??= []).push({ chance: power, volatileStatus: 'flinch', kaizoItemProc: item, kaizoItemPower: power } as never);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The switch-in checks

/** The note for a Transformed Giratina-Origin, which the cartridge reverts by recomputing its copied stats. */
export const TRANSFORMED_GIRATINA_NOTE = 'engine: a Transformed Giratina-Origin (the cartridge recomputes its copied stats as Altered Forme)';

/**
 * The checks the cartridge's switch-in sequence makes after the abilities (`BattleSystem_TriggerEffectOnSwitch`,
 * bl:3620-3640, after Intimidate, Download, Forewarn and the rest), run after each Showdown switch-in's own effects
 * (mod/scripts.ts `runSwitch`), for every Pokémon out:
 * - `SWITCH_IN_CHECK_STATE_FORM_CHANGE` (bl:4115-4120, `BattleSystem_TriggerFormChange` bl:6412-6417): a Giratina-Origin
 *   with HP left and no Griseous Orb outside the Distortion World (no trainer battle is in it) turns Altered, its
 *   stats and ability the Altered Forme's. Showdown never reverts it.
 * - `SWITCH_IN_CHECK_STATE_HELD_ITEM_STATUS` (bl:4152-4160, `BattleSystem_TriggerHeldItemOnStatus` bl:5088-5099): White
 *   Herb restores every lowered stage at once and is used up, so it undoes a switch-in Intimidate before anyone moves.
 *   Showdown's White Herb reacts at its own switch-in and after moves, so a lead's missed the other lead's Intimidate.
 *   Here the held herb runs Showdown's own routine (its `onStart`: `useItem`, then `onUse` restores the stages with
 *   `-clearnegativeboost [silent]`), which the trainer AI's battle-start view reads by the `-enditem` line. None under Klutz or Embargo
 *   (`Battler_HeldItemEffect`, bl:5352-5363).
 * The form change is the Pokémon's own, so its order across the two sides changes nothing but the log's.
 */
export function switchInChecks(battle: Battle): void {
  for (const pokemon of battle.getAllActive()) {
    if (pokemon.hp > 0 && pokemon.species.id === 'giratinaorigin' && pokemon.item !== 'griseousorb') {
      if (pokemon.transformed) addUnmodelledNote(battle, TRANSFORMED_GIRATINA_NOTE);
      // Permanent, no source: Showdown's `detailschange` line, the Altered Forme's ability and stats (sim/pokemon.ts `formeChange`).
      else pokemon.formeChange('Giratina', null as unknown as Effect, true);
    }
  }
  for (const pokemon of battle.getAllActive()) {
    if (pokemon.hp <= 0 || pokemon.ignoringItem() || pokemon.item !== 'whiteherb') continue;
    if (Object.values(pokemon.boosts).some((stage) => stage < 0)) battle.singleEvent('Start', pokemon.getItem(), pokemon.itemState, pokemon);
  }
  // The same step's pinch items whose parameter is 0 (Ganlon Berry, Apicot Berry, Shoal Salt): eaten at entry (mod/items.ts).
  pinchSwitchIn(battle);
}

/** The mod's item procs, merged with the speed order's items (dex.ts) over Showdown's Gen 4 ones. */
export const KAIZO_ITEM_PROCS: Record<string, Record<string, unknown>> = {
  kingsrock: flinchItem('kingsrock'),
  razorfang: flinchItem('razorfang'),
  focusband: {
    // `r % 100 < 10` (bcp:3386-3388) matters only when the hit would knock the holder out, so it is drawn only then;
    // Endure's handler goes first and leaves no such hit (bcp:3385).
    onDamagePriority: -40,
    onDamage(this: Battle, damage: number, target: Pokemon, _source: Pokemon, effect: Effect | null) {
      if (!(damage >= target.hp && effect?.effectType === 'Move')) return;
      if (pickLabelled(this, 'itemProc', sideOf(target), 'focusband', yesNo(belowWeight(100, heldParam('focusband', VANILLA_FOCUS_BAND_POWER)), 'endure', 'none')) !== 0) return;
      this.add('-activate', target, 'item: Focus Band');
      return target.hp - 1;
    },
  },
};
