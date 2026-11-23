# Battle engine: spot checks the decompilation can't settle

The engine follows the decompilation (pret/pokeplatinum) and the ROM wherever they say something. Where the hack could
have changed code the diff can't see, or where the docs and the ROM disagree, the engine picks one side and the choice
goes here. Each item is worth checking in game before a proof leans on it. The trainer AI's own list is
`docs/ai-spot-checks.md`; the turn-1 friendship and PID readings are its checks 8a and 8b.

## Docs against the ROM

| Move or effect | The docs say | The ROM or decompilation says | The engine follows |
|---|---|---|---|
| Kinesis | accuracy −2 | Special Defense −2 | the docs |
| Captivate | no gender condition | needs the opposite gender | the docs |
| Overheat, Eruption, Blast Burn, Flare Blitz | nothing about thawing | thaw a frozen user, by the ROM effect | the ROM |
| Minimize | only the +2 evasion | also sets the marker that Stomp doubles against (effect 108) | the ROM |
| Hurricane | a 10% chance to confuse | effect chance 30, on the hack's own effect 141 (vanilla's 141 is unused, so its script isn't in the decompilation) | confusion (the docs) at 30% (the ROM's number) |
| Roar of Time | "Recharge turn" | effect 262, Volt Tackle's: 1/3 recoil and a 10% paralysis chance, no recharge | the docs (a recharge turn) |
| King's Rock | Items tab: parameter 10 | item data parameter 11 (vanilla 10); Razor Fang 10 | the ROM |
| Ability Changes tab: Sandshrew, Sandslash, Golem, Farfetch'd, Dewgong, Scyther, Quagsire, Slowking, Armaldo, Tropius, Tangrowth, Gallade | the abilities listed in the tab | Personal data's abilities differ (12 rows, `test/real/engineVsCalcAbilities.test.ts`) | the ROM |
| Wish | "1/2 of user's max HP" | half the recipient's own max HP (bcp:1086-1104) | the decompilation; a Wish landing on another Pokémon than its user is noted |
| Level-up learnsets | the Level-Up Learnsets tab | the ROM's wotbl.narc, read by `Pokemon_LoadLevelUpMovesOf` at the form's Personal row (pk:4585-4589); they differ for some species (`npm run check`, "Learnsets") | the ROM (`levelUp.ts`, a move learned mid-fight) |

## Unmodelled until an in-game check

These moves stay unmodelled (`docs/engine-model.md`) because the decompilation can't settle what the hack's ROM does.

- Jump Kick and Hi Jump Kick: does a miss cost half the user's max HP (the docs) or half the damage it would have
  dealt, at most half the target's max HP (subscript_crash_on_miss.s)?
- Triple Kick, Rock Wrecker, Triple Axel, Fury Cutter: the power of each hit. Vanilla effect 104 adds 10 to a power
  that starts at 0 (10, 20, 30, whatever the ROM's power). Triple Axel and Fury Cutter run effect 88, Psywave's slot,
  which the hack must have rewritten.
- Chatter: vanilla's confusion chance comes from Chatot's recorded cry (0, 10 or 30), not the ROM's 50. Does the
  hack's Chatter confuse at 50%?

## Move flags taken from the cartridge's ID lists and ROM bits

The cartridge decides these by move ID or by a ROM bit. The hack may have edited the lists in code.

- HP Water (move 150, Splash's slot) fails under Gravity.
- HP Electric (361) and Swallow (256) are blocked by Heal Block.
- Water Ball (4) counts as a punch for Iron Fist.
- Whirlwind and Heal Bell are not sound moves (Heal Bell's Soundproof rule is separate).
- Counter, Mirror Coat, Metal Burst, Memento and Rock Ball go through Protect.
- Spikes, Toxic Spikes, Stealth Rock, Disable, Encore, Torment and Spite can be reflected by Magic Coat.

## Known gaps, checked

Each gap this list held is now checked against the decompilation: fixed, noted through `unmodelledIn`, or found to match.
Tests: `test/unit/engine/gaps.test.ts`.

| Gap | The decompilation | The engine now |
|---|---|---|
| Knock Off | subscript_knock_off.s: a substitute, Multitype, a Griseous Orb (any holder) or the defender's Quick Claw or Custap flag stop it (:5-9); then `BtlCmd_TryKnockOff` (Sticky Hold, bs:6610-6633) empties the battler's item with no copy to the party, so the item is back after the fight. The flag is set by the turn's order (bl:1282-1284, :1296-1298) and cleared when its holder's move starts (subscript_check_quick_claw.s:22-28, the first step of every move, bcp:3140-3143) | Multitype and the Griseous Orb already matched (Showdown refuses both); fixed: a set flag stops Knock Off, so a claw or berry whose holder has not moved yet stays, and one whose holder has moved is knocked off (the flag used to be kept for the whole turn); the item carried out is the one knocked off. An Arceus knocking off a Plate is noted (Showdown's Plate refuses it) |
| The Quick Claw and Custap flags past their holder's move | only two compares set the flags: the turn's order and Trick Room's re-sort (`BattleSystem_SortMonActionOrder`, bl:7276-7302, at the end of the move that toggled the room, bcp:3990-3993), each for two battlers that both chose to fight and with `ignoreQuickClaw` FALSE (bcp:772-787, bl:7288-7290); the trainer AI's and `monSpeedOrder`'s pass TRUE (trainer_ai.c:1109, :1121, :2081; bl:3377). The re-sort reads each slot's `speedRand` as it is then, already drawn again after the turn's order (bcp:853-858), and the HP then, so it sets the flag of a battler that has moved too. Nothing clears a flag at the turn's end: only its holder's next move start or a switch-in | fixed: the room's toggle runs the re-sort's flag part (mod/field.ts, speedOrder.ts `resortMoveFirst`), and a live battler's flag stays past the turn's end (a fainted one's goes: only a switch-in fills its slot). The hack's Trick Room has priority +7 (ROM move data), so a Knock Off after it in the same turn can meet the flag set again |
| Bug Bite and Pluck against the flags | `BtlCmd_TryPluck` reads the Custap Berry flag alone, with an item held (bs:8125-8127), after Sticky Hold (:8122-8124); a Quick Claw is no berry (`BattleSystem_PluckBerry`, bl:5832-5836) | fixed: a flagged Custap holder keeps its berry until its own move start eats it; Bug Bite and Pluck no longer record `FLAGGED_ITEM_NOTE` (they matched Showdown for a Quick Claw already) |
| Focus Punch and a hit on its user's Substitute | effect_script_0170.s:5-6 loses focus on the turn's physical or special damage masks, which `UpdateHP` sets only for a hit on HP (a substitute hit returns first, bcp:3360-3378) | matches: Showdown's focus is lost by a `Hit` event, which a substitute's hit never runs |
| Perish Song against its user's own Soundproof | `BtlCmd_TryPerishSong` (bs:5462-5487) gives no count to any battler with Soundproof that the user's Mold Breaker doesn't ignore, the user included, skips no semi-invulnerable one, and fails when no one gets a count | the user's own Soundproof already matched (Showdown's Gen 4 Soundproof blocks its user's sound move too); fixed (mod/moves.ts): the move now fails when every Pokémon blocks it, and counts a semi-invulnerable one |
| A resist berry and the caps, and the damage records | `UpdateHP` caps for False Swipe, Endure and the Focus items, then records the damage for Bide, Counter, Mirror Coat, Metal Burst and Shell Bell (bcp:3381-3433); only then subscript_type_resist_berry.s halves the HP change (:111) | halves in the formula, as before; a berry eaten on a False Swipe or Endure hit, by a holder that knows Bide, Counter, Mirror Coat or Metal Burst (by ROM effect), or against a Shell Bell holder is noted (`RESIST_BERRY_NOTE`) |
| A resist berry on HP changes besides the hit | subscript_update_hp.s:5-10 runs the berry script for any HP change while a battler still has to move, unless `SYSCTL_SKIP_SPRITE_BLINK` is set; the script reads the current move's type and super-effective flag against the item of the battler losing HP. Every caller that loses HP in a move sets the flag first (subscript_rough_skin.s:5, _aftermath.s:5, _held_item_recoil_when_hit.s:10 for Jaboca and Rowap, _lose_hp_from_item.s:5 for Life Orb, the recoil and Struggle scripts, _hazards_check.s:33, :43, _drain_half_damage_dealt.s:18 for Liquid Ooze), and the end of the turn has no battler waiting (:9), except the hit itself, Pursuit's hit (a hit) and a confusion self-hit (subscript_hurt_self_in_confusion.s:17). At the self-hit the move status is zeroed (`BattleContext_Init`, bl:1983), so only the Chilan Berry, tested before the super-effective check (subscript_type_resist_berry.s:21, :41-42), can work: on the chosen move's ROM type (`TYPE_NORMAL` in the move type var, bl:1981, sends the script to the move data, :12, :17) or Normalize | fixed: a confused Chilan holder whose chosen move is Normal (or with Normalize) halves its self-hit and eats the berry, whether it moves first or last (mod/conditions.ts `chilanOnSelfHit`); Showdown's self-hit is typeless. The waiting count (:9) never stops it: it counts every battler whose action isn't finished, the one acting included (bcp:881-885, marked finished at its end, bcp:3989), so it is 1 for the last mover. Nothing else to name |
| The no-effect flag's two missed cases | the type chart runs after the accuracy check and its overrides whatever they found (bcp:3254-3279, :3040-3043), so a semi-invulnerable target the chart makes immune still sets `noEffect` (bcp:2350-2369); Levitate and Magnet Rise are checked before the chart and set their own flags (bl:2600-2608) | fixed: `hitStepInvulnerabilityEvent` records the chart's immunity for a target Showdown found semi-invulnerable; `typeChartImmune` leaves out a Flying-type with Levitate (not against Mold Breaker) or Magnet Rise |
| Micle Berry into Protect, a type-immune, ability-immune or semi-invulnerable target, or a move that fails in its own script | `BeforeMove` loads the move's script with `TryMove` next (bcp:3211-3216); a script failure only flags the move (Fake Out, effect_script_0158.s:5, :12-13; Sucker Punch, 0248.s; Last Resort, 0246.s; Focus Punch, 0170.s:5-6, :12-16; Explosion under Damp, 0007.s:5, :21-31). `TryMove` (bcp:3237-3296) then runs the hit-rate formula first, which eats the boost (`CHECK_MOVE_HITS`, bcp:2967-2970), then the overrides (Protect, the semi-invulnerable miss, Lock-On, No Guard: bcp:3001-3032), the type chart and the immunity abilities (Levitate, Volt Absorb, Wonder Guard and the rest). The formula returns first only for a move with no accuracy, a charge turn and a one-hit KO move (bcp:2900-2913) | Protect matched (Showdown's Gen 4 accuracy step comes before Protect's `TryHit`); the rest was wrong: Showdown's accuracy step comes after the type chart, `TryImmunity`, the semi-invulnerable check and the move's `Try`, so a Mega Kick into a Ghost or a Ground move into Levitate kept the boost and the next accuracy-90 move was a sure hit. Fixed: the format's `TryMove` handler (mod/scripts.ts `micleTryMove`, first of the event, dex.ts) spends the boost after the move's own `TryMove` (where a charge turn stops, as the cartridge's) and before the rest; the move's accuracy check still gets the ×120/100. Check in game: a Micle holder's Mega Kick into a Ghost, then its next Mega Kick can miss. Tests: `test/unit/engine/micle.test.ts` |
| When Micle Berry is checked, and how long its boost lasts | `HOLD_EFFECT_PINCH_ACC_UP` (hack item 209: hold effect 44, parameter 4) is checked by `BattleSystem_TriggerHeldItem` (bl:4897-4905) and `BattleSystem_TriggerHeldItemOnStatus` (bl:5110-5118): `curHP <= maxHP / itemPower`, Gluttony halving it, none under Klutz or Embargo. They run in the switch-in sequence (bl:4152-4160: at the battle start, every turn's start, `ShowBattleMon` bcp:254-266, first after every hit, bcp:3672-3681, and at every action's `MoveEnd`, bcp:3962-3980, a failed `BeforeMove` included: a confusion self-hit by `LOOP_FAINTED`, bcp:2637, :3820-3909, the other failed checks by `UPDATE_MOVE_BUFFERS`, e.g. bcp:2660, :3959), after every hit for the attacker, the defender and every battler (bcp:3684-3698, :3730-3755), and twice in the holder's own end-of-turn list (bcp:1362-1368 after the ability, :1699-1709 after Yawn). The flag it sets (subscript_held_item_temp_acc_up.s:11) is cleared only by the next hit-rate formula (bcp:2967-2970) and the zeroing at a switch-in or faint (bl:2101-2104, :2186): no expiry | was wrong: Showdown checked once, last of the end of turn, and its boost lasted 2 turns, so a holder hit into its pinch moved that turn unboosted and the next boosted (MICLE-A), and an end-of-turn level-up read the HP in another order (`MICLE_EXP_NOTE`). Fixed: checked at each of those points (mod/items.ts), the boost kept until used; the note is gone. Matches but for the log order of two berries eaten at one point. Check in game: a Micle holder hit into its pinch by a faster foe shows the berry message before its own move that turn. Tests: `test/unit/engine/micle.test.ts`, `expApply.test.ts` (the level-up) |
| When Liechi, Salac, Petaya, Lansat and Starf Berry are checked, and Starf's stat | The hack's items 201 Liechi (hold effect 36), 203 Salac (38), 204 Petaya (39), 206 Lansat (41), 207 Starf (42): parameter 4 each, as vanilla (the docs' Items tab agrees; `test/real/engineVsCalcItems.test.ts`). `BattleSystem_TriggerHeldItem` (bl:4773-4895) and `_OnStatus` (bl:5196-5293) check each the same: HP left, no Klutz or Embargo, Gluttony halving the parameter, `curHP <= maxHP / itemPower`, and the stat below +6 (Liechi, Salac, Petaya), no Focus Energy yet (Lansat, bl:4843-4844), or one of five stats below +6 (Starf, bl:4855-4862). They run at Micle's points (the row above). Starf draws `RandNext() % 5` until it names a stat below +6 (Attack, Defense, Speed, Sp. Atk, Sp. Def: generated/battle_stats.txt) and raises it 2, at most to +6 (bl:4864-4866, subscript_held_item_sharply_raise_stat.s:14-18); Pluck and Fling draw the same (bl:5798-5813, :6110-6125) | was wrong: Showdown's `onUpdate` ate them after each hit and at an action's end unless a switch was asked first, not in the holder's end-of-turn list (so at the wrong side of a Leech Seed heal, a poison knock-out or an EXP level-up), on a U-turn user before it left, with the stat already at +6 or Focus Energy already up, and Starf's stat came from a raw `sample` (1/n each), which made the line unlabelled (unproven). Fixed: the whole family is checked at the cartridge's points with its conditions (mod/items.ts `PINCH_ITEMS`), and Starf's stat is an `itemProc` chance labelled `starfberry`, each stat below +6 weighing `residueWeights(5)[i]` (13,108 for Attack, 13,107 for the rest). Matches but for the log order of two items used at one point. Check in game: a Liechi holder at +6 Attack in its pinch keeps the berry. Tests: `test/unit/engine/pinchBerries.test.ts` |
| When the healing and cure berries, Leppa and Mental Herb are checked | Every case of `BattleSystem_TriggerHeldItem` (bl:4576-4920) is one of `BattleSystem_TriggerHeldItemOnStatus` (bl:4967-5305): `HP_RESTORE` (bl:4585-4591: 43 Berry Juice 20, 71 Shoal Shell 100, 155 Oran 10), `HP_PCT_RESTORE` (:4593-4599: 158 Sitrus 25), the status cures (149 Cheri to 153 Aspear), `PP_RESTORE` (154 Leppa), `CONFUSE_RESTORE` (156 Persim), `STATUS_RESTORE` (157 Lum, the hack's 42 Lava Cookie and 54 Old Gateau), the flavour berries (bl:4698-4772, :5121-5195: 159 Figy to 163 Iapapa, 8), `STATDOWN_RESTORE` (214 White Herb) and `HEAL_INFATUATION` (219 Mental Herb). So they run at Micle's points (two rows up): the switch-in sequence, after every hit and `MoveEnd`, and twice in the holder's own end-of-turn list (bcp:1362-1368, :1699-1709); a U-turn user gets no check before it goes (subscript_attack_then_switch_out.s:7-12) | was wrong: Showdown's `onUpdate` (and Lum's and the cookies' `onAfterSetStatus`) ate them after each hit, at an action's end and once after the whole end of turn, so a Sitrus holder the sandstorm took to half HP died to its Toxic with the berry held (the cartridge eats it first and lives), an end-of-turn EXP level-up moved the half-HP line before the check, and a U-turn user knocked to half HP ate before it left. Fixed: these items' checks run at the cartridge's points (mod/items.ts `HELD_CHECK_ITEMS`, `onKaizoHeldCheck`); `test/real/engineVsCalcItems.test.ts` pins the ROM's items with these hold effects to the list. White Herb stays on Showdown's handlers (nothing lowers a stage in the end of turn; its after-move check is `onAnyAfterMove`). The cure berries' end-of-turn case is the Thrash lock's fatigue confusion (bcp:1547-1563), cured at the holder's item-condition step before the next battler's list (no move has Yawn's effect 187, and an Orb holder holds no berry). Check in game: a badly poisoned Sitrus holder in a sandstorm, at a little over half HP, eats the berry before the poison. Tests: `test/unit/engine/heldItems.test.ts` |
| Protect against a missed roll | the miss flag and the Protect flag can both be set (bcp:2976-2977, :3012); subscript_missed.s shows Protect first (:17-31) and the miss only with no other flag (:78-84) | matches: the engine shows Protect and draws no roll, which can't change anything else |

What Baton Pass passes and Explosion's halving order were checked.

## Level-up mid-fight

`src/engine/levelUp.ts` follows the level-up task (bs:9824-10037), `Pokemon_CalcStats` (pk:564-647), `BattleSystem_ReloadPokemon`
(bl:169-194) and `Pokemon_LevelUpMove` (pk:3935-3964). These parts rest on an inference.

- **The stats are Showdown's `spreadModify`.** Its HP, `tr(tr(2B + IV + tr(EV / 4) + 100) × L / 100 + 10)`, equals the cartridge's
  `(2B + IV + EV / 4) × L / 100 + L + 10` (pk:601) in integer steps, and the other stats take the nature as `createBattle` does. The save's stored stats were matched against the engine's. Nothing to check unless a level-up's numbers ever differ in game.
- **A move learned into a free slot has no PP Ups.** The cartridge keeps the slot's stored PP Ups
  (`BoxPokemon_SetMoveSlot`, pk:3929-3930), which the engine doesn't carry: the save reader keeps PP Ups for known moves only. An empty
  slot holds none unless a move was forgotten from it after PP Ups. Check in game only for such a Pokémon.
- **The party's moves and PP equal the battler's.** The reload copies them back from the party (bl:184-190), which is written at every
  PP change (bcp:2283). In Showdown the party Pokémon and its battler are one object, so nothing is copied.
- **Mimic.** The reload skips a Mimicked slot (bl:185). A move learned into a free slot never lands on it (Mimic sits on a known move),
  and the line builder's replaced slot leaves a Mimicked battler slot alone, as Showdown's battler slot is a separate object there.
- **The line builder's chosen move comes after the levels.** `levelUp` applies `learn` once every level is done, not at its own level,
  and checks its slot against the moves it has then, so a slot an earlier level filled can be replaced. The state is the
  same: the offer comes only with four moves known, and with four known no later level changes a move.
- **Friendship is not raised** (pk:2623, :2635-2684): nothing in the engine reads it (Return and Frustration are plain hits).
- **`details` keeps the Pokémon's own species** at the new level (Showdown's convention: a Transform or a battle forme such as
  Castform-Sunny leaves it alone). It shows only in later protocol lines.

## Held items, the field and subscript 297

Read from the hack ROM's overlay 16 and battle-script NARC (`battle/skill/sub_seq.narc`), diffed against vanilla Platinum's.

- **The pinch check divides by 0 with `_u32_div_f`.** Every pinch block of `BattleSystem_TriggerHeldItem` (overlay 16,
  0x2257d44 and the nine after it, then 0x22583d4 to 0x225871a) tests Gluttony (`cmp r0, #82`), halves the item's power,
  and calls ARM9 0x020E2178 by `blx`. The ARM9 words there are `cmp r1, #0; bxeq lr; cmp r0, r1; ...`, `_u32_div_f`, which
  returns the dividend for a divisor of 0. `maxHP` is a `u32`, so the C compiles to the unsigned routine; a signed
  `_s32_div_f` is not what is called. Not checked in game: that the hack's compiled overlay is run as read. The overlay
  diff in `docs/ai-changes.md` finds the function unchanged, so vanilla's code does the same with the hack's parameter 0.
- **When a param-0 pinch item is eaten.** `BattleSystem_TriggerHeldItemOnStatus` (bl:4967) has the pinch cases and runs for every
  battler in speed order at each switch-in (bl:4152-4160), after each move (bcp:3730-3755) and at the end of the turn
  (bcp:1699-1709); `BattleSystem_TriggerHeldItem` (attacker and defender after a move, bcp:3685-3696, and the end of the turn) has them
  too. So a Ganlon, Apicot or Shoal Salt holder eats at entry, at any HP. The engine checks them at those points (mod/items.ts
  `pinchSwitchIn`, `pinchAfterMove`, and the holder's own end-of-turn list, as every pinch item; one end-of-turn check used to come before every list); a battler switching out (U-turn, Baton Pass) is skipped after the move, as
  `battlersSwitchingMask` does. Check in game: a Ganlon holder's berry is gone as the battle starts.
- **The rest of the held-item family.** The healing berries (Sitrus, Oran, Berry Juice, Shoal Shell, the Figy family),
  the status and confusion cures (Cheri to Aspear, Persim, Lum, the hack's Lava Cookie and Old Gateau), Leppa and Mental
  Herb are cases of the same two triggers as the pinch items, so they are checked at the same points
  (mod/items.ts `HELD_CHECK_ITEMS`; the row in "Known gaps, checked"). Before it they ate when Showdown's `onUpdate` ran
  (after each hit, at an action's end unless a switch was asked first, and once after the whole end of turn), and this list
  said they agreed with the cartridge at the end of the turn; they did not (the holder's own list comes before
  its poison, and before an EXP level-up the foe's faint pays), nor for a U-turn user. Between a multi-hit move's hits the
  cartridge runs its after-move effects, the held-item checks among them (`AFTER_MOVE_EFFECT_ATTACKER_ITEM` to
  `_HELD_ITEM_STATUS`), after every hit, before `LoopMultiHit` reloads the move (bcp:3624-3769, :3777-3790), as the engine's
  `pinchAfterMove` does after each hit (it also runs after a move its user couldn't make, `MoveAborted`, and at the turn's start). The engine reads these berries' numbers from the ROM. White Herb stays on Showdown's
  handlers.
- **Subscript 297** is a new member of `sub_seq.narc` (vanilla has 297 members, the hack 298): it plays Gravity's animation
  (`MOVE_GRAVITY`), prints "Gravity intensified!", sets `FIELD_CONDITION_GRAVITY_INIT` and runs `subscript_gravity_start`'s
  loop that grounds floating Pokémon. `TriggerEffectOnSwitch` runs it for the hack's map weather 12. Subscripts 238 and 251,
  which the cartridge runs when Gravity's and Trick Room's counters reach 0, are rewritten to set the condition again
  (251 is Trick Room's move script, run with the room off), so neither ends. The re-arm does not ask what set the condition
  (238's first command is the `FLAG_ON`; 251 runs only when the room is already off), so a Gravity or Trick Room *move* lasts the whole
  battle too, and the engine gives the move's conditions duration 0 (mod/field.ts `KAIZO_FIELD_CONDITIONS`). Check in game: Gravity
  from the move still on after 5 turns. The engine's Gravity and Trick Room from a field note
  have duration 0.
- **Map weather 17 and 18** are harsh sun and Trick Room (permanent). The docs write the sun note "SUN" or "PERMANENT SUN".
- **Docs weather without "PERMANENT"** ("RAIN", "HAIL", "SUN", "FOG") is the map's weather too, so the engine starts it
  permanent. "OPTIONAL HAIL" trainers are also given hail when the caller's field says so.
- **Item 71.** The docs' Items tab names it RageCandyBar, the decompilation's item numbering Shoal Shell; its data restores
  100 HP at half HP or less. The engine calls it Shoal Shell.
- **Fog and Defog**. The engine clears the deep fog where the decompilation does: a weather move or a weather
  ability setting its weather (`FIELD_CONDITION_WEATHER` includes the fog bit), and Defog (subscript_defog.s:64-65). The
  scripts are vanilla's in the hack (aiBattleScripts.test.ts finds only effects 48, 88, 104, 141, 182 and subscripts 238,
  251, 297 changed); the hack's overlay-16 code is taken to be vanilla's here as elsewhere. Defog stays an unmodelled move
  for the rest of its effect. Check in game: Rain Dance under a fog note, then a move's hit rate (no longer × 6 / 10);
  Weather Ball's damage in fog (doubled, still Normal); Moonlight in fog (a quarter of the max HP).

## Damage order

The engine's damage follows the cartridge's order (docs/engine-model.md, "Damage order"). These are the places where the
decompilation reads one way and the engine does something else, or where a reading is worth a check in game.

- **SolarBeam in deep fog.** The cartridge halves SolarBeam's damage by move ID 76 in `FIELD_CONDITION_SOLAR_DOWN`, which is rain,
  sand, hail and deep fog (condition.h:136-139; bl:7058-7060). The engine does the same (it is not Showdown's power halving, which
  has no fog). Check in game: SolarBeam under a fog map's note.
- **A resist berry and the caps.** The berry halves the damage in subscript_type_resist_berry.s, after UPDATE_HP's False Swipe,
  Endure and Focus caps (bcp:3381-3405), and Counter, Shell Bell and the stored damage read the unhalved damage (bcp:3407-3433).
  The engine halves before the caps (Showdown's `onSourceModifyDamage`), so it differs for a berry holder hit by a capped move
  (False Swipe, Endure: the cartridge caps first and halves the cap, leaving the holder with more HP), and for Bide, Counter,
  Mirror Coat, Metal Burst and Shell Bell, which read the unhalved damage on the cartridge. Each such hit is noted
  (`RESIST_BERRY_NOTE`, mod/scripts.ts), so a proof through it is unproven.
- **Gravity and Levitate.** `BattleSystem_ApplyTypeChart` tests Levitate through `Battler_Ability`,
  which gives no ability for Levitate under Gravity or Ingrain (bl:3087-3105), so the cartridge hits a Levitate holder under
  Gravity, as the engine does. Nothing to check.
- **Reckless goes by the ROM effect.** The cartridge's `powerMul` of 12 is set by the ROM effects 45, 48, 198, 253, 262 and 269
  (res/battle/scripts/effects/), not by the docs' recoil text, so the hack's Roar of Time (effect 262) is boosted, and a move the docs
  call recoil under another effect is not. The engine reads the installed move's ROM effect; `damage()` does too.
- **Semi-invulnerable and Minimized targets.** The cartridge doubles the power (`powerMul` 20, before every other power step) of a move whose ROM effect looks for the state: 146 and 149 for a target in the air, 147 and 126 underground, 261 and 257 underwater, 150 for Minimize. The engine does the same, by the installed move's ROM effect and the target's Fly, Bounce, Dig, Dive or Minimize volatile, and no longer doubles the final damage by move ID as Showdown does. `gen4Damage` takes the state from `CalcSide.hiding`.
- **The Metronome item** (hold effect 105, x(10 + turns) / 10 after Life Orb and before the roll, bs:1350-1352) is applied by the engine and `gen4Damage` (`CalcSide.metronomeTurns`). The cap of 10 is the cartridge's (`metronomeTurns < 10`, bl:6168). The engine's turns are Showdown's consecutive-use count, not the cartridge's `BattleSystem_UpdateMetronomeCount` / `VerifyMetronomeCount` (bl:6160-6200: the count is left alone while the holder is locked into Thrash, Outrage, Petal Dance, Uproar, Bide or a charge-turn move (ROM effects 26, 39, 75, 145, 151, 155, 255, 256, 263, 272), and a repeated Rollout is not taken back, and a failed repeat is taken back), which differ by a whole step. So `unmodelledIn` carries a note (`METRONOME_COUNT_NOTE`) once a holder uses a move while locked, or after a failed use, and a proof through it is unproven. `damage()` takes `metronomeTurns` as 0 unless the caller says. Check in game: a Metronome holder's third use in a row, and the use after a failed one.
- **Charge, Helping Hand and Mud / Water Sport** are applied by the engine from Showdown's volatiles in the cartridge's order
  (`cartridgePower`); `gen4Damage` and `damage()` take them as absent (`CalcSide` carries no such state).
- **Struggle's type in the confusion self-hit.** `CALC_SELF_HIT(MOVE_STRUGGLE, 40)` takes Struggle's type from the move data
  (bl:6679-6684): Normal in vanilla, so Silk Scarf and the other Normal boosters raise it. The engine and `gen4ConfusionDamage`
  assume the hack's Struggle is still Normal.
