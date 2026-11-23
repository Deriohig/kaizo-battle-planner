// The docs' "Additional Effect" texts with no bearing on the damage of the move's own hit, so the calc treats the move
// as a plain hit and never reports it as unmodelled. effectMap.ts has the texts that do bear on damage, and why each
// docs text is in exactly one list. The battle engine handles what these do; a state one of them leaves behind that
// changes later damage (weather, screens, Helping Hand, Charge, stat stages) is an input to that later calc.

import { normaliseEffectText } from './effectMap.js';

const GROUPS: Record<string, string[]> = {
  // No effect at all.
  none: ['None'],

  // A status condition, confusion, flinch or infatuation, as a chance or for certain. None changes this hit's damage.
  status: [
    'Badly Poisons', 'Causes Sleep', 'Chance of Badly Poisoning', 'Chance of causing Burn; chance of causing Flinch',
    'Chance of causing Freeze; chance of causing Flinch', 'Chance of causing Paralysis; chance of causing Flinch',
    'Chance of either Paralyzing; Burning; or Freezing target', 'Chance to Burn', 'Chance to Confuse', 'Chance to Flinch',
    'Chance to Freeze', 'Chance to Paralyze', 'Chance to Poison', 'Guaranteed Burn; activates Flash Fire',
    'Guaranteed Confusion (Status)', 'Guaranteed Paralysis', 'Guaranteed Poison', 'Infatuates target of opposite gender',
    'Thaws user; chance to Burn', 'Chatter effect', 'Secret Power effect', 'Raises target\'s SpAtk and causes Confusion',
    'Sharply raises target\'s Atk and causes Confusion', 'Cures user of any status condition and afflicts the target with it',
  ],

  // Stat stages, raised or lowered, on the user or the target, including a damaging move's drop after its hit.
  statStages: [
    'Ancient Power boost', 'Chance of lowering target\'s SpDef harshly', 'Chance of raising Atk', 'Chance of raising Def',
    'Chance of raising user\'s SpAtk', 'Lowers Accuracy (Attack)', 'Lowers Accuracy (Status)', 'Lowers Atk (Status)',
    'Lowers Def (Attack)', 'Lowers Def (Status)', 'Lowers Evasion (Status)', 'Lowers SpAtk (Attack)', 'Lowers Spd (Attack)',
    'Lowers Spd (Status)', 'Lowers SpDef (Attack)', 'Lowers target\'s Atk and Def', 'Lowers user\'s Spd', 'Raises Atk',
    'Raises Def', 'Raises Evasion', 'Raises SpAtk', 'Raises user\'s Atk and Def', 'Raises user\'s Atk and Spd',
    'Raises user\'s Def and SpDef', 'Raises user\'s SpAtk and SpDef', 'Sharply lowers Accuracy (Status)',
    'Sharply lowers Atk (Status)', 'Sharply lowers Def (Status)', 'Sharply lowers SpAtk (Status)',
    'Sharply lowers Spd (Status)', 'Sharply raises a random stat of the target', 'Sharply raises Atk (Status)',
    'Sharply raises crit ratio', 'Sharply raises Def (Status)', 'Sharply raises Evasion (Status)',
    'Sharply raises SpAtk (Status)', 'Sharply raises Spd (Status)', 'Sharply raises SpDef (Status)', 'Belly Drum effect',
    'Curse effect', 'Copies all of target\'s stat boosts', 'Resets stat changes', 'Prevents lowering of stats',
    'Swaps the user\'s Atk and SpAtk buffs with the target\'s Atk and SpAtk buffs',
    'Swaps the user\'s Def and SpDef buffs with the target\'s Def and SpDef buffs',
    'Swaps the user\'s Atk stat with its Def stat',
  ],

  // Healing, HP exchanged or lost over time, and fainting effects: none is a damaging hit. "Whirlpool effect" traps and
  // chips 1/16 each turn; its 2x against a diving target can't happen (see the last group).
  hp: [
    '1/2 of user\'s max HP is restored at the end of next turn', 'Causes Sleep and restores all HP',
    'Restores up to 50% max HP', 'Roost effect', 'Synthesis effect',
    'Restores 1/16 of the user\'s max HP at the end of every turn', 'Ingrain effect', 'Leech Seed effect',
    'Pain Split effect', 'Heal Bell effect', 'Cures user of Burn; Poison; or Paralysis', 'Whirlpool effect',
    'Destiny Bond effect', 'All users on field faint in 3 turns',
  ],

  // Weather, screens, hazards and other field or side states. A later calc reads the state they leave (Helping Hand and
  // Charge boost the next attack), but these moves deal no damage themselves.
  field: [
    '1/2 damage from Physical attacks', '1/2 damage from Special attacks', '2x Spd for user\'s party for 3 turns',
    'Causes Hail', 'Causes Harsh Sunlight', 'Causes Rain', 'Causes Sandstorm', 'Gravity effect', 'Trick Room effect',
    'Safeguard effect', 'Spikes effect', 'Stealth Rocks effect', 'Toxic Spikes effect', 'Defog effect',
    'Prevents opponents from landing critical hits on the user\'s party for 5 turns',
    'User\'s party becomes immune to Ground-type attacks and grounded hazards for 5 turns',
    'Ally\'s attack deals 1.5x damage this turn', 'Next move deals 2x damage if it is Electric-type',
  ],

  // Protection, switching, trapping and redirection.
  protectionAndSwitching: [
    'Allows user to endure a fatal hit and survive at 1 HP', 'Protect/ Detect effect', 'Substitute effect',
    'Baton Pass effect', 'Whirlwind/ Roar effect', 'Flees from wild single battle',
    'Prevents target from switching out or fleeing', 'Switches user out after dealing damage', 'Redirects all moves to user',
    'Reflects status moves back at their user',
  ],

  // Moves, PP, items, abilities, types and accuracy states. "Ignores type immunities" (Foresight) leaves a state that
  // later calcs read; the hack's text says every type immunity, wider than vanilla's Ghost-only rule.
  movesItemsAbilities: [
    'Decreases PP of target\'s last move used by 4', 'Disables last move used for 4-7 turns',
    'Locks target into last move used for 3-7 turns', 'Target is prevented from using moves shared with the user',
    'Torment effect', 'Grudge effect', 'Copies user-selected move', 'Sketch effect',
    'Prevents the target from using its held item or having items used on it', 'Renders the target\'s held item unusable',
    'Consumes target\'s berry', 'User regains a consumed held item', 'Pay Day effect',
    'Changes the target\'s Ability to Insomnia', 'Suppresses the target\'s Ability', 'User copies target\'s Ability',
    'User swaps Abilities with the target', 'Camouflage effect', 'Conversion2 effect', 'Transform effect',
    'Ignores type immunities', 'Causes all moves to ignore changes to the target\'s Evasiveness',
    'Next move used by user guaranteed to hit',
  ],

  // Charge and recharge turns, multi-turn locks, priority, and conditions for the move to work at all: when the move
  // lands, its hit is a plain hit. A move that fails is a miss, which the accuracy and engine layers handle.
  turnsAndConditions: [
    'Recharge turn', 'Fly effect', 'Uproar effect', 'Priority +1', 'Focus Punch effect',
    'Guaranteed Flinch; can only be used turn 1', 'Can only be used while asleep; chance of causing Flinch',
    'Fails unless the user has used all of its other moves at least once',
  ],

  // Accuracy in weather only. The sheet's hit chance reads these from the move's effect text.
  weatherAccuracy: ['Always hits in Hail', 'Always hits in rain; chance to Confuse', 'Always hits in rain; chance to Paralyze'],

  // Doubling against a target underground or underwater, which can't happen: the docs give Dig and Dive no effect
  // ("None"), so no Pokémon digs or dives in the hack. The classification test checks that the docs still say so.
  cannotHappen: ['2x Damage on Pokemon using Dig', '2x Damage on Pokemon using Dive'],
};

/** The normalised texts (`normaliseEffectText`) with no bearing on the damage of the move's own hit. */
export const NO_DAMAGE_EFFECTS: ReadonlySet<string> = new Set(Object.values(GROUPS).flat().map(normaliseEffectText));
