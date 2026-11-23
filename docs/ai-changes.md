# Trainer AI: the hack against vanilla

This compares the hack's ROM (Platinum Kaizo, game code JAK7) with vanilla US Platinum (game code CPUE):

- **The trainer AI script.** It sits in overlay 14 from `gTrainerAITable`, at offset 0x4C84 in both ROMs. The two scripts are compared instruction by instruction, from every flag's entry point.
- **The rest of overlay 14**, which is `trainer_ai.c`'s code and data. It's the same size in both ROMs, so it's compared byte by byte.
- **Overlay 16**, the battle code. The hack's copy is 32 bytes longer, so its halfwords are aligned with vanilla's first. It is also compared function by function, with every function named from the decompilation (see "Overlay 16 and the code around it, by function").
- **The other binaries around the battle code:** overlays 12 and 13 and the ARM9 binary, compared in place.
- **The move effects** that the docs' AI Changes tab relies on.
- **The move data the AI reads**, in both ROMs' move tables: every move's effect ID, power, type, class, accuracy, PP and priority.

Names come from the decompilation, pret/pokeplatinum at 62bdaacdc, and from the docs:

- **Script labels** come from `src/battle/trainer_ai/script.s`, which lines up word for word with vanilla's script.
- **Constant names** (moves, effects, abilities, items and types) come from the enum lists in `generated/*.txt`. Those enums' headers are generated at build time, so they aren't in the clone. Each constant's value is its 0-based line number in the list.
- **Move names** in the move-data section come from the docs' Moves tab, because the hack renames moves.
- **Overlay 14's function names.**
  - The `AICmd_*` handlers come from `sAICommandTable`.
  - The other `trainer_ai.c` functions are found by counting `push {…, lr}` prologues between two handlers, in source order. These names are marked "(inferred)".
  - Counting fails after `AICmd_LoadAbility`: the source defines 21 functions there, but the binary has only 14 prologues. Those functions get address names in pret's style, like `ov14_02222E84`.

**To regenerate:** run `npx tsx src/ai/diff/cli.ts`. It reads `PK_ROM`, `PK_VANILLA_ROM`, `POKEPLATINUM` (the decompilation clone, by default `~/src/pokeplatinum`, with `src` in its sparse checkout: `git -C ~/src/pokeplatinum sparse-checkout add src`) and the docs tabs saved by `npm run extract` (in `data/docs`, or `DATA_DIR/docs`). It rewrites the three generated blocks below: the move data (`generated:moves` markers), the function-level diff (`generated:handlers` markers) and the diff (`generated` markers). `npm run test:real -- test/real/aiChangesDoc` fails when any block is out of date.

## Summary

- **The script has one change, the Dry Skin fix.** One argument word differs in the whole script, and every other flag is unchanged.
- **The rest of the AI Changes tab is move data.** The hack gives moves different effect IDs, and the unchanged script picks routines by effect.
- **Many moves have a new effect ID, power, type, class, accuracy, PP or priority.** The AI reads the new data as vanilla's script and code would. The move-data section below counts and lists them all.
- **Overlay 14's C code behaves as vanilla's does.** All 111 changed regions outside the script are BL calls into overlay 16. Each call still reaches the same function, which moved 8 or 28 bytes because overlay 16 grew. `sAICommandTable` and the AI's data tables are unchanged.
- **Overlay 16 changes in exactly four functions, and none of them is one the AI reaches.** Its 1,145 functions are named from the decompilation and compared one by one. The other 1,141 are the same, up to BLs and pointers that reach the same function or data. The four:
  - `BattleControllerPlayer_CheckObedience`: every Pokémon obeys;
  - `BattleControllerPlayer_CheckMoveHitAccuracy` and `BattleControllerPlayer_CheckMoveHitOverrides`: Hurricane gets Thunder's sun and rain accuracy;
  - `BattleSystem_TriggerEffectOnSwitch`: three more map weathers start a field effect when the battle starts: Gravity (new subscript 297), harsh sun and Trick Room.

  The data gains 4 bytes of alignment padding. So the damage calculation, the speed comparison and the post-KO switch are vanilla's, and so are the 48 functions overlay 14 reaches.
- **The ARM9 changes the trainer's party, not the battle.** No ARM9 function that overlays 14 and 16 reach changed. The hack rewrote `TrainerData_BuildParty`, which builds each trainer's Pokémon before the battle. Its other ARM9 changes are field, menu and boot code, and data the battle doesn't read.

## The AI Changes tab

### "Dry Skin AI Bug fixed"

**A script change.** It's the one change in the generated diff below, under Basic.

- **Vanilla:** `Basic_CheckForImmunity` tests `ABILITY_LEVITATE` twice (script.s:78). The second test was meant to be Dry Skin, so the branch to `Basic_CheckWaterAbsorption2` never runs.
- **The hack:** the second test's argument is `ABILITY_DRY_SKIN` (87).

The AI now scores a damaging Water move −12 against a target it takes to have Dry Skin.

### "1/2 recoil" moves follow the intended recoil routine

**Move data.** The script and overlay 14 are unchanged here.

- **The moves:** Hyper Beam, Giga Impact, Draco Meteor, Outrage, Superpower and Hydro Cannon have effect 48 in the hack. In vanilla, 48 is `BATTLE_EFFECT_RECOIL_QUARTER`, Take Down's effect. The docs' Moves tab says these moves deal 1/2 recoil.
- **The routine:** the script sends effect 48 to `Expert_RecoilMove` (script.s:1661). If the target resists or is immune, it changes nothing. Otherwise, a Rock Head or Magic Guard attacker gets +1.
- **Damage scoring:** effect 48 isn't in `sNoDamageCalcMoveEffects` (trainer_ai.c:31–46), so the AI damage-scores these six moves.
  - In vanilla, Hyper Beam, Giga Impact and Hydro Cannon had `RECHARGE_AFTER` and Superpower had `LOWER_OWN_ATK_AND_DEF`. Both effects are on that list, so these four moves weren't damage-scored.
  - Head Smash keeps `BATTLE_EFFECT_RECOIL_HALF` (269), which is on that list too. It goes to the same routine (script.s:1806), but the AI never damage-scores it.
- **"Bugged targeting":** nothing in the script or in overlay 14 matches it. If the fix is real, it's in battle data this diff doesn't cover.

### "1/4 recoil" moves use the three −1 conditions

**Move data.** Take Down, Close Combat and Brave Bird have effect 182 in the hack. In vanilla, 182 is `BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF`, Superpower's effect. The script sends effect 182 to `Expert_Superpower` (script.s:1735, routine at 4467). That routine differs from the tab in three ways:

- **It has a fourth condition.** If the attacker's Attack stage is below neutral, the score drops by 1 (`IfStatStageLessThan AI_BATTLER_ATTACKER, BATTLE_STAT_ATTACK, 6`). The tab leaves this out.
- **The conditions don't add up.** The first one that holds gives −1 and ends the routine, so the most the routine takes off is 1.
- **A speed tie counts as "faster".** The routine only tests for "slower" (`COMPARE_SPEED_SLOWER`).

The tab's numbers are right: "HP > 59%" is `IfHPPercentLessThan 60` skipping the −1, and "HP > 40%" is `IfHPPercentGreaterThan 40`.

Effect 182 is also in `sNoDamageCalcMoveEffects` (trainer_ai.c:41). So the AI never damage-scores these three moves, and Basic sends them to `Basic_CheckNonStandardDamageOrChargeTurn` (script.s:237) instead.

### Triple Axel and Fury Cutter count as Risky; Triple Kick and Rock Wrecker don't

**Move data.**

- **Risky:** Triple Axel and Fury Cutter have effect 88 in the hack. That's vanilla's `BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL`, Psywave's effect, and it's in `Risky_RiskyEffects` (script.s:6544). Under the Risky flag, each gets +2 half of the time.
- **Not Risky:** Triple Kick and Rock Wrecker have effect 104, `HIT_THREE_TIMES`, which isn't in that table.
- **Triple Kick's behaviour:** the tab says effect 88 behaves like Triple Kick in battle. That's battle data, not the AI.

The unchanged AI code treats effect 88 as Psywave in three more ways:

- **Basic** sends it to `Basic_CheckNonStandardDamageOrChargeTurn` (script.s:186).
- **The damage estimate always runs** for it, because effect 88 is in `sAltPowerMoveEffects` (trainer_ai.c:55).
- **Triple Axel is estimated as Psywave.** It keeps Psywave's move ID, 149. `TrainerAI_CalcDamage` switches on the move ID, so it estimates Triple Axel's damage as `level × (rand % 11 + 5) / 10`, which costs one RNG draw (trainer_ai.c:3014). Fury Cutter is estimated normally, from its power.

### Hurricane doesn't use the Thunder routine

**Move data, plus overlay 16 code for the accuracy.**

- **Hurricane's effect:** Hurricane (move 140, vanilla Barrage) has effect 141, `BATTLE_EFFECT_UNUSED_141`. No script routine tests 141, so Hurricane gets no Expert routine.
- **Thunder gets none either.** This is a vanilla bug the hack keeps. The script tests `SKIP_CHARGE_TURN_IN_SUN` where it means `THUNDER` (script.s:1718–1719). The line before already sends that effect elsewhere, so `Expert_Thunder` never runs.
- **The "similar accuracy check":** overlay 16 adds a test for effect 141 beside Thunder's two weather checks (see below).

### The tab's notes

- **"Please check individual move index effects/priority":** the generated table below lists the effects of the moves the tab names.
- **"Certain moves may read as having effects they do not":** the AI reads the ROM's effect IDs as they are. For example, Hyper Beam reads as `RECOIL_QUARTER`, and the script routes it by that.

## Move IDs that the AI's damage estimate treats specially

`TrainerAI_CalcDamage` (trainer_ai.c:2885–3072) special-cases some moves by ID, not by effect. The hack renamed two of those IDs, so the AI estimates the new moves with the old formula:

- **149, Triple Axel (vanilla Psywave):** `level × (rand % 11 + 5) / 10` fixed damage, which costs one RNG draw.
- **222, Bulldoze (vanilla Magnitude):** a random power of 10 to 150 from Magnitude's table, which also costs one RNG draw (trainer_ai.c:3028).

The other special-cased IDs keep their vanilla moves in the hack: Natural Gift, Judgment, Hidden Power, Gyro Ball, Dragon Rage, Sonic Boom, Seismic Toss, Night Shade, Return, Frustration, Low Kick and Grass Knot. The same holds for `TrainerAI_MoveType`'s Weather Ball.

## Move data changes the AI sees

The trainer AI never reads a move's name. It picks its script routines by the move's effect ID in the ROM's move table, and it estimates damage from the power, type and class in that table. The hack gives many moves a new effect ID and new numbers, and the script still reads each ID the way vanilla does. So the AI treats a move as whatever its new ID meant in vanilla, even where the hack's battle code makes the move do something else. For example, Memento now has Explosion's effect (7), so the AI scores it with Explosion's routines, and Lunar Dance has Recover's (32), so the AI scores it as a healing move. The first table below lists every move whose effect ID changed, with the routines that test its old ID and its new one. The second lists every move whose power, type, class, accuracy, PP or priority changed.

Reading the tables:

- **Whose move is tested.** Most routines test the AI's own move. Three test the last move the player's Pokémon used instead: `Expert_Substitute_CheckTargetLastMove`, `Expert_Encore` and `Expert_ChargeTurnWithInvuln_CompareSpeed`.
- **The `CheckHP_*` labels are HP bands.** `CheckHP_Main` is the AI's Pokémon at 30% HP or less, `CheckHP_31To70Percent` and `CheckHP_GT70Percent` the higher bands, and `CheckHP_Target*` the same bands for the player's Pokémon. A move in a band's table usually gets −2.
- **The "Damage scoring" columns** mark every move the AI now damage-scores or no longer does, and a blank means no change. The AI estimates a move's damage when its effect is in `sAltPowerMoveEffects` (at any power), or when its power is over 1 and its effect isn't in `sNoDamageCalcMoveEffects` (trainer_ai.c:31–61, 1035–1036).
- **Left out:** `IfMoveEffectKnown` and `IfMoveEffectNotKnown`. These ask whether the player's Pokémon has shown a move with a given effect, so a player's Lunar Dance counts as a known healing move there.
- **Which fields matter to the AI:**
  - Power, type and class change its damage estimate, and its `LoadMovePower`, `LoadTypeFrom` and `LoadCurrentMoveClass` reads.
  - PP only decides when a move runs out. The AI scores an empty slot 0 (trainer_ai.c:490).
  - Accuracy and priority change the battle, but not the AI's choice. `trainer_ai.c` never reads accuracy, and the AI's speed checks skip priority (battle_lib.c:1375).
- **Type 9** is the decompilation's `TYPE_MYSTERY`, which the docs write "???".

<!-- generated:moves -->
_Written by `npx tsx src/ai/diff/cli.ts` from the two ROMs, the decompilation and the docs' Moves tab. Do not edit by hand._

### Effects

97 of the 471 move records have a different effect ID in the hack. Each AI routine is a test of that effect in the hack's script: `Label → Target` where a move with the effect jumps to Target, and `Label` where it carries on past the test. Label is the nearest script.s label before the test. "none" means no routine tests the effect.

| ID | Move | Vanilla effect | Its AI routines | Hack effect | Its AI routines | Damage scoring |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | DoubleSlap | BATTLE_EFFECT_MULTI_HIT (29) | none | BATTLE_EFFECT_HIT_TWICE (44) | none |  |
| 4 | Water Ball (vanilla Comet Punch) | BATTLE_EFFECT_MULTI_HIT (29) | none | BATTLE_EFFECT_HIT (0) | none |  |
| 11 | ViceGrip | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 20 | Mystical Fire (vanilla Bind) | BATTLE_EFFECT_BIND_HIT (42) | `Expert_Main → Expert_BindingMove` | BATTLE_EFFECT_LOWER_SP_ATK_HIT (71) | none |  |
| 21 | Slam | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_PARALYZE_HIT (6) | none |  |
| 35 | Wrap | BATTLE_EFFECT_BIND_HIT (42) | `Expert_Main → Expert_BindingMove` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 36 | Take Down | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_Superpower` | no longer damage-scored |
| 37 | Thrash | BATTLE_EFFECT_CONTINUE_AND_CONFUSE_SELF (27) | none | BATTLE_EFFECT_RECOIL_PARALYZE_HIT (262) | `Expert_Main → Expert_RecoilMove` |  |
| 62 | Aurora Beam | BATTLE_EFFECT_LOWER_ATTACK_HIT (68) | none | BATTLE_EFFECT_BYPASS_ACCURACY (17) | `Expert_Main → Expert_BypassAccuracyMove` |  |
| 63 | Hyper Beam | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 65 | Drill Peck | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` |  |
| 66 | Submission | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 80 | Petal Dance | BATTLE_EFFECT_CONTINUE_AND_CONFUSE_SELF (27) | none | BATTLE_EFFECT_CONFUSE_HIT (76) | none |  |
| 83 | Fire Spin | BATTLE_EFFECT_BIND_HIT (42) | `Expert_Main → Expert_BindingMove` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 91 | Dig | BATTLE_EFFECT_DIG (256) | `Expert_Main → Expert_ChargeTurnWithInvuln` | BATTLE_EFFECT_HIT (0) | none |  |
| 99 | Rage | BATTLE_EFFECT_RAISE_ATK_WHEN_HIT (81) | `CheckHP_Main → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_HIT_BEFORE_SWITCH (128) | `Expert_Main → Expert_Pursuit` |  |
| 111 | Rock Ball (vanilla Defense Curl) | BATTLE_EFFECT_DEF_UP_DOUBLE_ROLLOUT_POWER (156) | `Basic_ScoreMoveEffect → Basic_CheckHighStatStage_Defense`<br>`SetupFirstTurn_Main` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 117 | Bide | BATTLE_EFFECT_BIDE (26) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_Bide`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2` | BATTLE_EFFECT_METAL_BURST (227) | `Basic_ScoreMoveEffect → Basic_CheckMetalBurst`<br>`Expert_Main → Expert_MetalBurst`<br>`Risky_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2` |  |
| 128 | Clamp | BATTLE_EFFECT_BIND_HIT (42) | `Expert_Main → Expert_BindingMove` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 130 | Solar-Beam (vanilla Skull Bash) | BATTLE_EFFECT_CHARGE_TURN_DEF_UP (145) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_ChargeTurnNoInvuln` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 131 | Hail Ball (vanilla Spike Cannon) | BATTLE_EFFECT_MULTI_HIT (29) | none | BATTLE_EFFECT_HIT (0) | none |  |
| 132 | Constrict | BATTLE_EFFECT_LOWER_SPEED_HIT (70) | `Expert_Main → Expert_SpeedDownOnHit` | BATTLE_EFFECT_HIT (0) | none |  |
| 134 | Kinesis | BATTLE_EFFECT_ACC_DOWN (23) | `Basic_ScoreMoveEffect → Basic_CheckLowStatStage_Accuracy`<br>`Expert_Main → Expert_StatusAccuracyDown`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` | BATTLE_EFFECT_SP_DEF_DOWN_2 (62) | `Basic_ScoreMoveEffect → Basic_CheckLowStatStage_SpDefense`<br>`Expert_Main → Expert_StatusSpDefenseDown`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` |  |
| 139 | Poison Gas | BATTLE_EFFECT_STATUS_POISON (66) | `Basic_ScoreMoveEffect → Basic_CheckCannotPoison`<br>`Expert_Main → Expert_StatusPoison`<br>`Expert_Substitute_CheckTargetLastMove → Expert_Substitute_CheckTargetStatus`<br>`Expert_Encore`<br>`SetupFirstTurn_Main`<br>`TagStrategy_PartnerStatusMove → TagStrategy_PartnerPoisonStatus`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` | BATTLE_EFFECT_STATUS_BADLY_POISON (33) | `Basic_ScoreMoveEffect → Basic_CheckCannotPoison`<br>`Expert_Main → Expert_ToxicLeechSeed`<br>`Expert_Substitute_CheckTargetLastMove → Expert_Substitute_CheckTargetStatus`<br>`Expert_Encore`<br>`TagStrategy_PartnerStatusMove → TagStrategy_PartnerPoisonStatus`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2` |  |
| 140 | Hurricane (vanilla Barrage) | BATTLE_EFFECT_MULTI_HIT (29) | none | BATTLE_EFFECT_UNUSED_141 (141) | none |  |
| 143 | Sky Attack | BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH (75) | `Expert_Main → Expert_ChargeTurnNoInvuln` | BATTLE_EFFECT_RECOIL_PARALYZE_HIT (262) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 150 | HP Water (vanilla Splash) | BATTLE_EFFECT_DO_NOTHING (85) | `Expert_Encore` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 160 | HP Ice (vanilla Conversion) | BATTLE_EFFECT_CONVERSION (30) | `Expert_Main → Expert_Conversion`<br>`Expert_Encore`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 168 | Thief | BATTLE_EFFECT_STEAL_HELD_ITEM (105) | `Expert_Main → Expert_Thief` | BATTLE_EFFECT_DO_NOTHING (85) | `Expert_Encore` |  |
| 171 | HP Ghost (vanilla Nightmare) | BATTLE_EFFECT_STATUS_NIGHTMARE (107) | `Basic_ScoreMoveEffect → Basic_CheckNightmare`<br>`Expert_Encore` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 177 | Aeroblast | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` | BATTLE_EFFECT_TRI_ATTACK (36) | none |  |
| 200 | Outrage | BATTLE_EFFECT_CONTINUE_AND_CONFUSE_SELF (27) | none | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` |  |
| 205 | Rollout | BATTLE_EFFECT_DOUBLE_POWER_EACH_TURN_LOCK_INTO (117) | none | BATTLE_EFFECT_HIT (0) | none |  |
| 209 | Wild Charge (vanilla Spark) | BATTLE_EFFECT_PARALYZE_HIT (6) | none | BATTLE_EFFECT_RECOIL_PARALYZE_HIT (262) | `Expert_Main → Expert_RecoilMove` |  |
| 210 | Fury Cutter | BATTLE_EFFECT_DOUBLE_POWER_EACH_TURN (119) | `CheckHP_Target → CheckHP_Target_TryScoreMinus2` | BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL (88) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Risky_Main`<br>`TagStrategy_Main → TagStrategy_ScoreMove`<br>`TagStrategy_CheckBeforeScoring → TagStrategy_CheckSpecialScoring`<br>`TagStrategy_PartnerKnowsHelpingHand → TagStrategy_PartnerHelpingHand_End` |  |
| 216 | Return | BATTLE_EFFECT_POWER_BASED_ON_FRIENDSHIP (121) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn` | BATTLE_EFFECT_HIT (0) | none |  |
| 218 | Frustration | BATTLE_EFFECT_POWER_BASED_ON_LOW_FRIENDSHIP (123) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn` | BATTLE_EFFECT_HIT (0) | none |  |
| 222 | Bulldoze (vanilla Magnitude) | BATTLE_EFFECT_PSYWAVE (126) | `Basic_ScoreMoveEffect → Basic_CheckMagnitude` | BATTLE_EFFECT_LOWER_SPEED_HIT (70) | `Expert_Main → Expert_SpeedDownOnHit` | now damage-scored |
| 224 | Megahorn | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` |  |
| 229 | HP Fire (vanilla Rapid Spin) | BATTLE_EFFECT_REMOVE_HAZARDS_AND_BINDING (129) | none | BATTLE_EFFECT_HIT (0) | none |  |
| 233 | Vital Throw | BATTLE_EFFECT_PRIORITY_NEG_1_BYPASS_ACCURACY (78) | `Expert_Main → Expert_VitalThrow` | BATTLE_EFFECT_BYPASS_ACCURACY (17) | `Expert_Main → Expert_BypassAccuracyMove` |  |
| 239 | Twister | BATTLE_EFFECT_FLINCH_DOUBLE_DAMAGE_FLY_OR_BOUNCE (146) | none | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 245 | ExtremeSpeed | BATTLE_EFFECT_PRIORITY_1 (103) | `EvalAttack_ApplyKillBonuses → EvalAttack_ScorePlus2`<br>`TagStrategy_ScoreMove → TagStrategy_TryScorePlus1` | BATTLE_EFFECT_HIT (0) | none |  |
| 254 | Stockpile | BATTLE_EFFECT_STOCKPILE (160) | `Basic_ScoreMoveEffect → Basic_CheckMaxStockpile`<br>`Expert_Encore` | BATTLE_EFFECT_DEF_SPD_UP (206) | `Basic_ScoreMoveEffect → Basic_CheckCosmicPower`<br>`Expert_Main → Expert_StatusSpDefenseUp`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2` |  |
| 255 | HP Rock (vanilla Spit Up) | BATTLE_EFFECT_SPIT_UP (161) | `Basic_ScoreMoveEffect → Basic_CheckCanSpitUpOrSwallow`<br>`Expert_Main → Expert_SpitUp`<br>`Expert_Encore` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 256 | Swallow | BATTLE_EFFECT_SWALLOW (162) | `Basic_ScoreMoveEffect → Basic_CheckCanSpitUpOrSwallow`<br>`Basic_CheckCanSpitUpOrSwallow → Basic_CheckCanRecoverHP`<br>`Expert_Main → Expert_Recovery`<br>`Expert_Encore` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` | now damage-scored |
| 262 | Memento | BATTLE_EFFECT_FAINT_AND_ATK_SP_ATK_DOWN_2 (168) | `Basic_ScoreMoveEffect → Basic_CheckMemento`<br>`Expert_Main → Expert_Explosion`<br>`CheckHP_GT70Percent → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_HALVE_DEFENSE (7) | `Basic_ScoreMoveEffect → Basic_CheckCannotExplode`<br>`Expert_Main → Expert_Explosion`<br>`EvalAttack_Main → EvalAttack_MaybeDeprioritize`<br>`EvalAttack_ApplyKillBonuses → EvalAttack_Terminate`<br>`Risky_Main`<br>`TagStrategy_ScoreMove → TagStrategy_CheckSpecialScoring`<br>`CheckHP_GT70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2` |  |
| 269 | HP Dark (vanilla Taunt) | BATTLE_EFFECT_TAUNT (175) | none | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 271 | HP Psychic (vanilla Trick) | BATTLE_EFFECT_SWITCH_HELD_ITEMS (177) | `Basic_ScoreMoveEffect → Basic_CheckCanRemoveItem`<br>`Expert_Main → Expert_Trick`<br>`Expert_Encore` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 276 | Superpower | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_Superpower` | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 279 | Revenge | BATTLE_EFFECT_DOUBLE_POWER_IF_HIT (185) | `Expert_Main → Expert_Revenge`<br>`Risky_Main` | BATTLE_EFFECT_DOUBLE_POWER_IF_MOVING_SECOND (230) | `Expert_Main → Expert_Payback`<br>`Risky_Main` |  |
| 281 | Yawn | BATTLE_EFFECT_STATUS_SLEEP_NEXT_TURN (187) | `Basic_ScoreMoveEffect → Basic_CheckCannotSleep`<br>`SetupFirstTurn_Main`<br>`Harrassment_Main` | BATTLE_EFFECT_STATUS_SLEEP (1) | `Basic_ScoreMoveEffect → Basic_CheckCannotSleep`<br>`Expert_Main → Expert_StatusSleep`<br>`Expert_Substitute_CheckTargetLastMove → Expert_Substitute_CheckTargetStatus`<br>`Risky_Main`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` |  |
| 284 | Eruption | BATTLE_EFFECT_DECREASE_POWER_WITH_LESS_USER_HP (190) | `Expert_Main → Expert_WaterSpout`<br>`CheckHP_Main → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_RECOIL_BURN_HIT (253) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 289 | Drill Run (vanilla Snatch) | BATTLE_EFFECT_STEAL_STATUS_MOVE (195) | `Expert_Main → Expert_Snatch` | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` | now damage-scored |
| 291 | Dive | BATTLE_EFFECT_DIVE (255) | `Expert_Main → Expert_ChargeTurnWithInvuln` | BATTLE_EFFECT_HIT (0) | none |  |
| 292 | HP Fighting (vanilla Arm Thrust) | BATTLE_EFFECT_MULTI_HIT (29) | none | BATTLE_EFFECT_HIT (0) | none |  |
| 298 | Teeter Dance | BATTLE_EFFECT_CONFUSE_ALL (199) | `Expert_Encore`<br>`SetupFirstTurn_Main`<br>`Risky_Main`<br>`Harrassment_Main` | BATTLE_EFFECT_STATUS_CONFUSE (49) | `Basic_ScoreMoveEffect → Basic_CheckCannotConfuse`<br>`Expert_Main → Expert_StatusConfuse`<br>`Expert_Substitute_CheckTargetLastMove → Expert_Substitute_CheckTargetConfused`<br>`Expert_Encore`<br>`SetupFirstTurn_Main`<br>`Risky_Main`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` |  |
| 300 | HP Ground (vanilla Mud Sport) | BATTLE_EFFECT_HALVE_ELECTRIC_DAMAGE (201) | `Basic_ScoreMoveEffect → Basic_CheckCanMudSport`<br>`Expert_Main → Expert_MudSport`<br>`Expert_Encore`<br>`CheckHP_Main → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 301 | Ice Ball | BATTLE_EFFECT_DOUBLE_POWER_EACH_TURN_LOCK_INTO (117) | none | BATTLE_EFFECT_BLIZZARD (260) | `Expert_Main → Expert_Blizzard` |  |
| 302 | Needle Arm | BATTLE_EFFECT_FLINCH_HIT (31) | none | BATTLE_EFFECT_HIT (0) | none |  |
| 307 | Blast Burn | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_RECOIL_BURN_HIT (253) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 308 | Hydro Cannon | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 313 | Fake Tears | BATTLE_EFFECT_SP_DEF_DOWN_2 (62) | `Basic_ScoreMoveEffect → Basic_CheckLowStatStage_SpDefense`<br>`Expert_Main → Expert_StatusSpDefenseDown`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` | BATTLE_EFFECT_SPEED_DOWN_2 (60) | `Basic_ScoreMoveEffect → Basic_CheckLowStatStage_Speed`<br>`Expert_Main → Expert_StatusSpeedDown`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` |  |
| 315 | Overheat | BATTLE_EFFECT_USER_SP_ATK_DOWN_2 (204) | `Expert_Main → Expert_Overheat` | BATTLE_EFFECT_RECOIL_BURN_HIT (253) | `Expert_Main → Expert_RecoilMove` |  |
| 319 | Metal Sound | BATTLE_EFFECT_SP_DEF_DOWN_2 (62) | `Basic_ScoreMoveEffect → Basic_CheckLowStatStage_SpDefense`<br>`Expert_Main → Expert_StatusSpDefenseDown`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` | BATTLE_EFFECT_SPEED_DOWN_2 (60) | `Basic_ScoreMoveEffect → Basic_CheckLowStatStage_Speed`<br>`Expert_Main → Expert_StatusSpeedDown`<br>`SetupFirstTurn_Main`<br>`CheckHP_Main → CheckHP_TryScoreMinus2`<br>`CheckHP_31To70Percent → CheckHP_TryScoreMinus2`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2`<br>`Harrassment_Main` |  |
| 327 | Sky Uppercut | BATTLE_EFFECT_HIT_FLY (207) | none | BATTLE_EFFECT_DOUBLE_DAMAGE_FLY_OR_BOUNCE (149) | none |  |
| 328 | Sand Tomb | BATTLE_EFFECT_BIND_HIT (42) | `Expert_Main → Expert_BindingMove` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 329 | Sheer Cold | BATTLE_EFFECT_ONE_HIT_KO (38) | `Basic_ScoreMoveEffect → Basic_CheckOHKOWouldFail`<br>`Expert_Main → Expert_OHKOMove`<br>`Risky_Main`<br>`TagStrategy_Main → TagStrategy_ScoreMove`<br>`TagStrategy_CheckBeforeScoring → TagStrategy_CheckSpecialScoring`<br>`TagStrategy_PartnerKnowsHelpingHand → TagStrategy_PartnerHelpingHand_End`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2` | BATTLE_EFFECT_BLIZZARD (260) | `Expert_Main → Expert_Blizzard` | now damage-scored |
| 337 | Dragon Claw | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` |  |
| 338 | Frenzy Plant | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_RECOIL_PARALYZE_HIT (262) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 340 | Bounce | BATTLE_EFFECT_BOUNCE (263) | `Expert_Main → Expert_ChargeTurnWithInvuln` | BATTLE_EFFECT_PARALYZE_HIT (6) | none |  |
| 343 | HP Grass (vanilla Covet) | BATTLE_EFFECT_STEAL_HELD_ITEM (105) | `Expert_Main → Expert_Thief` | BATTLE_EFFECT_HIT (0) | none |  |
| 346 | Scald (vanilla Water Sport) | BATTLE_EFFECT_HALVE_FIRE_DAMAGE (210) | `Basic_ScoreMoveEffect → Basic_CheckWaterSport`<br>`Expert_Main → Expert_WaterSport`<br>`Expert_Encore`<br>`CheckHP_Main → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_THAW_AND_BURN_HIT (125) | none | now damage-scored |
| 354 | Psycho Boost | BATTLE_EFFECT_USER_SP_ATK_DOWN_2 (204) | `Expert_Main → Expert_Overheat` | BATTLE_EFFECT_HIT (0) | none |  |
| 361 | HP Electric (vanilla Healing Wish) | BATTLE_EFFECT_FAINT_AND_FULL_HEAL_NEXT_MON (220) | `Basic_ScoreMoveEffect → Basic_CheckHealingWish`<br>`Expert_Main → Expert_HealingWish`<br>`Expert_Encore`<br>`CheckHP_GT70Percent → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 370 | Close Combat | BATTLE_EFFECT_DEF_SPD_DOWN_HIT (229) | `Expert_Main → Expert_CloseCombat` | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_Superpower` | no longer damage-scored |
| 377 | Aqua Cutter (vanilla Heal Block) | BATTLE_EFFECT_PREVENT_HEALING (236) | `Basic_ScoreMoveEffect → Basic_CheckHealBlock`<br>`Expert_Main → Expert_HealBlock`<br>`Expert_Encore` | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` | now damage-scored |
| 378 | Wring Out | BATTLE_EFFECT_INCREASE_POWER_WITH_MORE_HP (237) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_WringOut`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2` | BATTLE_EFFECT_DOUBLE_POWER_WHEN_BELOW_HALF (221) | `Expert_Main → Expert_Brine` | now damage-scored |
| 389 | Sucker Punch | BATTLE_EFFECT_HIT_FIRST_IF_TARGET_ATTACKING (248) | `Expert_Main → Expert_SuckerPunch`<br>`EvalAttack_Main → EvalAttack_MaybeDeprioritize`<br>`EvalAttack_ApplyKillBonuses → EvalAttack_TryScorePlus4`<br>`Risky_Main` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 391 | Heart Swap | BATTLE_EFFECT_SWAP_STAT_CHANGES (250) | `Basic_ScoreMoveEffect → Basic_CheckStatStageImbalance`<br>`Expert_Main → Expert_HeartSwap`<br>`Expert_Encore` | BATTLE_EFFECT_RECOVER_HALF_DAMAGE_DEALT (3) | `Expert_Main → Expert_DrainMove` | now damage-scored |
| 404 | X-Scissor | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` |  |
| 406 | Dragon Pulse | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_BYPASS_ACCURACY (17) | `Expert_Main → Expert_BypassAccuracyMove` |  |
| 413 | Brave Bird | BATTLE_EFFECT_RECOIL_THIRD (198) | `Expert_Main → Expert_RecoilMove` | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_Superpower` | no longer damage-scored |
| 415 | HP Flying (vanilla Switcheroo) | BATTLE_EFFECT_SWITCH_HELD_ITEMS (177) | `Basic_ScoreMoveEffect → Basic_CheckCanRemoveItem`<br>`Expert_Main → Expert_Trick`<br>`Expert_Encore` | BATTLE_EFFECT_HIT (0) | none | now damage-scored |
| 416 | Giga Impact | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 419 | Avalanche | BATTLE_EFFECT_DOUBLE_POWER_IF_HIT (185) | `Expert_Main → Expert_Revenge`<br>`Risky_Main` | BATTLE_EFFECT_FLINCH_FREEZE_HIT (274) | none |  |
| 421 | Shadow Claw | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` | BATTLE_EFFECT_MULTI_HIT (29) | none |  |
| 434 | Draco Meteor | BATTLE_EFFECT_USER_SP_ATK_DOWN_2 (204) | `Expert_Main → Expert_Overheat` | BATTLE_EFFECT_RECOIL_QUARTER (48) | `Expert_Main → Expert_RecoilMove` |  |
| 437 | Leaf Storm | BATTLE_EFFECT_USER_SP_ATK_DOWN_2 (204) | `Expert_Main → Expert_Overheat` | BATTLE_EFFECT_HIT (0) | none |  |
| 438 | Power Whip | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` |  |
| 439 | Rock Wrecker | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_HIT_THREE_TIMES (104) | none | now damage-scored |
| 454 | Attack Order | BATTLE_EFFECT_HIGH_CRITICAL (43) | `Expert_Main → Expert_HighCritical`<br>`Risky_Main` | BATTLE_EFFECT_POISON_HIT (2) | none |  |
| 459 | Roar of Time | BATTLE_EFFECT_RECHARGE_AFTER (80) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_RechargeTurn` | BATTLE_EFFECT_RECOIL_PARALYZE_HIT (262) | `Expert_Main → Expert_RecoilMove` | now damage-scored |
| 461 | Lunar Dance | BATTLE_EFFECT_FAINT_FULL_RESTORE_NEXT_MON (270) | `Basic_ScoreMoveEffect → Basic_CheckLunarDance`<br>`Expert_Main → Expert_HealingWish`<br>`CheckHP_GT70Percent → CheckHP_TryScoreMinus2` | BATTLE_EFFECT_RESTORE_HALF_HP (32) | `Basic_ScoreMoveEffect → Basic_CheckCanRecoverHP`<br>`Expert_Main → Expert_Recovery`<br>`CheckHP_GT70Percent → CheckHP_TryScoreMinus2` |  |
| 462 | Crush Grip | BATTLE_EFFECT_INCREASE_POWER_WITH_MORE_HP (237) | `Basic_ScoreMoveEffect → Basic_CheckNonStandardDamageOrChargeTurn`<br>`Expert_Main → Expert_WringOut`<br>`CheckHP_Target → CheckHP_Target_TryScoreMinus2`<br>`CheckHP_Target_31To70Percent → CheckHP_Target_TryScoreMinus2` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` | now damage-scored |
| 463 | Magma Storm | BATTLE_EFFECT_BIND_HIT (42) | `Expert_Main → Expert_BindingMove` | BATTLE_EFFECT_WHIRLPOOL (261) | `SetupFirstTurn_Main` |  |
| 468 | 468 | BATTLE_EFFECT_HIT (0) | none | BATTLE_EFFECT_LOWER_SP_DEF_HIT (72) | none |  |

### Power, type, class, accuracy, PP and priority

325 moves differ in at least one of these fields: power 157, type 34, class 27, accuracy 125, PP 117, priority 30. A blank cell is unchanged.

| ID | Move | Power | Type | Class | Accuracy | PP | Priority | Damage scoring |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | DoubleSlap | 15 → 30 |  |  | 85 → 90 |  |  |  |
| 4 | Water Ball (vanilla Comet Punch) | 18 → 100 | TYPE_NORMAL → TYPE_WATER | Physical → Special | 85 → 100 |  |  |  |
| 7 | Fire Punch | 75 → 95 |  |  |  |  |  |  |
| 8 | Ice Punch | 75 → 95 |  |  |  |  |  |  |
| 9 | ThunderPunch | 75 → 95 |  |  |  |  |  |  |
| 11 | ViceGrip | 55 → 90 | TYPE_NORMAL → TYPE_WATER |  |  |  |  |  |
| 12 | Guillotine |  |  |  |  | 5 → 8 |  |  |
| 14 | Swords Dance |  |  |  |  | 30 → 2 |  |  |
| 15 | Cut |  |  |  | 95 → 100 |  |  |  |
| 20 | Mystical Fire (vanilla Bind) | 15 → 75 | TYPE_NORMAL → TYPE_FIRE | Physical → Special | 75 → 0 |  |  |  |
| 21 | Slam | 80 → 120 |  |  | 75 → 100 | 20 → 8 |  |  |
| 23 | Stomp | 65 → 90 | TYPE_NORMAL → TYPE_GROUND |  |  |  |  |  |
| 25 | Mega Kick | 120 → 140 |  |  | 75 → 90 | 5 → 8 |  |  |
| 26 | Jump Kick | 85 → 120 |  |  | 95 → 90 |  |  |  |
| 27 | Rolling Kick |  |  |  | 85 → 100 |  |  |  |
| 28 | Sand-Attack |  |  |  |  | 15 → 5 |  |  |
| 30 | Fire Ball (vanilla Horn Attack) | 65 → 100 | TYPE_NORMAL → TYPE_FIRE | Physical → Special |  |  |  |  |
| 31 | Fury Attack |  |  |  | 85 → 100 |  |  |  |
| 33 | Tackle |  |  |  | 95 → 100 |  |  |  |
| 34 | Body Slam | 85 → 90 |  |  |  |  |  |  |
| 35 | Wrap |  |  |  | 85 → 100 |  |  |  |
| 36 | Take Down |  |  |  | 85 → 100 |  |  | no longer damage-scored |
| 37 | Thrash | 90 → 120 |  |  |  |  |  |  |
| 38 | Double-Edge | 120 → 140 |  |  |  | 15 → 8 |  |  |
| 39 | Tail Whip |  |  |  |  | 30 → 1 |  |  |
| 40 | Poison Sting | 15 → 40 |  |  |  |  |  |  |
| 41 | Twineedle | 25 → 50 |  |  |  |  |  |  |
| 42 | Pin Missile | 14 → 25 |  |  | 85 → 100 | 20 → 15 |  |  |
| 47 | Sing |  |  |  | 55 → 70 | 15 → 8 |  |  |
| 48 | Supersonic |  |  |  | 55 → 70 |  |  |  |
| 49 | SonicBoom |  |  |  | 90 → 100 |  |  |  |
| 50 | Disable |  |  |  | 80 → 100 |  |  |  |
| 54 | Mist |  |  |  |  | 30 → 3 |  |  |
| 56 | Hydro Pump |  |  |  | 80 → 85 | 5 → 8 |  |  |
| 62 | Aurora Beam | 65 → 60 |  |  | 100 → 0 |  |  |  |
| 63 | Hyper Beam | 150 → 180 |  |  | 90 → 100 | 5 → 8 |  | now damage-scored |
| 64 | Peck | 35 → 40 |  |  |  |  |  |  |
| 66 | Submission | 80 → 90 |  |  | 80 → 100 | 25 → 8 |  |  |
| 71 | Absorb | 20 → 60 | TYPE_GRASS → TYPE_DARK |  |  |  |  |  |
| 73 | Leech Seed |  |  |  | 90 → 0 |  |  |  |
| 74 | Growth |  |  |  |  | 40 → 5 |  |  |
| 75 | Razor Leaf | 55 → 60 |  |  | 95 → 100 |  |  |  |
| 77 | PoisonPowder |  |  |  | 75 → 100 |  |  |  |
| 78 | Stun Spore |  |  |  | 75 → 90 |  |  |  |
| 80 | Petal Dance | 90 → 100 |  |  |  |  |  |  |
| 81 | String Shot |  |  |  | 95 → 100 |  |  |  |
| 83 | Fire Spin | 15 → 90 |  |  | 70 → 100 |  |  |  |
| 88 | Rock Throw |  |  |  | 90 → 100 |  |  |  |
| 91 | Dig | 80 → 60 |  |  |  |  |  |  |
| 92 | Toxic |  |  |  | 85 → 100 |  |  |  |
| 95 | Hypnosis |  |  |  | 60 → 70 |  |  |  |
| 96 | Meditate |  |  |  |  | 40 → 1 |  |  |
| 97 | Agility |  |  |  |  | 30 → 1 |  |  |
| 99 | Rage | 20 → 70 | TYPE_NORMAL → TYPE_FIGHTING |  |  |  |  |  |
| 100 | Teleport |  |  |  |  |  | 0 → 1 |  |
| 103 | Screech |  |  |  | 85 → 100 | 40 → 5 |  |  |
| 104 | Double Team |  |  |  |  | 15 → 6 |  |  |
| 106 | Harden |  |  |  |  | 30 → 5 |  |  |
| 107 | Minimize |  |  |  |  | 20 → 3 |  |  |
| 108 | SmokeScreen |  |  |  |  | 20 → 5 |  |  |
| 110 | Withdraw |  |  |  |  | 40 → 5 |  |  |
| 111 | Rock Ball (vanilla Defense Curl) | 0 → 100 | TYPE_NORMAL → TYPE_ROCK | Status → Special | 0 → 100 | 40 → 15 |  | now damage-scored |
| 112 | Barrier |  |  |  |  | 30 → 5 |  |  |
| 113 | Light Screen |  |  |  |  | 30 → 2 |  |  |
| 115 | Reflect |  |  |  |  | 20 → 2 |  |  |
| 116 | Focus Energy |  |  |  |  | 30 → 5 |  |  |
| 117 | Bide |  | TYPE_NORMAL → TYPE_DARK |  |  |  | 1 → -1 |  |
| 118 | Metronome |  |  |  |  | 10 → 40 |  |  |
| 121 | Egg Bomb |  | TYPE_NORMAL → TYPE_GRASS |  | 75 → 100 |  |  |  |
| 122 | Lick | 20 → 80 |  |  |  | 30 → 15 |  |  |
| 123 | Smog | 20 → 60 |  |  | 70 → 100 |  |  |  |
| 124 | Sludge | 65 → 70 |  |  |  |  |  |  |
| 125 | Bone Club |  | TYPE_GROUND → TYPE_ROCK |  | 85 → 100 |  |  |  |
| 128 | Clamp | 35 → 120 |  |  |  |  |  |  |
| 130 | Solar-Beam (vanilla Skull Bash) | 100 → 120 | TYPE_NORMAL → TYPE_GRASS | Physical → Special |  |  |  | now damage-scored |
| 131 | Hail Ball (vanilla Spike Cannon) | 20 → 100 | TYPE_NORMAL → TYPE_ICE | Physical → Special |  | 15 → 10 |  |  |
| 132 | Constrict | 10 → 255 | TYPE_NORMAL → TYPE_PSYCHIC | Physical → Special |  | 35 → 15 | 0 → -1 |  |
| 133 | Amnesia |  |  |  |  | 20 → 3 |  |  |
| 134 | Kinesis |  |  |  | 80 → 100 |  |  |  |
| 135 | Softboiled |  |  |  |  | 10 → 25 |  |  |
| 136 | Hi Jump Kick | 100 → 150 |  |  |  |  |  |  |
| 137 | Glare |  | TYPE_NORMAL → TYPE_DARK |  | 75 → 100 |  |  |  |
| 139 | Poison Gas |  |  |  | 55 → 85 |  |  |  |
| 140 | Hurricane (vanilla Barrage) | 15 → 120 | TYPE_NORMAL → TYPE_FLYING | Physical → Special | 85 → 70 | 20 → 8 |  |  |
| 141 | Leech Life | 20 → 80 |  |  |  |  |  |  |
| 142 | Lovely Kiss |  |  |  | 75 → 90 |  |  |  |
| 143 | Sky Attack | 140 → 120 |  |  | 90 → 100 |  |  | now damage-scored |
| 144 | Transform |  |  |  |  |  | 0 → 1 |  |
| 145 | Bubble | 20 → 40 |  |  |  |  |  |  |
| 146 | Dizzy Punch | 70 → 100 |  |  |  |  |  |  |
| 148 | Flash |  |  |  |  | 20 → 5 |  |  |
| 149 | Triple Axel (vanilla Psywave) | 1 → 20 | TYPE_PSYCHIC → TYPE_ICE | Special → Physical | 80 → 95 |  |  |  |
| 150 | HP Water (vanilla Splash) | 0 → 70 | TYPE_NORMAL → TYPE_WATER | Status → Special | 0 → 100 | 40 → 20 |  | now damage-scored |
| 151 | Acid Armor |  |  |  |  | 40 → 1 |  |  |
| 152 | Crabhammer | 90 → 120 |  |  | 85 → 100 |  |  |  |
| 154 | Fury Swipes | 18 → 30 |  |  | 80 → 90 |  |  |  |
| 155 | Bonemerang | 50 → 60 | TYPE_GROUND → TYPE_ROCK |  | 90 → 100 |  |  |  |
| 156 | Rest |  |  |  |  | 10 → 3 |  |  |
| 157 | Rock Slide |  |  |  | 90 → 100 |  |  |  |
| 158 | Hyper Fang | 80 → 95 |  |  | 90 → 100 |  |  |  |
| 159 | Sharpen |  |  |  |  | 30 → 3 |  |  |
| 160 | HP Ice (vanilla Conversion) | 0 → 70 | TYPE_NORMAL → TYPE_ICE | Status → Special | 0 → 100 |  |  | now damage-scored |
| 161 | Tri Attack | 80 → 95 |  |  |  |  |  |  |
| 162 | Super Fang |  | TYPE_NORMAL → TYPE_DARK |  | 90 → 100 |  |  |  |
| 164 | Substitute |  |  |  |  | 10 → 3 |  |  |
| 167 | Triple Kick | 10 → 30 |  |  | 90 → 95 |  |  |  |
| 169 | Spider Web |  |  |  |  |  | 0 → 1 |  |
| 171 | HP Ghost (vanilla Nightmare) | 0 → 70 |  | Status → Special |  |  |  | now damage-scored |
| 172 | Flame Wheel | 60 → 70 |  |  |  |  |  |  |
| 173 | Snore | 40 → 80 |  |  |  |  |  |  |
| 174 | Curse |  |  |  |  | 10 → 3 |  |  |
| 177 | Aeroblast | 100 → 120 |  |  | 95 → 100 |  |  |  |
| 178 | Cotton Spore |  |  |  | 85 → 100 |  |  |  |
| 180 | Spite |  |  |  |  | 10 → 3 |  |  |
| 183 | Mach Punch |  |  |  |  | 30 → 15 |  |  |
| 184 | Scary Face |  |  |  | 90 → 100 |  |  |  |
| 186 | Sweet Kiss |  |  |  | 75 → 100 |  |  |  |
| 187 | Belly Drum |  |  |  |  | 10 → 1 |  |  |
| 188 | Sludge Bomb | 90 → 95 |  |  |  |  |  |  |
| 190 | Octazooka | 65 → 95 |  |  | 85 → 100 |  |  |  |
| 191 | Spikes |  |  |  |  |  | 0 → 1 |  |
| 193 | Foresight |  |  |  |  | 40 → 5 |  |  |
| 197 | Detect |  |  |  |  | 5 → 10 |  |  |
| 198 | Bone Rush |  |  |  | 80 → 100 |  |  |  |
| 200 | Outrage | 120 → 140 |  |  |  |  |  |  |
| 201 | Sandstorm |  |  |  |  | 10 → 1 |  |  |
| 202 | Giga Drain | 60 → 75 |  |  |  | 10 → 15 |  |  |
| 204 | Charm |  |  |  |  | 20 → 3 |  |  |
| 205 | Rollout | 30 → 40 |  |  | 90 → 100 | 20 → 5 | 0 → 1 |  |
| 207 | Swagger |  |  |  | 90 → 100 |  |  |  |
| 209 | Wild Charge (vanilla Spark) | 65 → 120 |  |  |  |  |  |  |
| 210 | Fury Cutter | 10 → 20 |  |  |  |  |  |  |
| 211 | Steel Wing | 70 → 80 |  |  | 90 → 100 |  |  |  |
| 212 | Mean Look |  |  |  |  |  | 0 → 1 |  |
| 214 | Sleep Talk |  |  |  |  | 10 → 20 | 0 → 1 |  |
| 215 | Heal Bell |  |  |  |  | 5 → 1 |  |  |
| 216 | Return | 1 → 121 |  |  |  |  |  |  |
| 217 | Present |  |  |  | 90 → 100 |  |  |  |
| 218 | Frustration | 1 → 121 |  |  |  |  |  |  |
| 219 | Safeguard |  |  |  |  | 25 → 5 |  |  |
| 221 | Sacred Fire | 100 → 120 |  |  | 95 → 100 |  |  |  |
| 222 | Bulldoze (vanilla Magnitude) | 1 → 60 |  |  |  |  |  | now damage-scored |
| 223 | DynamicPunch | 100 → 120 |  |  |  |  |  |  |
| 225 | DragonBreath | 60 → 70 |  |  |  |  |  |  |
| 226 | Baton Pass |  |  |  |  |  | 0 → 1 |  |
| 227 | Encore |  |  |  |  | 5 → 3 |  |  |
| 228 | Pursuit | 40 → 70 |  |  |  | 20 → 15 |  |  |
| 229 | HP Fire (vanilla Rapid Spin) | 20 → 70 | TYPE_NORMAL → TYPE_FIRE | Physical → Special |  | 40 → 15 |  |  |
| 230 | Sweet Scent |  |  |  |  | 20 → 2 |  |  |
| 231 | Iron Tail | 100 → 120 |  |  | 75 → 90 |  |  |  |
| 232 | Metal Claw |  |  |  | 95 → 100 |  |  |  |
| 233 | Vital Throw | 70 → 90 |  |  |  |  |  |  |
| 238 | Cross Chop |  |  |  | 80 → 85 |  |  |  |
| 239 | Twister | 40 → 90 |  |  |  | 20 → 15 |  |  |
| 240 | Rain Dance |  |  |  |  | 5 → 1 |  |  |
| 241 | Sunny Day |  |  |  |  | 5 → 1 |  |  |
| 242 | Crunch | 80 → 95 |  |  |  |  |  |  |
| 245 | ExtremeSpeed | 80 → 100 |  |  |  | 5 → 8 | 1 → 2 |  |
| 246 | AncientPower | 60 → 80 |  |  |  | 5 → 10 |  |  |
| 247 | Shadow Ball | 80 → 90 |  |  |  |  |  |  |
| 248 | Future Sight | 80 → 120 |  |  | 90 → 100 |  |  |  |
| 250 | Whirlpool | 15 → 90 |  |  | 70 → 100 |  |  |  |
| 251 | Beat Up | 10 → 30 |  |  |  |  |  |  |
| 252 | Fake Out |  |  |  |  | 10 → 5 | 1 → 3 |  |
| 254 | Stockpile |  |  |  |  | 20 → 10 |  |  |
| 255 | HP Rock (vanilla Spit Up) | 1 → 70 | TYPE_NORMAL → TYPE_ROCK |  |  | 10 → 15 |  | now damage-scored |
| 256 | Swallow | 0 → 90 | TYPE_NORMAL → TYPE_POISON | Status → Physical | 0 → 100 |  |  | now damage-scored |
| 257 | Heat Wave |  |  |  | 90 → 100 |  |  |  |
| 258 | Hail |  |  |  |  | 10 → 1 |  |  |
| 261 | Will-O-Wisp |  |  |  | 75 → 85 |  |  |  |
| 262 | Memento | 0 → 255 |  | Status → Special |  |  |  |  |
| 263 | Facade | 70 → 80 |  |  |  |  |  |  |
| 265 | SmellingSalt | 60 → 90 |  |  |  |  |  |  |
| 268 | Charge |  |  |  |  | 20 → 1 |  |  |
| 269 | HP Dark (vanilla Taunt) | 0 → 70 |  | Status → Special |  | 20 → 15 |  | now damage-scored |
| 271 | HP Psychic (vanilla Trick) | 0 → 70 |  | Status → Special |  | 10 → 15 |  | now damage-scored |
| 274 | Assist |  |  |  |  | 20 → 35 |  |  |
| 275 | Ingrain |  |  |  |  | 20 → 1 |  |  |
| 276 | Superpower | 120 → 140 |  |  |  |  |  | now damage-scored |
| 278 | Recycle |  |  |  |  | 10 → 15 |  |  |
| 279 | Revenge |  |  |  |  |  | -4 → 0 |  |
| 281 | Yawn |  |  |  | 0 → 70 |  |  |  |
| 282 | Knock Off | 20 → 80 |  |  |  |  |  |  |
| 283 | Endeavor |  | TYPE_NORMAL → TYPE_MYSTERY |  |  |  |  |  |
| 285 | Skill Swap |  |  |  |  | 10 → 2 |  |  |
| 287 | Refresh |  |  |  |  | 20 → 10 |  |  |
| 289 | Drill Run (vanilla Snatch) | 0 → 80 | TYPE_DARK → TYPE_GROUND | Status → Physical | 0 → 100 |  | 4 → 0 | now damage-scored |
| 290 | Secret Power | 70 → 85 |  |  |  |  |  |  |
| 292 | HP Fighting (vanilla Arm Thrust) | 15 → 70 |  | Physical → Special |  | 20 → 15 |  |  |
| 294 | Tail Glow |  |  |  |  |  | 0 → 2 |  |
| 295 | Luster Purge | 70 → 100 |  |  |  |  |  |  |
| 296 | Mist Ball | 70 → 100 |  |  |  |  |  |  |
| 297 | FeatherDance |  |  |  |  | 15 → 3 |  |  |
| 299 | Blaze Kick | 85 → 100 |  |  | 90 → 100 |  |  |  |
| 300 | HP Ground (vanilla Mud Sport) | 0 → 70 |  | Status → Special | 0 → 100 |  |  | now damage-scored |
| 301 | Ice Ball | 30 → 120 |  |  | 90 → 70 | 20 → 8 |  |  |
| 302 | Needle Arm | 60 → 80 |  |  |  |  |  |  |
| 304 | Hyper Voice | 90 → 110 |  |  |  |  |  |  |
| 305 | Poison Fang | 50 → 90 |  |  |  |  |  |  |
| 306 | Crush Claw | 75 → 120 |  |  |  |  |  |  |
| 307 | Blast Burn |  |  |  | 90 → 95 |  |  | now damage-scored |
| 308 | Hydro Cannon |  |  |  | 90 → 95 |  |  | now damage-scored |
| 309 | Meteor Mash |  |  |  | 85 → 100 |  |  |  |
| 310 | Astonish | 30 → 40 |  |  |  |  |  |  |
| 312 | Aromatherapy |  |  |  |  | 5 → 1 |  |  |
| 313 | Fake Tears |  |  |  |  | 20 → 3 |  |  |
| 314 | Air Cutter | 55 → 60 |  |  | 95 → 100 |  |  |  |
| 315 | Overheat | 140 → 120 |  |  | 90 → 100 |  |  |  |
| 317 | Rock Tomb | 50 → 70 |  |  | 80 → 100 |  |  |  |
| 318 | Silver Wind | 60 → 80 |  |  | 100 → 0 |  |  |  |
| 319 | Metal Sound |  |  |  | 85 → 100 | 40 → 3 |  |  |
| 320 | GrassWhistle |  |  |  | 55 → 70 |  |  |  |
| 321 | Tickle |  |  |  |  | 20 → 6 |  |  |
| 322 | Cosmic Power |  |  |  |  | 20 → 6 |  |  |
| 324 | Signal Beam | 75 → 95 |  |  |  |  |  |  |
| 325 | Shadow Punch | 60 → 95 |  |  |  |  |  |  |
| 326 | Extrasensory | 80 → 90 |  |  |  |  |  |  |
| 327 | Sky Uppercut | 85 → 95 |  |  | 90 → 100 |  |  |  |
| 328 | Sand Tomb | 15 → 90 |  |  | 70 → 100 |  |  |  |
| 329 | Sheer Cold | 1 → 70 |  |  | 30 → 50 |  |  | now damage-scored |
| 330 | Muddy Water |  |  |  | 85 → 100 |  |  |  |
| 331 | Bullet Seed | 10 → 25 |  |  |  |  |  |  |
| 333 | Icicle Spear | 10 → 25 |  |  |  |  |  |  |
| 334 | Iron Defense |  |  |  |  | 15 → 3 |  |  |
| 335 | Block |  |  |  |  |  | 0 → 7 |  |
| 336 | Howl |  |  |  |  | 40 → 3 |  |  |
| 337 | Dragon Claw | 80 → 90 |  |  |  |  |  |  |
| 338 | Frenzy Plant |  |  |  | 90 → 95 |  |  | now damage-scored |
| 339 | Bulk Up |  |  |  |  | 20 → 3 |  |  |
| 340 | Bounce |  |  |  | 85 → 100 |  |  |  |
| 341 | Mud Shot |  |  |  | 95 → 100 |  |  |  |
| 342 | Poison Tail | 50 → 120 |  |  |  | 25 → 5 |  |  |
| 343 | HP Grass (vanilla Covet) | 40 → 70 | TYPE_NORMAL → TYPE_GRASS | Physical → Special |  | 40 → 15 |  |  |
| 344 | Volt Tackle | 120 → 150 |  |  |  | 15 → 5 |  |  |
| 345 | Magical Leaf |  |  |  |  | 20 → 15 |  |  |
| 346 | Scald (vanilla Water Sport) | 0 → 80 |  | Status → Special | 0 → 100 |  |  | now damage-scored |
| 347 | Calm Mind |  |  |  |  | 20 → 3 |  |  |
| 348 | Leaf Blade | 90 → 95 |  |  |  |  |  |  |
| 349 | Dragon Dance |  |  |  |  | 20 → 1 |  |  |
| 350 | Rock Blast |  |  |  | 80 → 100 | 10 → 8 |  |  |
| 351 | Shock Wave |  |  |  |  | 20 → 15 |  |  |
| 352 | Water Pulse |  |  |  | 100 → 0 |  |  |  |
| 353 | Doom Desire | 120 → 250 |  |  | 85 → 100 |  |  |  |
| 354 | Psycho Boost |  |  |  | 90 → 100 |  |  |  |
| 355 | Roost |  |  |  |  | 10 → 8 |  |  |
| 356 | Gravity |  |  |  |  |  | 0 → 1 |  |
| 359 | Hammer Arm |  |  |  | 90 → 100 |  |  |  |
| 360 | Gyro Ball |  |  |  |  | 5 → 8 |  |  |
| 361 | HP Electric (vanilla Healing Wish) | 0 → 70 | TYPE_PSYCHIC → TYPE_ELECTRIC | Status → Special | 0 → 100 | 10 → 15 |  | now damage-scored |
| 363 | Natural Gift |  |  |  |  | 15 → 1 |  |  |
| 364 | Feint | 50 → 80 |  |  |  |  |  |  |
| 365 | Pluck | 60 → 50 |  |  |  | 20 → 5 |  |  |
| 366 | Tailwind |  |  |  |  |  | 0 → 5 |  |
| 368 | Metal Burst |  |  |  |  |  | 0 → -2 |  |
| 369 | U-turn | 70 → 80 |  |  |  |  |  |  |
| 371 | Payback | 50 → 60 |  |  |  |  |  |  |
| 372 | Assurance | 50 → 70 |  |  |  |  |  |  |
| 375 | Psycho Shift |  |  |  | 90 → 100 |  |  |  |
| 376 | Trump Card |  |  |  |  | 5 → 1 |  |  |
| 377 | Aqua Cutter (vanilla Heal Block) | 0 → 70 | TYPE_PSYCHIC → TYPE_WATER | Status → Physical |  |  |  | now damage-scored |
| 378 | Wring Out | 1 → 75 |  |  |  |  |  | now damage-scored |
| 381 | Lucky Chant |  |  |  |  |  | 0 → 2 |  |
| 382 | Me First |  |  |  |  |  | 0 → 1 |  |
| 383 | Copycat |  |  |  |  |  | 0 → 1 |  |
| 384 | Power Swap |  |  |  |  | 10 → 3 |  |  |
| 385 | Guard Swap |  |  |  |  | 10 → 3 |  |  |
| 389 | Sucker Punch |  |  |  |  |  | 1 → 2 | now damage-scored |
| 390 | Toxic Spikes |  |  |  |  |  | 0 → 1 |  |
| 391 | Heart Swap | 0 → 95 | TYPE_PSYCHIC → TYPE_WATER | Status → Special |  |  |  | now damage-scored |
| 393 | Magnet Rise |  |  |  |  |  | 0 → 1 |  |
| 394 | Flare Blitz |  |  |  |  | 15 → 8 |  |  |
| 395 | Force Palm | 60 → 85 |  |  |  |  |  |  |
| 396 | Aura Sphere |  |  |  |  | 20 → 10 |  |  |
| 397 | Rock Polish |  |  |  |  | 20 → 1 |  |  |
| 401 | Aqua Tail | 90 → 120 |  |  | 90 → 85 |  |  |  |
| 403 | Air Slash |  |  |  | 95 → 100 |  |  |  |
| 406 | Dragon Pulse |  |  |  | 100 → 0 |  |  |  |
| 407 | Dragon Rush |  |  |  | 75 → 100 |  |  |  |
| 408 | Power Gem | 70 → 90 |  |  |  |  |  |  |
| 409 | Drain Punch | 60 → 75 |  |  |  |  |  |  |
| 411 | Focus Blast |  |  |  | 70 → 85 |  |  |  |
| 415 | HP Flying (vanilla Switcheroo) | 0 → 70 | TYPE_DARK → TYPE_FLYING | Status → Special |  | 10 → 15 |  | now damage-scored |
| 416 | Giga Impact | 150 → 180 |  |  | 90 → 100 |  |  | now damage-scored |
| 417 | Nasty Plot |  | TYPE_DARK → TYPE_MYSTERY |  |  | 20 → 1 |  |  |
| 418 | Bullet Punch |  |  |  |  | 30 → 10 |  |  |
| 419 | Avalanche | 60 → 100 |  |  |  |  | -4 → 0 |  |
| 420 | Ice Shard |  |  |  |  | 30 → 10 |  |  |
| 421 | Shadow Claw | 70 → 25 |  |  |  |  |  |  |
| 422 | Thunder Fang | 65 → 90 |  |  | 95 → 100 |  |  |  |
| 423 | Ice Fang | 65 → 90 |  |  | 95 → 100 |  |  |  |
| 424 | Fire Fang | 65 → 90 |  |  | 95 → 100 |  |  |  |
| 425 | Shadow Sneak |  |  |  |  | 30 → 10 |  |  |
| 426 | Mud Bomb |  |  |  | 85 → 100 |  |  |  |
| 427 | Psycho Cut | 70 → 90 |  |  |  |  |  |  |
| 428 | Zen Headbutt |  |  |  | 90 → 100 |  |  |  |
| 429 | Mirror Shot | 65 → 120 |  |  | 85 → 100 |  |  |  |
| 431 | Rock Climb |  | TYPE_NORMAL → TYPE_ROCK |  | 85 → 100 |  |  |  |
| 432 | Defog |  |  |  |  | 15 → 1 |  |  |
| 433 | Trick Room |  |  |  |  | 5 → 1 | -7 → 7 |  |
| 434 | Draco Meteor |  |  |  | 90 → 100 |  |  |  |
| 437 | Leaf Storm | 140 → 120 |  |  | 90 → 85 |  |  |  |
| 439 | Rock Wrecker | 150 → 30 |  |  |  | 5 → 8 |  | now damage-scored |
| 440 | Cross Poison | 70 → 95 |  |  |  |  |  |  |
| 441 | Gunk Shot |  |  |  | 70 → 100 | 5 → 8 |  |  |
| 443 | Magnet Bomb | 60 → 100 |  | Physical → Special |  |  |  |  |
| 444 | Stone Edge | 100 → 120 |  |  |  |  |  |  |
| 445 | Captivate |  |  |  |  | 20 → 3 |  |  |
| 446 | Stealth Rock |  |  |  |  |  | 0 → 1 |  |
| 448 | Chatter | 60 → 120 |  |  |  | 20 → 5 |  |  |
| 449 | Judgment | 100 → 120 |  |  |  |  |  |  |
| 451 | Charge Beam |  |  |  | 90 → 100 |  |  |  |
| 453 | Aqua Jet |  |  |  |  | 20 → 5 |  |  |
| 454 | Attack Order | 90 → 120 |  |  |  |  |  |  |
| 455 | Defend Order |  |  |  |  |  | 0 → 1 |  |
| 457 | Head Smash |  |  |  | 80 → 100 |  |  |  |
| 458 | Double Hit | 35 → 60 |  |  | 90 → 100 |  |  |  |
| 459 | Roar of Time |  |  |  | 90 → 100 |  |  | now damage-scored |
| 460 | Spacial Rend | 100 → 120 |  |  | 95 → 100 |  |  |  |
| 461 | Lunar Dance |  |  |  |  |  | 0 → 1 |  |
| 462 | Crush Grip | 1 → 150 |  |  |  |  |  | now damage-scored |
| 463 | Magma Storm |  |  |  | 70 → 100 |  |  |  |
| 464 | Dark Void |  |  |  | 80 → 90 | 10 → 5 |  |  |
| 465 | Seed Flare |  |  |  | 85 → 100 |  |  |  |
| 466 | Ominous Wind | 60 → 80 |  |  | 100 → 0 |  |  |  |
| 468 | 468 | 100 → 60 | TYPE_NORMAL → TYPE_FIRE |  | 100 → 0 |  |  |  |
<!-- /generated:moves -->

## Overlay 16 and the code around it, by function

**Where the battle C lives.** `platinum.us/main.lsf.in` links all of the battle C into one overlay, `Overlay battle` (main.lsf.in:682), which is overlay 16. Its 16 files are battle_main.c, battle_system.c, battle_script.c (the `BtlCmd_*` handlers), battle_controller_player.c, battle_lib.c, battle_io_command.c, battle_display.c and nine display files. The side-effect subscript table is battle_lib.c's: it includes `include/data/move_side_effect_subscripts.h` (battle_lib.c:7501). No battle C sits in another binary. These hold the code around it:

- **Overlay 12** (`battle_anim`, main.lsf.in:627): the battle animations.
- **Overlay 13** (`battle_sub_menus`, main.lsf.in:655): the battle bag and party menus.
- **Overlay 14** (`trainer_ai`, main.lsf.in:670): the AI.
- **The ARM9 binary:** the code the battle calls for Pokémon data, moves (move_table.c), items (item.c) and the RNG (math_util.c). It also holds trainer_data.c, which builds each trainer's party before the battle.

**How the functions are found.**

- **Three command tables give exact entry points:** `sBattleCommands` (battle_script.c:346, its 223 entries in the `BTLCMD_*` order of `include/data/scripts/btlcmd.h`), `sBattleControlCommands` (battle_controller_player.c:130, 45 steps) and the battle IO commands' `sBattleCommands` (battle_io_command.c:159, 67 commands). Each is found as the one run of exactly that many Thumb pointers into the code.
- **Every other function starts at a BL target or a function pointer.** MWCC also uses BL as a long branch inside a big function. A target counts as one when nothing else names it, it doesn't open with `push {…, lr}`, and every BL to it lies inside the function and out of a B's ±2 KB reach.
- **The code ends** where the last function's literal pool ends: 0x3311C in vanilla, 0x33138 in the hack.

**How the functions are named.** The compiler keeps source order, so the functions between two named entry points are the source's functions between those two names.

- **From a table:** exact.
- **From a call:** a named function's BLs into the code pair up, in order, with its C body's calls to the code's functions, when the counts agree. A pairing must agree with every other one and keep source order.
- **By count:** between two named functions, when the number of entry points equals the number of source functions.
- **Address names** (`ov16_0223B384`, pret's style) are left where neither works.

The ARM9 is named the same way, span by span. pret names a file `unk_XXXXXXXX.c` after its first function's address, so the files from one such file to the next fill exactly the code between the two addresses.

**How the functions are compared.** The two layouts pair up in order. A body of the same size is compared halfword by halfword. A difference counts as a relocation when it is one of these:

- a BL that reaches the same offset of the paired function, or the same address outside the overlay;
- a 4-aligned word that points at the paired function, or at data that the alignment carries over.

Anything else, or a different size, makes the function changed. The region-by-region alignment further down carries code by its own halfword match. Here code is carried by function pairing, so a changed immediate can't pass as a relocation.

### The changes, read

The function names and boundaries come from the tables and the source, as the generated block says. What each change does is read from the bytes, so the readings are inferred. In-game checks for them are in `docs/ai-spot-checks.md`, items 1–3, 8a and 8b.

| Where | What changed | Reading | Matters to |
| --- | --- | --- | --- |
| `BattleControllerPlayer_CheckObedience` (battle_controller_player.c:2109) | 0x13090: `cmp r0, #8` becomes `cmp r0, #0` after the badge count | The "8 badges: always obey" test always passes, so every Pokémon obeys. | The engine, which already behaves so: Showdown has no disobedience. |
| `BattleControllerPlayer_CheckMoveHitAccuracy` (battle_controller_player.c:2865) | 4 bytes at 0x13EF8: `beq` and `cmp r0, #0x8D` after `cmp r0, #0x98` | Effect 141 (Hurricane) falls to 50% accuracy in sun, as Thunder's effect 152 does (:2915). | The engine, which has the rule (`src/engine/mod/accuracy.ts`). |
| `BattleControllerPlayer_CheckMoveHitOverrides` (battle_controller_player.c:3001) | the same 4 bytes at 0x14216 | Effect 141 never misses in rain (:3025). | The engine, as above. |
| `BattleSystem_TriggerEffectOnSwitch` (battle_lib.c:3649) | 20 bytes: the field-weather switch (:3664) covers weathers 0 to 18 instead of 0 to 15. There are 3 more jump-table entries, one more case and one more literal; the function's other branches and tables are laid out again around them. | Map weather 12 (`OVERWORLD_WEATHER_SPIRITS`) runs subscript 297, which plays Gravity's animation and starts Gravity. Map weathers 17 and 18 (`OVERWORLD_WEATHER_UNUSED_17` and `_18`) run the harsh-sun and Trick Room subscripts (294 and 295), which only weathers 1001 and 1002 ran before. With subscripts 238 and 251, which re-arm Gravity and Trick Room, these effects last the whole battle. | The engine, and the AI through `fieldConditionsMask` (items 2 and 23). |
| Overlay 16's data | 4 zero bytes before the data at 0x359E0 | Alignment padding: that data starts on a 32-byte boundary in both ROMs. | Nothing. |
| ARM9 `TrainerData_BuildParty` (trainer_data.c:176) | rewritten, 1,033 bytes | See below. | The engine (natures, abilities and genders of trainer Pokémon) and the AI, which reads them. |
| ARM9 `Trainer_Encounter` (trainer_data.c:25) | `mov r2, #8` becomes `#12` | The trainer's name is copied with a length of 12 characters, not `TRAINER_NAME_LEN + 1` (8). | Nothing in battle. |
| ARM9 `Options_Init` (game_options.c:25) | the text speed is 2, not 1, and bit 6 is set, not cleared | A new game starts with fast text and the Set battle style (`battleStyle`, include/game_options.h:11). | Nothing: a save keeps its own options. The planner already assumes Set. |
| ARM9 map header accessors (map_header.c:8 on) | `MapHeader_IDBoundsCheck` and the getters after it are rewritten | They read the map headers from a table the hack loads, not from the ARM9. The table holds each map's weather, which starts the field effects above. | The field. The map weather ties to the engine's field notes. |
| ARM9, the rest | scripts, encounter effects, the party and summary screens, the boot code, field and item-icon data | Field and UI. The boot code loads the hack's own code to 0x023C8000, and only the ARM9 calls it. | Nothing in battle. |

**What the AI reads of these** (cross-checked against `docs/ai-reads.md`). Overlay 14, the AI's own code, reaches none of the four changed functions (the generated block below):

- **Three are not read at all.** No battle_controller_player.c (BCP) line that `docs/ai-reads.md` cites falls inside `CheckObedience`, `CheckMoveHitAccuracy` or `CheckMoveHitOverrides` (BCP:2109–2234, 2865–3000 and 3001–3058), and none of the three is named there.
- **The port reproduces the fourth, `TriggerEffectOnSwitch` (BL:3649–4176), for its first view.** `initialView` follows its steps, which `docs/ai-reads.md` ("The first decision") cites from BL:3649 on. Those are the vanilla function's steps, which the hack keeps; the hack's change in it is the map-weather cases below.

It does read values that two of the changes set:

- **The field conditions `TriggerEffectOnSwitch` now starts:** Gravity, harsh sun and Trick Room. They are read through `LoadCurrentWeather` (row 46), `IfFieldConditionsMask` (row 86) and the damage estimate. They reach the AI only through the trainer's field note. `initialView` applies the note's sun, Trick Room and Gravity. The engine applies the note itself, so the engine path's view shows them too (spot check 23).
- **The trainer Pokémon `TrainerData_BuildParty` builds:** their abilities, natures (through their stats) and held items are the real data the AI reads.

**The hack's `TrainerData_BuildParty`: inferred** (spot checks 8a and 8b). This is my reading of its disassembly (ARM9 0x020793B8 to 0x02079570, plus two helpers after it). Only the function's name and boundaries come from the layout. Confirm the reading in game before the engine relies on it.

- **One loop for all four party formats.** Each entry is byte 0 (the IV scale), byte 1 (an override), the level (u16) and the species and form (u16). The held item follows if the format has one (format bit 1), then four moves if the format has them (format bit 0), and the ball seal last. `src/rom/trainers.ts` already decodes this layout.
- **The PID looks like vanilla's:** `pid = (rnd << 8) + genderMod` (trainer_data.c:206–213). `genderMod` is 120 for a female trainer class and 136 otherwise. `rnd` is the LCRNG seeded with IV scale + level + species + trainer ID, then stepped once per trainer class.
- **An override appears to change `genderMod` first** (helper at 0x020795A0). Its low nibble is the gender and its high nibble the ability.
  - Gender 1 sets it to the species' gender ratio + 2, and gender 2 to the ratio − 2 (`SpeciesData_GetFormValue`, parameter 18).
  - Then ability 1 clears bit 0 and ability 2 sets it. With a gender override this works on the new `genderMod`. Without one, the helper never loads `genderMod`: it stores `species & ~1` or `species | 1` into it. That looks like a hack bug, and it is the most useful thing to check in game (spot check 8a).
- **`genderMod` doesn't seem to be reset between entries.** After the first entry with an override, every later entry in that party would use the changed value. If so, that accounts for `src/rom/trainers.ts` marking every entry from the first override on `natureKnown: false`.
- **Friendship** (helper at 0x02079570): it sets 255, then 0 when any of its four reads returns 218 (Frustration's move ID).
  - Only the first read is certain to be move 1 (`MON_DATA_MOVE1`). The field ID is set before the loop and not reloaded after the call, so the other three reads' field IDs are undetermined.
  - This changes nothing known in battle: in this hack, Return and Frustration are plain 121-power hits (effect 0, in the move data above).
- **Then the form, `Pokemon_CalcStats`** (which vanilla doesn't call here) **and `Party_AddPokemon`.**

<!-- generated:handlers -->
_Written by `npx tsx src/ai/diff/cli.ts` from the two ROMs and the decompilation. Do not edit by hand._

### Overlay 16 by function

Overlay 16's code runs from offset 0 to 0x3311C in vanilla and 0x33138 in the hack; its data follows. Both hold 1,145 functions, which pair up in order with the same names. 335 names come from the command tables, 410 from a named caller's calls and 398 by count between named functions; 2 keep an address name. 6 BL targets are long branches inside a function, not function starts.

| Table | Defined at | Vanilla offset | Hack offset | Entries | Entries pointing at the paired function |
| --- | --- | --- | --- | --- | --- |
| `sBattleCommands` (battle script commands) | battle_script.c:346 | 0x335EC | 0x33608 | 223 | all 223 |
| `sBattleControlCommands` (battle controller steps) | battle_controller_player.c:130 | 0x339AC | 0x339C8 | 45 | all 45 |
| `sBattleCommands` (battle IO commands) | battle_io_command.c:159 | 0x33F28 | 0x33F44 | 67 | all 67 |

Of the 1,145 function pairs, 445 are the same byte for byte and 696 differ only by relocations (4,021 BLs and 317 pointers that reach the paired function or the same data). 4 changed:

| Function | Named by | Vanilla | Hack | What differs | Overlay 14 reaches it |
| --- | --- | --- | --- | --- | --- |
| `BattleControllerPlayer_CheckObedience` (battle_controller_player.c:2109) | count | 0x12FFC, 796 bytes | 0x12FFC, 796 bytes | 0x13090 (2 bytes) | no |
| `BattleControllerPlayer_CheckMoveHitAccuracy` (battle_controller_player.c:2865) | call | 0x13DE0, 852 bytes | 0x13DE0, 856 bytes | the size, 852 → 856 bytes | no |
| `BattleControllerPlayer_CheckMoveHitOverrides` (battle_controller_player.c:3001) | call | 0x14134, 492 bytes | 0x14138, 496 bytes | the size, 492 → 496 bytes | no |
| `BattleSystem_TriggerEffectOnSwitch` (battle_lib.c:3649) | count | 0x1B2D4, 3092 bytes | 0x1B2DC, 3112 bytes | the size, 3092 → 3112 bytes | no |

Overlay 14 reaches 48 of overlay 16's functions by BL, directly or through overlay 16's own calls.

#### Overlay regions by function

The alignment finds 4660 changed regions; 4647 are relocations. The others, by the function or data they fall in:

| Vanilla offset | Vanilla bytes | Hack offset | Hack bytes | In |
| --- | --- | --- | --- | --- |
| 0x13090 | 2 | 0x13090 | 2 | `BattleControllerPlayer_CheckObedience` |
| 0x13EF8 | 48 | 0x13EF8 | 52 | `BattleControllerPlayer_CheckMoveHitAccuracy` |
| 0x14216 | 48 | 0x1421A | 52 | `BattleControllerPlayer_CheckMoveHitOverrides` |
| 0x1B2F0 | 260 | 0x1B2F8 | 276 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B586 | 2 | 0x1B59E | 2 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B598 | 4 | 0x1B5B0 | 4 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B5B6 | 4 | 0x1B5CE | 4 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B5C0 | 2 | 0x1B5D8 | 2 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B5CC | 2 | 0x1B5E4 | 2 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B5EA | 30 | 0x1B602 | 2 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B61E | 0 | 0x1B61A | 4 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x1B638 | 0 | 0x1B638 | 28 | `BattleSystem_TriggerEffectOnSwitch` |
| 0x359D0 | 0 | 0x359EC | 4 | data |

Each code region lies in a changed function, and each changed function holds at least one. The function-level comparison carries code by function, not by the alignment, so no other function hides a change behind a relocation. Inside the changed functions, the alignment counts 100 relocations; 96 of them reach outside their function, and every one of those reaches the paired function or data.

### Overlay 16's data

The data runs from 0x3311C to the end: 10,596 bytes in vanilla, 10,600 in the hack. The alignment finds 211 changed regions in it. 210 are pointer relocations (210 pointers that reach the paired function or the same data); the other 1:

| Vanilla offset | Vanilla bytes | Hack offset | Hack bytes | The hack's bytes there | In a command table |
| --- | --- | --- | --- | --- | --- |
| 0x359D0 | 0 | 0x359EC | 4 | 00 00 00 00 | no |

The code's 215 pointers into the data say where the hack's data grew: they move by 28 or 32 bytes. The data at 0x35998 (read by `Indicator_New`) moves by 28; the data at 0x359E0 (read by `BattleScript_CalcPrizeMoney`) moves by 32. Between them the hack has 4 more bytes, all zero, and the later data starts at 0x02270B20 in vanilla and 0x02270B40 in the hack, both multiples of 32.

**Not re-checked:** a data word that kept its vanilla value while the data it points at moved would align as unchanged. The diff doesn't chase such words, because a lone data word can look like a pointer by chance. The command tables are the exception: they are checked entry by entry.

### The side-effect subscript table

`sSideEffectSubscripts` (include/data/move_side_effect_subscripts.h:6, included by battle_lib.c for MapSideEffectToSubscript) maps a move's side-effect pointer to a subscript. Its 145 entries are at 0x33CE4 in vanilla and 0x33D00 in the hack. Every entry is the same in both. The word after it is the same in both, up to relocation, so the hack's table is no longer.

### The other binaries

main.lsf.in links all of the battle C into overlay 16 (main.lsf.in:682). These binaries hold the code around it, or the code it calls:

| Binary | Holds | Result |
| --- | --- | --- |
| Overlay 12 (`battle_anim`) | battle animations | identical |
| Overlay 13 (`battle_sub_menus`) | the battle bag and party menus | 25 changed regions in place; all are BLs or pointers into overlay 16 that reach the paired function |
| Overlay 14 (`trainer_ai`) | the trainer AI | 112 changed regions in place; 111 are BLs or pointers into overlay 16 that reach the paired function; 1 is something else |
| ARM9 | the code every overlay calls: Pokémon data, moves, items, trainers, the RNG | 161 changed regions in place (both binaries are 1,057,784 bytes). 2 follow overlay 16's growth; the other 159 fall in 40 places, below. |

Overlay 14's changed regions are its script change and BLs into overlay 16 (see "Overlay 14 outside the script").

The ARM9's C code is laid out between pret's address-named files (`unk_02012744.c` to `unk_0209C390.c`): 8,052 functions, 6,330 of them named. Overlays 14 and 16 reach 705 of them by BL, directly or through the ARM9's own calls. None of those changed. A changed region after the laid-out C is named by the nearest data address at or before it that a laid-out function loads.

| ARM9 address | Regions | Bytes | In | Overlays 14 and 16 reach it |
| --- | --- | --- | --- | --- |
| 0x02000CB5 | 1 | 3 | code before the laid-out C (main.c to hardware_window.c, which come before `unk_02012744.c`); the hack's BL at 0x02000CB4 calls 0x02101574 | no |
| 0x02027A2E | 2 | 2 | `Options_Init` (game_options.c; named by call) | no |
| 0x0203A024 | 1 | 20 | `MapHeader_IDBoundsCheck` (map_header.c; named by count) | no |
| 0x0203A03E | 2 | 8 | `MapHeader_GetAreaDataArchiveID` (map_header.c; named by count) | no |
| 0x0203A052 | 2 | 8 | `MapHeader_GetPreloadedMapObjectsArchiveID` (map_header.c; named by count) | no |
| 0x0203A066 | 2 | 8 | `MapHeader_GetMapMatrixID` (map_header.c; named by count) | no |
| 0x0203A08E | 2 | 8 | `MapHeader_GetMsgArchiveID` (map_header.c; named by count) | no |
| 0x0203A0A2 | 2 | 8 | `MapHeader_GetScriptsArchiveID` (map_header.c; named by count) | no |
| 0x0203A0B6 | 2 | 8 | `MapHeader_GetInitScriptsArchiveID` (map_header.c; named by count) | no |
| 0x0203A0CA | 2 | 8 | `MapHeader_GetDayMusicID` (map_header.c; named by count) | no |
| 0x0203A0DE | 2 | 8 | `MapHeader_GetNightMusicID` (map_header.c; named by count) | no |
| 0x0203A0F2 | 2 | 8 | `MapHeader_HasWildEncounters` (map_header.c; named by count) | no |
| 0x0203A116 | 2 | 8 | `MapHeader_GetWildEncountersArchiveID` (map_header.c; named by count) | no |
| 0x0203A12A | 2 | 8 | `MapHeader_GetEventsArchiveID` (map_header.c; named by count) | no |
| 0x0203A13E | 2 | 8 | `MapHeader_GetMapLabelTextID` (map_header.c; named by count) | no |
| 0x0203A15A | 2 | 8 | `MapHeader_GetMapLabelWindowID` (map_header.c; named by count) | no |
| 0x0203A17A | 2 | 8 | `MapHeader_GetWeatherType` (map_header.c; named by count) | no |
| 0x0203A18E | 2 | 8 | `MapHeader_GetCameraType` (map_header.c; named by count) | no |
| 0x0203A1A2 | 2 | 8 | `MapHeader_GetBattleBG` (map_header.c; named by count) | no |
| 0x0203A1BE | 2 | 8 | `MapHeader_IsEscapeRopeAllowed` (map_header.c; named by count) | no |
| 0x0203A1DA | 2 | 8 | `MapHeader_IsFlyAllowed` (map_header.c; named by count) | no |
| 0x0203A1F6 | 2 | 8 | `MapHeader_IsBikeAllowed` (map_header.c; named by count) | no |
| 0x0203A212 | 2 | 8 | `MapHeader_GetMapType` (map_header.c; named by count) | no |
| 0x020450F8 | 1 | 2 | `ScrCmd_GetWallpaperFromCustomMessageWords` (scrcmd.c; named by count) | no |
| 0x0204EAE8 | 1 | 60 | `ScrCmd_Dummy088` (scrcmd_underground_inventory.c; named by count) | no |
| 0x02051B89 | 1 | 1 | `EncEffects_GetEffectPair` (enc_effects.c; named by count) | no |
| 0x020791DE | 1 | 1 | `Trainer_Encounter` (trainer_data.c; named by count) | no |
| 0x020793B8 | 2 | 1033 | `TrainerData_BuildParty` (trainer_data.c; named by count) | no |
| 0x02079CEA | 1 | 6 | `PCBoxes_UnlockWallpaper` (pc_boxes.c; named by count) | no |
| 0x02085EC6 | 1 | 4 | `PartyMenuCB_LevelUp` (applications/party_menu/callbacks.c; named by count) | no |
| 0x0208CA34 | 1 | 4 | `HandleInput_Main` (applications/pokemon_summary_screen/main.c; named by count) | no |
| 0x0208D3B2 | 1 | 4 | `SetMonDataFromMon` (applications/pokemon_summary_screen/main.c; named by count) | no |
| 0x020E9871 | 2 | 5 | data from 0x020E97C2, loaded by `TryUnlockFlyLocationByMap`, `CheckFlyLocationUnlocked` | no |
| 0x020EA378 | 91 | 124 | data from 0x020EA378, loaded by `Script_GetHiddenItemRange`, `ScriptManager_SetHiddenItem` | no |
| 0x020EAD54 | 3 | 9 | data from 0x020EAC58, loaded by `ScriptContext_CreateAndStart` | no |
| 0x020EC286 | 1 | 1 | data from 0x020EC20A, loaded by `EncEffects_BGMForPair` | no |
| 0x020EC4C0 | 1 | 3 | data from 0x020EC3E2, loaded by `FieldBGM_GetEyesMeetForTrainer` | no |
| 0x020F0C08 | 4 | 12 | data from 0x020F0BFC, loaded by `Item_MoveForTMHM`, `Item_IsHMMove` | no |
| 0x020F0EF6 | 2 | 6 | data from 0x020F0CCA, loaded by `Item_FileID` | no |
| 0x02101574 | 1 | 25 | bytes after the laid-out C that the hack runs as code; the hack's BL at 0x02000CB4 calls it | no |

`sItemArchiveIDs` (from 0x020F0CC4, loaded by `Item_FileID`; 468 records of 8 bytes): item 70 iconID 51 → 679; item 70 paletteID 75 → 87; item 429 iconID 550 → 656; item 429 paletteID 551 → 657. No dataID changed, so every item reads the same parameters in battle.

Words and BLs that point into 0x023C8000–0x02400000, where the hack's ARM9 loads code of its own, and that only the hack has: a BL in ARM9 to 0x023C82E2; a BL in ARM9 to 0x023C8452; a BL in ARM9 to 0x023C8482; a word 0x023DFF28 at ARM9 0x0204EB20; a word 0x023C85C5 at ARM9 0x020EAD54; a word 0x023C8345 at ARM9 0x020EAEC8; a word 0x023C83DF at ARM9 0x020EB390; a word 0x023C8000 at ARM9 0x02101588. Of these, in overlays 12 to 16: none.
<!-- /generated:handlers -->

## Can pokeplatinum be built here?

**No.** Checked on 2026-11-08 in WSL Ubuntu 24.04 with `command -v` and no sudo:

- `meson`, `ninja`, `wine`, `wine64`, `mwccarm`, `mwasmarm`, `mwldarm`, `arm-none-eabi-gcc` and `arm-none-eabi-objdump`: not found.
- Python's `mesonbuild` module: not found.
- The sparse clone has no `tools/` or `subprojects/` folder, where the Metrowerks toolchain would come from.
- `gcc`, `make` and `python3` are present.

Building would need apt (for wine), so nothing was installed. With no build map, the function names above come from the command tables and the source order, and what each change does is read from the bytes.

## Generated diff

<!-- generated -->
_Written by `npx tsx src/ai/diff/cli.ts` from the two ROMs and the decompilation. Do not edit by hand._

### Script changes by flag

Both scripts start at overlay 14 offset 0x4C84. From flags 0–10 and 29–31, vanilla reaches 3560 instructions and the hack 3560.

#### Basic (bit 0)

| Vanilla label | Vanilla | Hack | Meaning |
| --- | --- | --- | --- |
| `Basic_CheckForImmunity` | `IfLoadedEqualTo ABILITY_LEVITATE, Basic_CheckWaterAbsorption2` | `IfLoadedEqualTo ABILITY_DRY_SKIN, Basic_CheckWaterAbsorption2` | The Dry Skin fix. Vanilla tests Levitate twice (script.s:78), so this branch never runs. In the hack, a Water-type move that the AI damage-scores gets −12 when the AI takes the target's ability to be Dry Skin, as with Water Absorb. A Mold Breaker attacker skips the check. |

#### EvalAttack (bit 1)

No change.

#### Expert (bit 2)

No change.

#### SetupFirstTurn (bit 3)

No change.

#### Risky (bit 4)

No change.

#### PrioritizeExtremes (bit 5)

No change.

#### BatonPass (bit 6)

No change.

#### TagStrategy (bit 7)

No change.

#### CheckHP (bit 8)

No change.

#### Weather (bit 9)

No change.

#### Harassment (bit 10)

No change.

Bits 11–28 (unused): no change.

#### RoamingPokemon (bit 29)

No change.

#### Safari (bit 30)

No change.

#### CatchTutorial (bit 31)

No change.

### Move effects behind the AI Changes tab

Every move that has, in the hack, the effect of a move the tab names. The script picks routines by effect.

| ID | Vanilla move | Name in the tab | Vanilla effect | Hack effect |
| --- | --- | --- | --- | --- |
| 63 | MOVE_HYPER_BEAM | Hyper Beam | BATTLE_EFFECT_RECHARGE_AFTER (80) | BATTLE_EFFECT_RECOIL_QUARTER (48) |
| 200 | MOVE_OUTRAGE |  | BATTLE_EFFECT_CONTINUE_AND_CONFUSE_SELF (27) | BATTLE_EFFECT_RECOIL_QUARTER (48) |
| 276 | MOVE_SUPERPOWER |  | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) | BATTLE_EFFECT_RECOIL_QUARTER (48) |
| 308 | MOVE_HYDRO_CANNON |  | BATTLE_EFFECT_RECHARGE_AFTER (80) | BATTLE_EFFECT_RECOIL_QUARTER (48) |
| 416 | MOVE_GIGA_IMPACT | Giga Impact | BATTLE_EFFECT_RECHARGE_AFTER (80) | BATTLE_EFFECT_RECOIL_QUARTER (48) |
| 434 | MOVE_DRACO_METEOR | Draco Meteor | BATTLE_EFFECT_USER_SP_ATK_DOWN_2 (204) | BATTLE_EFFECT_RECOIL_QUARTER (48) |
| 149 | MOVE_PSYWAVE | Triple Axel | BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL (88) | same |
| 210 | MOVE_FURY_CUTTER | Fury Cutter | BATTLE_EFFECT_DOUBLE_POWER_EACH_TURN (119) | BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL (88) |
| 167 | MOVE_TRIPLE_KICK | Triple Kick | BATTLE_EFFECT_HIT_THREE_TIMES (104) | same |
| 439 | MOVE_ROCK_WRECKER | Rock Wrecker | BATTLE_EFFECT_RECHARGE_AFTER (80) | BATTLE_EFFECT_HIT_THREE_TIMES (104) |
| 140 | MOVE_BARRAGE | Hurricane | BATTLE_EFFECT_MULTI_HIT (29) | BATTLE_EFFECT_UNUSED_141 (141) |
| 87 | MOVE_THUNDER | Thunder | BATTLE_EFFECT_THUNDER (152) | same |
| 36 | MOVE_TAKE_DOWN | Take Down | BATTLE_EFFECT_RECOIL_QUARTER (48) | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) |
| 370 | MOVE_CLOSE_COMBAT | Close Combat | BATTLE_EFFECT_DEF_SPD_DOWN_HIT (229) | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) |
| 413 | MOVE_BRAVE_BIRD | Brave Bird | BATTLE_EFFECT_RECOIL_THIRD (198) | BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF (182) |
| 457 | MOVE_HEAD_SMASH | Head Smash | BATTLE_EFFECT_RECOIL_HALF (269) | same |

### Overlay 14 outside the script

Overlay 14 is 62,560 bytes in both ROMs, loaded at 0x0221FC20. sAICommandTable is at offset 0xF28C in both, with the same 109 handler pointers. Outside the script, 111 regions differ, in 31 functions; every one is a relocation. 1 more region is inside the script.

| Function | Offsets | What changed |
| --- | --- | --- |
| `TrainerAI_Init (inferred)` | 0x0054 | BL into overlay 16, +8 (×1) |
| `TrainerAI_Main (inferred)` | 0x00F0 | BL into overlay 16, +28 (×1) |
| `TrainerAI_MainDoubles (inferred)` | 0x042C | BL into overlay 16, +8 (×1) |
| `AICmd_LoadTypeFrom` | 0x0DA4, 0x0DBC, 0x0DD2, 0x0DEA, 0x0E1C, 0x0E3C, 0x0E5A, 0x0E7A | BL into overlay 16, +8 (×8) |
| `AICmd_FlagBattlerIsType` | 0x0EC6, 0x0ED6 | BL into overlay 16, +8 (×2) |
| `AICmd_FlagMoveDamageScore` | 0x0F96, 0x0FB2 | BL into overlay 16, +8 (×2) |
| `AICmd_IfSpeedCompareEqualTo` | 0x1114 | BL into overlay 16, +8 (×1) |
| `AICmd_IfSpeedCompareNotEqualTo` | 0x1158 | BL into overlay 16, +8 (×1) |
| `AICmd_CalcMaxEffectiveness` | 0x149E | BL into overlay 16, +8 (×1) |
| `AICmd_IfMoveEffectivenessEquals` | 0x1548 | BL into overlay 16, +8 (×1) |
| `AICmd_IfCurrentMoveKills` | 0x1A4C, 0x1A62 | BL into overlay 16, +8 (×2) |
| `AICmd_IfCurrentMoveDoesNotKill` | 0x1B78, 0x1B8E | BL into overlay 16, +8 (×2) |
| `AICmd_LoadHeldItemEffect` | 0x203A, 0x2054 | BL into overlay 16, +28 (×2) |
| `AICmd_LoadFlingPower` | 0x22C0 | BL into overlay 16, +28 (×1) |
| `AICmd_IfCanUseLastResort` | 0x232E | BL into overlay 16, +8 (×1) |
| `AICmd_LoadBattlerSpeedRank` | 0x2420 | BL into overlay 16, +8 (×1) |
| `AICmd_IfPartyMemberDealsMoreDamage` | 0x24E6, 0x2500 | BL into overlay 16, +8 (×2) |
| `AICmd_IfBattlerDealsMoreDamage` | 0x26B2, 0x26CE, 0x2738 | BL into overlay 16, +8 (×3) |
| `AICmd_CheckIfHighestDamageWithPartner` | 0x2AB0, 0x2AC8 | BL into overlay 16, +8 (×2) |
| `AICmd_LoadAbility` | 0x2FFC | BL into overlay 16, +8 (×1) |
| `ov14_02222E84` | 0x3326, 0x3334, 0x3350, 0x35D8, 0x3608, 0x362E | BL into overlay 16, +28 (×4); BL into overlay 16, +8 (×2) |
| `ov14_0222327C` | 0x3692, 0x369E, 0x377A, 0x378E | BL into overlay 16, +28 (×2); BL into overlay 16, +8 (×2) |
| `ov14_0222342C` | 0x3878, 0x390C, 0x392C, 0x3936, 0x3944, 0x3952, 0x3970 | BL into overlay 16, +8 (×5); BL into overlay 16, +28 (×2) |
| `ov14_022235F0` | 0x3A60, 0x3A96, 0x3BA0, 0x3BD8, 0x3BE2, 0x3BF0, 0x3BFE, 0x3C1C, 0x3C66, 0x3C70, 0x3C7E, 0x3C8C, 0x3CAA, 0x3DAA, 0x3DE2, 0x3DEC, 0x3DFA, 0x3E08, 0x3E26, 0x3E72, 0x3E7C, 0x3E8A, 0x3E98, 0x3EB6 | BL into overlay 16, +8 (×18); BL into overlay 16, +28 (×6) |
| `ov14_02223B34` | 0x3F84, 0x4026 | BL into overlay 16, +8 (×2) |
| `ov14_02223C8C` | 0x40EE | BL into overlay 16, +8 (×1) |
| `ov14_02223E10` | 0x4302, 0x4328, 0x435E, 0x4386, 0x43A8, 0x43B4, 0x43C4, 0x43D4, 0x43F2 | BL into overlay 16, +8 (×6); BL into overlay 16, +28 (×3) |
| `ov14_02224070` | 0x4470 | BL into overlay 16, +8 (×1) |
| `ov14_022241A4` | 0x45B6, 0x45CA, 0x45DE, 0x45EE, 0x45FE | BL into overlay 16, +8 (×5) |
| `ov14_022243BC` | 0x47E0 | BL into overlay 16, +28 (×1) |
| `ov14_022244B0` | 0x49B0, 0x49BE, 0x49F2, 0x4A28, 0x4A62, 0x4A96, 0x4ACA, 0x4AFE, 0x4B44, 0x4B64, 0x4B84, 0x4BC8, 0x4BE8, 0x4C06, 0x4C26 | BL into overlay 16, +28 (×15) |

### Overlay 16

Overlay 16 is 219,776 bytes in vanilla and 219,808 in the hack, loaded at 0x0223B140 in both. The halfword alignment finds 4660 changed regions. 4647 of them are relocations: an instruction or word that still refers to the same code or data, which moved (4102 BLs, 0 branches, 16 PC-relative loads, 530 pointers). The other 13:

| Vanilla offset | Vanilla bytes | Hack offset | Hack bytes |
| --- | --- | --- | --- |
| 0x13090 | 2 | 0x13090 | 2 |
| 0x13EF8 | 48 | 0x13EF8 | 52 |
| 0x14216 | 48 | 0x1421A | 52 |
| 0x1B2F0 | 260 | 0x1B2F8 | 276 |
| 0x1B586 | 2 | 0x1B59E | 2 |
| 0x1B598 | 4 | 0x1B5B0 | 4 |
| 0x1B5B6 | 4 | 0x1B5CE | 4 |
| 0x1B5C0 | 2 | 0x1B5D8 | 2 |
| 0x1B5CC | 2 | 0x1B5E4 | 2 |
| 0x1B5EA | 30 | 0x1B602 | 2 |
| 0x1B61E | 0 | 0x1B61A | 4 |
| 0x1B638 | 0 | 0x1B638 | 28 |
| 0x359D0 | 0 | 0x359EC | 4 |
<!-- /generated -->
