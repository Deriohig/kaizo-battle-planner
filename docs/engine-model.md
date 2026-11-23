# Battle engine: what it models

The engine runs Pokémon Showdown 0.11.11's Gen 4 with the `platkaizo` mod. Every docs "Additional Effect"
text has an entry in `ENGINE_EFFECTS` (`src/engine/effects.ts`). Each entry is one of:

- table-built from the text;
- Showdown's move of that behaviour, with the cartridge's overrides where pokeplatinum differs (`src/engine/mod/*.ts`,
  each citing its lines);
- unmodelled, with a reason.

The damage order is the last section.

## Unmodelled moves

The engine doesn't model the moves below. For each one, `unmodelledIn` names the move whenever it is in a battle,
on either side. Any line through such a battle is unproven. The solver uses `isUnmodelled(moveId)` for the same check.
A Metronome that calls one of these moves is noted in that outcome.

The list is `unmodelledMoves` over the hack's real data:

- Moves are in move-ID order.
- "Trainers" counts the singles trainers whose own moves include one of them. There are 421 such trainers, and their
  variants' parties are included.
- The test `unmodelled list is stable` (`test/unit/engine/mechanics.test.ts`) checks this table against
  `ENGINE_EFFECTS` and, where `data/` is saved, against the real data.

The engine also reports, separately from this list, what it notes during a battle (`unmodelledNotes`). The engine models the trainer field note and the pinch items whose hold-effect parameter is 0 (Ganlon Berry, Apicot Berry, Shoal
Salt), so `unmodelledIn` no longer reports them (see "Held items, abilities and the field" below). It checks Micle Berry where the cartridge checks it, with no EXP note, and does the same for the other pinch berries, drawing Starf Berry's stat as a labelled chance, so a line where one is eaten is no longer unlabelled (same section). It checks the rest of the triggers' family (the healing and cure berries, Leppa, Mental Herb) at the same points, and spends a Micle boost where the cartridge's hit-rate formula runs.

A move the engine models is never reported just because the damage calc can't reproduce it. The engine is the model of record.

<!-- unmodelled-list: start -->
| Effect text | Moves | Reason | Trainers |
|---|---|---|---|
| Secret Power effect | Secret Power | its added effect depends on the battle terrain (BtlCmd_GetTerrainSecondaryEffect, bs:8063-8087), which the trainer data does not give | 35 |
| Future Sight effect | Future Sight, Doom Desire | the cartridge computes the damage at use with the move's own type for items and abilities but no STAB or type chart, and rolls the hit when it lands (bs:6065-6097, subscript_future_sight_damage.s); Showdown's Gen 4 Future Sight is typeless with a fixed power of 80 or 120 | 23 |
| Hits the target up to 3 times; increases power by 10 with each hit | Triple Axel, Triple Kick, Fury Cutter, Rock Wrecker | the power of each hit cannot be read: effect 104 adds 10 to a power that starts at 0 each use, so 10, 20, 30 whatever the ROM's power (effect_script_0104.s), and Triple Axel and Fury Cutter run the hack's own effect 88 (Psywave's slot) | 20 |
| Nature Power effect | Nature Power | the move it becomes depends on the battle terrain (BtlCmd_GetTerrainMove, bs:8036-8062), which the trainer data does not give | 17 |
| Deals 1/2 user's max HP to user if it misses | Jump Kick, Hi Jump Kick | crash damage: the docs say half the user's max HP, the decompilation half the damage it would have dealt, at most half the target's max HP (subscript_crash_on_miss.s); a spot check decides | 10 |
| Transform effect | Transform | what Transform copies (subscript_transform_into_target.s: the moves' PP, the weight and the rest) is not checked against Showdown's | 9 |
| Chatter effect | Chatter | its confusion chance comes from the user's recorded Chatot cry (BtlCmd_CheckChatterActivation, bs:8397-8430: 0, 10 or 30, with 1 in 100 even at 0), which the engine does not have; the ROM's chance is never read | 6 |
| Power and effect determined by held item | Fling | the flung item's effect by its hold effect (subscript_fling.s) and the ROM's fling powers are not modelled | 5 |
| If the target has not moved yet; the user copies their move and uses it with 1.5x power | Me First | the moves it cannot copy (Move_MeFirstCanCopy) and its 1.5x (BtlCmd_TryMeFirst, bs:7286-7326) are not checked against Showdown's flags | 4 |
| Copies user-selected move | Mimic | the copied move's PP and the moves it cannot copy (BtlCmd_TryMimic, bs:4476-4534) are not checked against Showdown's | 3 |
| User swaps Abilities with the target | Skill Swap | which abilities it can swap (subscript_exchange_abilities.s) is not checked against Showdown's | 3 |
| Changes the target's Ability to Insomnia | Worry Seed | which abilities it fails against and whether it wakes its target (subscript_give_target_insomnia.s) are not checked against Showdown's | 2 |
| Shadow Force effect | Shadow Force | the vanishing turn's exceptions are the cartridge's by ROM effect (SYSCTL_HIT_DURING_SHADOW_FORCE, effect_script_0272.s), not checked against Showdown's | 2 |
| User uses the last move that was used in battle | Copycat | which move is the battle's last (movePrev, BtlCmd_TryCopycat, bs:7328-7340) is not matched to Showdown's lastMove | 2 |
| 2x damage if the target has already taken damage this turn | Assurance | the cartridge doubles after any HP loss through subscript_update_hp this turn (its target's own Curse, Substitute and Belly Drum costs too, effect_script_0231.s); Showdown's hurtThisTurn counts only damage through spreadDamage | 1 |
| Camouflage effect | Camouflage | the type it gives depends on the battle terrain (BtlCmd_TryCamouflage, bs:7997-8035), which the trainer data does not give | 1 |
| Heal Bell effect | Heal Bell, Aromatherapy | which Soundproof Pokémon it skips (BtlCmd_TryPartyStatusRefresh, subscript_heal_bell.s) is not checked against Showdown's | 1 |
| Mirror Move effect | Mirror Move | the cartridge copies the last move that targeted its user (moveCopied) and refuses by Encore's ROM-effect table (BtlCmd_SetMirrorMove, bs:3483-3520); Showdown's Gen 4 Mirror Move uses its own list of IDs | 1 |
| User copies target's Ability | Role Play | which abilities it can copy (effect_script_0178.s, subscript_copy_ability.s) is not checked against Showdown's | 1 |
| User regains a consumed held item | Recycle | the cartridge keeps the item to restore per battler slot (recycleItem, set by RemoveItem, bs:8972-8980, never cleared on a switch), a berry Bug Bite or Pluck took from it included; Showdown keeps lastItem per Pokémon | 1 |
| Beat Up effect | Beat Up | Gen 4 Beat Up's per-member hits (BtlCmd_BeatUp, bs:6173-6260) are not checked against Showdown's | 0 |
| Conversion2 effect | Conversion 2 | its type pick is a random draw left raw (BtlCmd_TryConversion2, bs:4765-4838); no trainer has it | 0 |
| Cures user of any status condition and afflicts the target with it | Psycho Shift | not checked against BtlCmd_CheckCanShareStatus and subscript_give_target_own_status.s; no trainer has it | 0 |
| Defog effect | Defog | only its clearing of the deep fog is checked against subscript_defog.s (:64-67); Showdown's Defog also clears the hazards on its user's own side, which the script does not (:5-62 read the defender's side only); no trainer has it | 0 |
| Fly effect | Fly | the flying turn's exceptions are Showdown's by move ID (Gust, Twister, Thunder, Hurricane); the cartridge's are by ROM effect (SYSCTL_HIT_DURING_FLY), so the hack's Twister and Hurricane differ | 0 |
| Natural Gift effect | Natural Gift | the berry's type and power (BtlCmd_CalcNaturalGiftParams, bs:8088-8115) are not checked against Showdown's table | 0 |
| Next move deals 2x damage if it is Electric-type | Charge | how long the charge lasts (MOVE_EFFECT_CHARGE) is not checked against Showdown's, and its ROM effect 174 also raises Special Defense, which the docs leave out; no trainer has it | 0 |
| Sketch effect | Sketch | it rewrites a move slot (BtlCmd_TrySketch, bs:4839-4900), not checked against Showdown's | 0 |
| Type= Type of Plate held by user | Judgment | the plate's type under Klutz and Embargo (effect_script_0268.s's hold-effect checks) is not checked against Showdown's Judgment; no trainer has it | 0 |
<!-- unmodelled-list: end -->

## Held items, abilities and the field

**Item numbers come from the ROM**. `src/rom/items.ts` decodes each item's hold effect and parameter (bytes 2
and 3 of its item-data entry); the engine's handlers read them through `src/engine/mod/itemData.ts` (`heldParam`), so
`installKaizoDex` refuses a `romdata.json` that an older extract wrote (`npm run extract` again). The hack differs from
vanilla Platinum in these items, which `test/real/engineVsCalcItems.test.ts` pins:

| Items | Vanilla | Hack | Engine |
|---|---|---|---|
| King's Rock (221) | 10 | 11 | flinch `r % 100 < param` (Razor Fang stays 10) |
| Plates (298-313) | 20 | 50 | × (100 + param) / 100 on a move of the plate's type |
| Weather rocks (282-285) | 3 | 7 | weather lasts 5 + param turns (12); Light Clay stays 3 |
| Jaboca, Rowap (211, 212) | 8 | 6 | the attacker loses max HP / param |
| BrightPowder, Lax Incense | 10 | 11 | already read by the accuracy step |
| Ganlon, Apicot (202, 205), Shoal Salt (70) | 4 | 0 | pinch items that work at any HP, below |
| Lava Cookie, Old Gateau (42, 54) | none | Lum Berry's effect | used up to cure a status or confusion |
| Item 71 (docs: RageCandyBar; decompilation: Shoal Shell) | none | restores 100 HP | Oran Berry's shape, at half HP or less |

Handlers that read their number from the ROM: type boosters and Plates, Muscle Band, Wise Glasses, King's Rock, Razor
Fang, Focus Band, Quick Claw, Custap Berry, Silk Scarf and Muscle Band in the confusion self-hit, Oran, Sitrus, Berry
Juice, Leppa, Shoal Shell, Jaboca, Rowap, the weather rocks and Light Clay. Handlers whose ROM number equals vanilla's
and that keep Showdown's constant (pinned by the real test): Expert Belt, Life Orb, Shell Bell, Leftovers, Black Sludge,
the flavour berries (Figy and the rest, 1/8), Metronome, Big Root, Sticky Barb.

**Pinch items with parameter 0.** The cartridge checks `curHP <= maxHP / itemPower` (battle_lib.c:4773-4783). `maxHP` is a
`u32`, so the division is ARM9 `_u32_div_f` (0x020E2178), which returns the dividend for a divisor of 0; the hack's
overlay 16 calls it from every pinch block. So the item works at any HP, at its first check: `BattleSystem_TriggerHeldItemOnStatus`
checks every battler in speed order at each switch-in (bl:4152-4160, so the leads' berries are eaten at the battle start),
after each move (bcp:3730-3755, whoever the move targeted) and at the end of the turn (bcp:1699-1709). The engine also checks them after each hit of a multi-hit move, at the `MoveEnd` of a move its user couldn't make (a full
paralysis or a confusion self-hit, bcp:2637, :2660, :3959-3980) and at each turn's start (bcp:254-266), with Micle Berry
(below). Gluttony halves the power (0 stays 0). Their end-of-turn check is in the holder's own list too, as for the
whole family (below).

**Micle Berry (item 209).** Hold effect 44, `HOLD_EFFECT_PINCH_ACC_UP`, parameter 4
in the hack as in vanilla (the docs' Items tab: power 4, "Raises Accuracy next move"). The check is the same in
`BattleSystem_TriggerHeldItem` and `BattleSystem_TriggerHeldItemOnStatus` (bl:4897-4905, :5110-5118): HP left, no Klutz,
no Embargo, Gluttony halving the parameter, then `curHP <= maxHP / itemPower`, a quarter of the max HP (a half with
Gluttony). Eaten, it sets the holder's `micleBerry` flag (subscript_held_item_temp_acc_up.s:11), which the next hit-rate
formula multiplies by 120 / 100 and clears (bcp:2967-2970: a move with an accuracy, not a one-hit KO move, not a charging
turn, not Pursuit's switch-out hit). That formula is the first step of `TryMove` (bcp:3237-3296), after the move's own
script (which only flags a failure: Fake Out, Sucker Punch, Last Resort, Focus Punch, Damp) and before Protect, the
semi-invulnerable miss, the type chart and the immunity abilities, so a move they stop still spends the boost; Showdown's
accuracy step comes after them, so the format's `TryMove` handler spends it there instead (mod/scripts.ts `micleTryMove`) and the move's own accuracy check still gets the ×120/100. Only a switch-out or a
faint clears it otherwise (bl:2101-2104, :2186), and Baton Pass doesn't pass it. It never runs out: the mod drops
Showdown's 2-turn duration. Showdown checks the berry once, last of the end of turn; the engine checks it where the cartridge does (`src/engine/mod/items.ts`):
- the switch-in sequence's held-item step (bl:4152-4160), for every battler: after each switch-in (a switch, a
  replacement, a U-turn or Baton Pass newcomer, a drag, the leads), and at each turn's start before the commands
  (`ShowBattleMon`, bcp:254-266), which catches a Future Sight or Doom Desire hit at the end of the turn;
- after each move (bcp:3672-3698, :3730-3755), and after each hit of a multi-hit move (before `LoopMultiHit`,
  bcp:3777-3790), for every battler not switching out; and at the `MoveEnd` of a move its user couldn't make (the
  confusion self-hit, by `LOOP_FAINTED`, bcp:2637, :3820-3909, to `MoveEnd`, bcp:3962-3980), which runs no Showdown
  `AfterMove`;
- twice in the holder's own end-of-turn list (each battler's list runs whole, in monSpeedOrder): at its use-item step,
  after Ingrain, Aqua Ring and the ability and before Leftovers (bcp:1362-1368), and at its item-condition step, after
  Yawn and before the Orbs (bcp:1699-1709). So weather in the field phase, and poison or Leech Seed in the holder's own
  list, are seen where the cartridge sees them.
The one difference left is the order of two berries eaten at the same point (the cartridge's loops go in monSpeedOrder,
the engine's in Showdown's action speed, which draws nothing): only the log's order, as one battler's eat never changes
another's check. Unburden starts when the berry is eaten (Showdown's `eatItem`), as the cartridge doubles the Speed once
the item is gone (bl:1268-1272). Seven trainer Pokémon in the hack hold one. Tests: `test/unit/engine/micle.test.ts`.

**The other pinch berries.** Liechi (item 201, hold effect 36), Salac (203, 38), Petaya (204, 39), Lansat
(206, 41) and Starf (207, 42), parameter 4 each in the hack as in vanilla, are checked at Micle's points above, with the
same HP rule, and each with the cartridge's own condition (bl:4773-4895, :5196-5293): Liechi, Salac and Petaya (like
Ganlon and Apicot) need the stat below +6 and raise it 1; Lansat needs no Focus Energy yet and sets it; Starf needs one of
Attack, Defense, Speed, Sp. Atk and Sp. Def below +6 and raises one of them 2, at most to +6. A berry whose condition
fails stays held, and is checked again at the next point. Starf's stat is the cartridge's draw, `RandNext() % 5` again
until it names a stat below +6 (bl:4864-4866): an `itemProc` chance labelled `starfberry`, each such stat weighing its
residue's share, 13,108 of 65,536 for Attack and 13,107 for each other, so 1/4 each when one is at +6. Pluck, Bug Bite and
Fling give the eater the same draw (bl:5798-5813, :6110-6125). Showdown ate these berries on its `Update` (after each hit,
and at an action's end unless a switch is asked first), with no stat or Focus Energy condition, and drew Starf's stat raw,
which made every line where one was eaten unlabelled. The ROM's pinch items are pinned to the engine's table by
`test/real/engineVsCalcItems.test.ts`. Trainer Pokémon holding them: Liechi 15, Salac 21, Petaya 10, Lansat 5, Starf 10.
Custap Berry (45) is the turn order's (`speedOrder.ts`), checked in neither trigger. Tests:
`test/unit/engine/pinchBerries.test.ts`.

**The rest of the family.** Every case of `BattleSystem_TriggerHeldItem`
(bl:4576-4920) is one of `BattleSystem_TriggerHeldItemOnStatus` (bl:4967-5305), so the healing berries (Oran, Sitrus,
Berry Juice, Shoal Shell, the Figy family), the status and confusion cures (Cheri, Chesto, Pecha, Rawst, Aspear, Persim,
Lum, the hack's Lava Cookie and Old Gateau), Leppa and Mental Herb are checked at Micle's points above, and only there,
each with its own condition (Showdown's Gen 4 check, which is the cartridge's: half HP for the HP berries, the status,
confusion, a move at 0 PP, Attract). Showdown ate them on its `Update` (after each hit, at an action's end unless a switch
was asked first, and once after the whole end of turn) and Lum and the cookies also the moment a status was set; both are
off (`HELD_CHECK_ITEMS`, the items' `onKaizoHeldCheck`). So a Sitrus holder the sandstorm takes to half HP eats it in its
own list before its poison, a Persim holder confused by its Thrash lock's end (bcp:1547-1563) is cured before the
next battler's list, an end-of-turn level-up comes after the holder's check, and a U-turn user knocked to half HP
leaves with its berry and eats it when it comes back. White Herb (49) stays on Showdown's handlers. The ROM's items with
these hold effects are pinned to the list by `test/real/engineVsCalcItems.test.ts`. Tests:
`test/unit/engine/heldItems.test.ts`.

**Abilities.** The docs' Ability Changes tab is one row per species with its two abilities, not a list of changed
behaviour; the ROM holds the same assignment, which the engine reads (`test/real/engineVsCalcAbilities.test.ts` lists the
12 rows where the tab and the ROM differ; the ROM is used). The ability behaviour changes are the cartridge's own
(mod/procs.ts) and the docs' text over Showdown's (mod/abilities.ts: Oblivious no longer blocks Captivate).

**The field at battle start** (`src/engine/mod/field.ts`). The trainer's field note is applied as the cartridge's overworld
weather, first in the switch-in sequence, before the leads' abilities: permanent weather (Showdown's weather with duration
0, logged as a plain `|-weather|` line), deep fog (× 6 / 10 on the hit rate unless Cloud Nine or Air Lock is out), Trick
Room and Gravity (duration 0: the hack's subscripts 251 and 238 re-arm them). A weather ability replaces the field
weather unless it is that weather already; Hail starts five turns of hail under a permanent hail. Subscript 297 is the
hack's new Gravity start. A note naming more than one of the four is unmodelled (the map holds one weather).

**The deep fog ends**. It is a weather bit (`FIELD_CONDITION_WEATHER` includes `FIELD_CONDITION_DEEP_FOG`,
condition.h:131-135), so every weather move and weather ability that sets its weather clears it (effect_script_0115.s:8,
_0136, _0137, _0164; subscript_drizzle.s:11 and its kin), and Defog clears it (subscript_defog.s:64-67, with its
`|-fieldend|Deep Fog|[from] move: Defog` line). Nothing else does. Once it is gone the hit rate is no longer × 6 / 10 and
SolarBeam is no longer halved for it. While it is up and counts (no Cloud Nine or Air Lock), it is a weather for Weather Ball
(power doubled, type unchanged: bs:6847-6850, bl:7894-7911) and for Synthesis, Moonlight and Morning Sun (a quarter of the
max HP: bs:5970-5976). Defog is still an unmodelled move (the list above): only its fog clearing is checked.

## What a gauntlet carries

`carryOut` gives each party Pokémon's HP, the PP of its own moves, its status, its held item (`CarryState.mons[].item`,
a ROM item ID, 0 for none), its total EXP (`exp`) and its own moves as ROM move IDs in slot order (`moves`, which `pp`
lines up with); `item`, `exp` and `moves` are always written. `createBattle` starts each Pokémon with the carried item
when the carry gives one (0: none), else the save's.

**EXP, level and moves.** The cartridge's party keeps a level gained mid-fight, so the next fight of a gauntlet
starts a Pokémon whose carry gives `exp` at the level its growth table gives for that EXP (`growth[level] <= exp <
growth[level + 1]`, level 100 for any EXP from its total), with that level's stats and max HP (Showdown's `spreadModify`
over its own species, the formula of a mid-fight level-up, `applyLevel`), whatever the save's level is. With `moves` the
move list is the carry's, so a move a level-up taught into a free slot stays: it has no PP Ups, and each move
the save has keeps the save's PP Ups. Without `exp` the save's level applies, with the save's EXP when it fits the level,
else the level's own total (the what-if rule); without `moves`, the save's moves: a carry without it starts the same battle as before. HP above the max HP and a PP entry above the move's max PP mean full, at the level the Pokémon
starts at, so a heal needs no stats. The heal between fights is the solver's (`src/solver/inputs.ts`): it must keep
`item`, `exp` and `moves` and heal by writing HP and every PP entry above any real value. A heal written as the save's max
HP and PP with none of the three (today's `healedCarry`) starts the next fight at the save's level and moves, with the
save's item. The cartridge copies the battler's held item to the party at every `BattleMon_CopyToParty`
(bl:1819-1826; battle_controller.c:1471-1472; battle_io_command.c:590-592), which every HP change and item change runs, so:

| What happened in the fight | Item in the next fight | Why |
|---|---|---|
| a berry eaten (by its holder, or by the foe's Bug Bite or Pluck), a Focus Sash or herb used up | none | `BtlCmd_RemoveItem` copies the empty slot (bs:8976-8981) |
| Knock Off | the item knocked off | the knocked-off slot's item is never copied again (bs:6624-6628, battle_io_command.c:590) |
| an item gained (Sticky Barb passed on) | the new item | the copy writes what the battler holds |
| Thief, Covet, Trick, Switcheroo | (no hack move does it) | the hack's Thief has Splash's effect; the Covet, Trick and Switcheroo slots hold Hidden Power moves |

The status carried is the one the Pokémon ends with, except that the Pokémon out when the player wins is cured if its battle
ability is Natural Cure or its party ability forbids its status (Immunity, Limber, Insomnia, Vital Spirit, Water Veil,
Magma Armor): subscript_battle_won.s:6-11 runs `TryRestoreStatusOnSwitch` (bs:9139-9160) and sets the status to none,
which is copied to the party (bs:3077-3078). The bench is not cured at the win; a lost or drawn fight runs
subscript_battle_lost.s, which cures no one; an unfinished fight's carry keeps every status. Every
switch-out runs the same cure first (subscript_switch_pokemon.s:5-6, and the Baton Pass, U-turn and Roar scripts), with no
message: Showdown's Natural Cure does it too, but not under Gastro Acid, and nothing of Showdown's cures a status the
party ability forbids once the battle ability doesn't; the engine cures both (`switchIn`, mod/scripts.ts).

Between two fights the cartridge may give an item-less Pickup or Honey Gather Pokémon an item (`BtlCmd_GenerateEndOfBattleItem`,
bs:7781-7848). The carry can't say what, so a fight whose carry gives such a Pokémon `item: 0` (it ended the last fight
holding nothing) records `PICKUP_NOTE` in `unmodelledIn`. A carry with no `item` means the save's item and no fight
before it (the solver's first fight), so it records nothing. A heal that drops `carry.item` loses the
note with the item.

## EXP and levels gained mid-fight

The engine pays EXP at every knock-out of the trainer's Pokémon, as the cartridge does, and levels the player's
Pokémon on the spot (`src/engine/mod/exp.ts`). `pk` = src/pokemon.c, `bs`, `bl`, `bcp` as
below (pret/pokeplatinum at 62bdaac). Nothing here draws a chance (no routine of it calls `BattleSystem_RandNext`).

**The formula** (`expGain`, `src/engine/exp.ts`; `BtlCmd_CalcExpGain` bs:2187-2245, `BattleScript_GetExpTask`
bs:9685-10201): `exp = floor(base × level / 7)` from the fainted battler's species (the copied one when Transformed; a
form pays its species' row) and its own level. The living participants (A) and the living Exp. Share holders (S) split it:
with S > 0, each participant gets `max(1, floor(floor(exp / 2) / A))` and each holder `max(1, floor(floor(exp / 2) / S))`,
else each participant `max(1, floor(exp / A))`. A level 100 participant is counted but not paid. Each paid Pokémon's
total goes ×150/100 for a Lucky Egg, ×150/100 for the trainer battle (every engine battle), ×150/100 when traded or ×170/100
when traded from another language (`PlayerMon.origin`), each step floored. The item read is the party's: a Lucky Egg or
Exp. Share knocked off still counts.

**The participation mask** (`formatData.kaizoExpMask`): for the trainer's active Pokémon, a bit for each of the player's
party indices that was out at any moment since its latest send-out while it had HP (`BattleSystem_FlagBattlerExpGain`,
bl:1461-1478; `BattleSystem_ClearSideExpGain`, bl:1456-1459, called only by the two send-out commands). The player's
send-outs add the newcomer (a switch, U-turn, Baton Pass, a replacement, a Roar or Whirlwind drag), unless the enemy has
0 HP (a U-turn that knocked it out); an enemy send-out starts it again as the player's active Pokémon alone. It is set before
the newcomer's hazards. It never holds the bit of a Pokémon with 0 HP (the cartridge keeps such bits but never pays
them; nothing in the engine revives), and it is 0 after each payout (bs:10190-10192).

**When it is paid** (bcp:3962-3972, :940-941, :1295-1296, :1846; always before the trainer's replacement and before the
battle-over check, so the last enemy's EXP is in the terminal state):
- after every action but the end of turn, when Showdown's `runAction` returns: a move's recoil, Life Orb and Shell Bell
  have run, and the player's Pokémon that fainted in the same action (Explosion, Destiny Bond, recoil) is neither paid nor
  counted;
- in the end of turn, at once after a weather, poison, burn or Leech Seed faint, so the effects after it see the new
  stats (the player's Leftovers heals a sixteenth of the new max HP). Micle Berry's checks are in its holder's own list
  (bcp:1362-1368, :1699-1709, both on the cartridge and in the engine), so a holder of the player's whose list ran
  before the fainting enemy's is checked before the level-up, and after it otherwise, as on the cartridge;
- The player's U-turn that knocks the enemy out: after his newcomer is in and its hazards are done (the pending faint is in the
  `playerMidTurnSwitch` state and its key, `formatData.kaizoExpPending`); the U-turn user is paid on the bench, the
  newcomer has no bit;
- Future Sight, Doom Desire and Perish Song faints: when the end of turn is over, as its last thing on both sides
  (bcp:1846), so the handlers Showdown runs after such a faint (Slow Start, White Herb, Truant's check, a volatile's end)
  cannot change the payout; the turn start's held-item check comes after it on both sides;
- Pursuit on a switching enemy: when the switch action ends, from the victim's mask, before the new enemy is out. On the
  cartridge the player's Pursuit knock-out then corrupts the field conditions ("Acid Rain", subscript_pursuit.s:115: the
  fainted battler is subtracted from the field-condition mask). The engine cannot follow it (the result holds several
  weathers at once), so with any weather, Trick Room, Gravity, Uproar or fog up that step records `PURSUIT_FIELD_NOTE`.
  With none up the subtraction stays at 0 and nothing changes.

**The level-up** (`applyLevel`, `src/engine/levelUp.ts`; `Pokemon_ShouldLevelUp` pk:3501-3525): the EXP is clamped to the
level 100 total, then the level goes up one at a time while the EXP reaches the next level's total, each with the
cartridge's stats (HP rises by the max HP gained, a fainted Pokémon stays at 0), the active battler's reload
(`BattleSystem_ReloadPokemon`, bl:169-194: a Transformed one gets its own stats back, Power Trick's swap is overwritten),
and the level's moves: learned into a free slot at full PP with no prompt, or offered and declined with four moves known. No evolution; friendship is not modelled (nothing reads it). The line builder's
manual `levelUp` sets the EXP to the new level's total, as a Rare Candy does.

**Protocol lines**, public, in party order for each paid Pokémon, after the step's `|faint|` (and `|win|`):
`|-kaizoexp|IDENT|N` (`|[boosted]` added for a traded Pokémon), `|-kaizolevel|IDENT|LEVEL` for each level,
`|-kaizolearn|IDENT|MOVE NAME` and `|-kaizooffer|IDENT|MOVE NAME`. The observation keeps them as they are (observe.ts
needs no new rule), and `player[].level`, `hp`, `maxhp` and `moves` show the result.

**The hack's level cap:** there is none in a fight. The hack's EXP routines and `Pokemon_ShouldLevelUp`
are the vanilla ones (overlay 16 and arm9 compared with vanilla), so a Pokémon at a gym's cap that earns enough EXP levels
past it mid-fight. The save's "1 short of the next level" marks come from the hack's signpost script ("your Pokémon surged
with power!", script command 0x1CE: `exp += Pokemon_GetExpToNextLevel(mon) - 1` for the whole party), so a surged Pokémon
levels on its first EXP. The caps themselves are entry checks in the gym gate scripts ("you may only use Pokémon up to
Level 16"), which nothing reads during a fight: `LEVEL_CAPS_BY_BADGES` stays a planner rule (`src/server/levelCap.ts`),
and the engine takes no cap.

## Reading a state's battle: `peek`

`peek(state)` (`src/engine/facts.ts`) gives read-only callers (the trainer AI, the views, the engine's lazy readers)
one battle per state object. The battle of an `expandTurn` outcome is the kept leaf's own live battle,
handed over when the leaf becomes its class's kept leaf (`keepLive`) and first reset to what a restore gives: a chance
driver that throws, an empty log, a restore's base move slots, no `monSpeedOrder` memo. A battle nobody has read waits
in the unread pool (`SEED_LIMIT` = 256, oldest pushed out first); its first peek moves it to the read LRU
(`PEEK_LIMIT` = 64). Any other state object is restored on its first peek. Nothing here changes a state, key, outcome
or answer. Memory, per solve worker (each has its own pools, none of it in the solver's result-store byte cap): a kept battle is
59 to 74 KB, so a full unread pool holds 15 to 19 MB of battles beside the LRU's 4.5 MB; it also keeps its states
alive, and an outcome the solver dropped stays there with its JSON (about 34 KB at 6v6), up to about 9 MB more.

**The read rule.** A peeked battle equals `restore(state)` in every own property value at any depth, and in the identity
of its Battle, Side, Pokémon, Field, queue and set objects. Not promised, because a kept leaf's battle and a restore
differ there (Showdown's serialiser is lossy in three places, `peekCheck.ts`):

- anything inside an active-move copy (`battle.lastMove`, `pokemon.lastMove`, `lastMoveUsed`, an effect state's
  `sourceEffect`, a queued action's `move`) beyond its `id`, `num` and `name`, and that copy's identity;
- inside a queued action, or inside an effect state held in a condition map (`sideConditions`, `slotConditions`,
  `pseudoWeather`, `volatiles`: a hazard's `duration`), and for a Pokémon's staleness keys (Showdown's endless-battle
  bookkeeping, which `eatItem` and `clearVolatile` set to `undefined`), whether a key that reads `undefined` exists
  (`in`, `Object.keys`, spreads). The condition maps' own keys are promised and compared strictly: `observe` lists
  `sideConditions` and `pseudoWeather` by key;
- whether two value-equal plain arrays are one object (Showdown's `setType` can share a species' `types` array).

So a caller reads values by name, never enumerates those objects' keys or tests them with `in`, and never compares
arrays by identity.
The trainer AI keeps the rule (`test/unit/engine/peekSeedAiRule.test.ts` reads the whole corpus through a recording
membrane: it reads only `lastMove.id` and a queued action's `move.num` inside active-move copies).

**Guards and switches**, each read once at load (`peekConfig`, tests and tools only):

| Switch | Default | What it does |
|---|---|---|
| `PKP_SEED_PEEK=0` | seeding on | `expandTurn` keeps no battle for `peek`; every first peek restores. The switch to rule the seeding out of any doubted result. |
| `PKP_VERIFY_PEEK=1` | on under vitest | A kept battle's first peek is compared with a restore of its state over the whole object graph (`peekDifferences`), and must hold no `monSpeedOrder` memo (outside the graph; a restore has none); any difference the rule promises against throws. Every unit and real suite runs with it. |
| `PKP_FREEZE_PEEK=1` | on under vitest | Each peeked battle is deep-frozen on its first peek, so a write, or a Showdown method that runs an event, throws. |

The chance driver of a peeked battle always throws on a draw.

## Damage order

One hit's damage, in the cartridge's order. `bl` = src/battle/battle_lib.c, `bs` = src/battle/battle_script.c, `bcp` =
src/battle/battle_controller_player.c (pret/pokeplatinum at 62bdaacdc). The control flow of a move is: its effect script
(`CalcCrit`, `CalcDamage`), then TRY_MOVE (accuracy, then the type chart, bcp:3272-3277), then USE_MOVE, then UPDATE_HP
(bcp:3341-3445), then the resist berry (subscript_update_hp.s, subscript_type_resist_berry.s). So the type chart runs on the
damage the roll already made. Written out twice, independently: `gen4Damage` (src/calc/gen4Damage.ts, from the decompilation
alone, no Showdown, no @smogon/calc) and the engine's `src/engine/mod/damage.ts` over Showdown's state.

1. **Power** (`BattleSystem_CalcMoveDamage`, bl:6601-6919). `inPower` or the move's power (bl:6673-6677), then
   `power × powerMul / 10` (bl:6688; `powerMul` is 20 for Facade with a status, Brine at half HP or less, SmellingSalt on
   paralysis, Wake-Up Slap on sleep, a semi-invulnerable target, and 12 for Reckless on the recoil effects 45, 48, 198, 253, 262,
   269). Then, each floored: Charge ×2, Helping Hand ×15/10, Technician ×15/10 (power ≤ 60, not Struggle), the type item
   `(100 + param) / 100` (bl:6716-6722), Light Ball ×2 (power, not Attack: bl:6748), the Orbs, Muscle Band / Wise Glasses, Thick Fat
   /2, Mud and Water Sport /2, Overgrow / Blaze / Torrent / Swarm ×150/100 at HP ≤ max/3 (an Explosion effect has set HP to 0
   first: effect_script_0007.s:8), Heatproof /2, Dry Skin ×125/100, Rivalry ×125/100 or ×75/100, Iron Fist ×12/10 (by move ID).
2. **Stats** (bl:6921-6945). Every item and ability term is on the RAW stat, before the stage, each floored: Huge / Pure Power
   ×2, Slow Start /2 (Attack only), Choice Band / Specs ×150/100, Soul Dew, Deep Sea Tooth / Scale, Metal Powder, Thick Club,
   Hustle, Guts, Marvel Scale, Plus / Minus, and under no Cloud Nine / Air Lock Solar Power, the sandstorm's Rock Special Defense
   and Flower Gift ×15/10; Explosion's effect halves the physical Defense last (bl:6943-6945).
3. **Stages and formula** (bl:6850-7019). Simple doubles the stage (the defender's only without Mold Breaker), Unaware zeroes the
   other side's, a crit counts only a positive attack stage and a negative defense stage. Then
   `A_staged × power × (L × 2 / 5 + 2) / D_staged / 50`, burn /2 (physical, not Guts), a screen /2 (not a crit, not Brick Break),
   weather (rain: Fire /2, Water ×15/10; sun the reverse; SolarBeam by ID 76 /2 in rain, sand, hail and deep fog), Flash Fire
   ×15/10, `+ 2`.
4. **Script** (`BattleScript_CalcMoveDamage`, bs:1323-1366). × the critical multiplier (2, or 3 with Sniper), Life Orb
   `(100 + param) / 100`, the Metronome item, Me First.
5. **The roll** (`BattleSystem_CalcDamageVariance`, bl:7081-7094): `d × (100 − r) / 100` for r in 0 to 15, at least 1.
6. **STAB and the chart** (`BattleSystem_ApplyTypeChart`, bl:2560-2679). STAB `× 15/10` (Adaptability `× 2`); then the chart
   **row by row** (`sTypeMatchupMultipliers`, bl:2399-2517): every row of the move's type that matches the defender's first type, or
   its second when different, is `Divide(d × multiplier, 10)`, which truncates but never takes a nonzero value to 0 (bl:3599-3619).
   The walk stops at the 0xFE marker with Foresight or Scrappy, otherwise it goes on to the Ghost immunities after it. The
   super-effective and not-very-effective flags cancel each other (bl:7557-7575). Only then, on the net flags: Filter and Solid Rock
   `Divide(d × 3, 4)`, Expert Belt `(100 + param) / 100`, Tinted Lens `× 2`.
7. **The resist berry** halves with `Divide(d, 2)` after UPDATE_HP's False Swipe, Endure and Focus caps.

How Showdown and @smogon/calc differ, and what was fixed (each with a test in `test/unit/engine/damageAgreement.test.ts`):

| Where | Showdown (the engine before the fix) | @smogon/calc 0.12 (`damage()` before the fix) | Cartridge |
|---|---|---|---|
| Item and ability stat terms | on the staged stat, chained in 4096ths (Huge Power at +1 on 45 Attack: 134) | on the staged stat, floored (same) | on the raw stat before the stage (135) |
| Pinch ability, Thick Fat, Heatproof | pinch is an Attack term (gen4), Thick Fat an Attack term, in a 4096 chain | pinch before Heatproof / Thick Fat, in its own order | power steps in the order above (Blaze at 75 on a Thick Fat target: 55; Smogon 56) |
| Type chart | the net `typeMod` (x2 or floor /2 per step), so Shadow Ball on Ghost/Dark loses nothing | its own defender-type order (Ice Beam on Fire/Flying may lose a point) | the chart's row order, `Divide` after each; Shadow Ball on Ghost/Dark gives only even rolls |
| Expert Belt, Filter, Solid Rock, Tinted Lens | `chainModify` in 4096ths ([4915, 4096] for 1.2) and 0.75 half-down, one rounding | the same family | floors (`d × 120 / 100`) and `Divide(d × 3, 4)` |
| Sniper | ×1.5 after the chart | | ×3 before Life Orb and the roll |
| Burn, screens, weather, Flash Fire | Phase 1 handlers in 4096ths | | inside the formula, floored, before `+ 2` |
| Simple under a crit | | the crit rule on the unmodified stage | Simple doubles first, then the crit rule |
| Confusion self-hit | the stat terms on the staged stat; Flower Gift in sun | | every stat term on the raw stat; no weather or field |

What stays Showdown's: the move's own `BasePower` handlers (Facade, Brine, the rollout storage) and the resist berries (they eat the berry). A move that hits a Dig, Fly, Dive, Bounce or Minimize state its ROM effect looks for has twice the power from the first step (`powerMul` 20, effects 146/149, 147/126, 261/257, 150), and the Metronome item multiplies by (10 + turns) / 10 after Life Orb; both are in the engine and in `gen4Damage` (`CalcSide.hiding`, `CalcSide.metronomeTurns`). `gen4Damage` models none of: Charge, Helping Hand, Mud / Water Sport, Magnet Rise, Ingrain, Roost and Miracle Eye, Me First, or a double battle's alive counts. It throws for a move whose power it does
not derive (weight, speed, PP, the hit number, earlier turns: Low Kick, Grass Knot, Gyro Ball, Payback, Revenge, Assurance, Trump
Card, Triple Kick, Rollout, Ice Ball, Fury Cutter, Magnitude, Spit Up, Fling, Natural Gift, Judgment, Present, Wring Out (Crush
Grip's), Beat Up, Psywave) or for a damage that is not the formula's (Bide, Counter, Mirror Coat, Metal Burst, the one-hit KO moves,
Future Sight); `damage()` keeps Smogon for those.
