# Trainer AI: what it reads

The AI is meant to track "the player's moves, ability and item only once they have been revealed". That holds only for eight script commands. Everything else the AI reads is the real battle state, including the player's real ability, item, stats and HP. This page lists every read, so that the port and the engine adapter give each one the right data.

Sources are pret/pokeplatinum at `62bdaacdc`. TA is `src/battle/trainer_ai/trainer_ai.c`, BL is `src/battle/battle_lib.c`, BCP is `src/battle/battle_controller_player.c` and BS is `src/battle/battle_script.c`.

## The verdict

- **Eight commands read the AI's knowledge** of the player's battler. That knowledge is `AIContext.battlerMoves`, `battlerAbilities` and `battlerHeldItems`, which `src/ai/memory.ts` keeps from the battle log:
  - `IfMoveKnown`, `IfMoveNotKnown`, `IfMoveEffectKnown` and `IfMoveEffectNotKnown` read the known moves (TA:1668, 1724, 1765, 1807);
  - `LoadBattlerAbility` and `CheckBattlerAbility` read the known ability (TA:1181, 1225);
  - `LoadHeldItemEffect` and `IfHeldItemEqualTo` read the known item (TA:1909, 1928).
- **Even these eight read real data in places:**
  - On the AI's own side, all eight read the real moves, ability and item.
  - Both ability commands first read the battler's real Gastro Acid flag (TA:1177, 1221), so the adapter must pass it.
  - With no ability known, `LoadBattlerAbility` reads the real ability if it is Shadow Tag, Magnet Pull or Arena Trap. Otherwise it reads the species' abilities and flips a coin between two (TA:1170–1210). `CheckBattlerAbility` makes the same fallback without a coin, as rows 41 and 83 describe (TA:1212–1266).
- **Two commands read the player's real item or ability outright:** `LoadHeldItem` (TA:1891) and `LoadAbility` (TA:2654).
- **The five C routines read only real data:** switching, item use, post-KO replacement, the damage estimate and the speed comparison. That covers the player's real ability, item, types, stats and HP.

## How to read the tables

- **Real** means the battle's actual state: `BattleContext`, its `battleMons` and the parties.
- **Knowledge** means what the AI has seen, as kept by `src/ai/memory.ts`.
- **None** means no battle state: only the script, `calcTemp`, a random draw, or the ROM's move data for the AI's own current move.
- **Exact counter** in a row means the read needs a counter's exact value. Elsewhere, a counter only has to be non-zero while its effect is active. This is for the adapter.

## Every script command

The line is the handler's first line in trainer_ai.c. "Any battler" means the command takes a battler argument, and the read is real for whichever battler it names.

| # | Command | TA | Reads | Source |
|---|---|---|---|---|
| 0 | IfRandomLessThan | 528 | one draw, `% 256` | None |
| 1 | IfRandomGreaterThan | 540 | one draw, `% 256` | None |
| 2 | IfRandomEqualTo | 552 | one draw, `% 256` | None |
| 3 | IfRandomNotEqualTo | 564 | one draw, `% 256` | None |
| 4 | AddToMoveScore | 576 | the current slot's score | None |
| 5 | IfHPPercentLessThan | 588 | current and maximum HP, any battler | Real |
| 6 | IfHPPercentGreaterThan | 603 | current and maximum HP, any battler | Real |
| 7 | IfHPPercentEqualTo | 618 | current and maximum HP, any battler | Real |
| 8 | IfHPPercentNotEqualTo | 633 | current and maximum HP, any battler | Real |
| 9 | IfStatus | 648 | status condition, any battler | Real |
| 10 | IfNotStatus | 662 | status condition, any battler | Real |
| 11 | IfVolatileStatus | 676 | volatile conditions, any battler | Real |
| 12 | IfNotVolatileStatus | 690 | volatile conditions, any battler | Real |
| 13 | IfMoveEffect | 704 | move-effect flags (Leech Seed, Substitute and so on), any battler | Real |
| 14 | IfNotMoveEffect | 718 | move-effect flags, any battler | Real |
| 15 | IfSideCondition | 732 | the battler's side conditions | Real |
| 16 | IfNotSideCondition | 747 | the battler's side conditions | Real |
| 17 | IfLoadedLessThan | 762 | `calcTemp` | None |
| 18 | IfLoadedGreaterThan | 774 | `calcTemp` | None |
| 19 | IfLoadedEqualTo | 786 | `calcTemp` | None |
| 20 | IfLoadedNotEqualTo | 798 | `calcTemp` | None |
| 21 | IfLoadedMask | 810 | `calcTemp` | None |
| 22 | IfLoadedNotMask | 822 | `calcTemp` | None |
| 23 | IfMoveEqualTo | 834 | the AI's current move (none if it has no PP) | Real |
| 24 | IfMoveNotEqualTo | 846 | the AI's current move | Real |
| 25 | IfLoadedInTable | 858 | `calcTemp` and a script table | None |
| 26 | IfLoadedNotInTable | 876 | `calcTemp` and a script table | None |
| 27 | IfAttackerHasDamagingMoves | 895 | the AI's real moves and their power | Real |
| 28 | IfAttackerHasNoDamagingMoves | 913 | the AI's real moves and their power | Real |
| 29 | LoadTurnCount | 931 | `totalTurns` (exact counter) | Real |
| 30 | LoadTypeFrom | 937 | current types of the AI, the player or a partner; the move's type | Real |
| 31 | LoadMovePower | 1006 | the current move's ROM power | None |
| 32 | FlagMoveDamageScore | 1012 | the damage estimate for the AI's four moves (see the routines below) | Real |
| 33 | LoadBattlerPreviousMove | 1068 | `movePrevByBattler`, any battler: the last move that ran (memory's `lastMoveBy`) | Real |
| 34 | IfTempEqualTo | 1078 | `calcTemp` | None |
| 35 | IfTempNotEqualTo | 1090 | `calcTemp` | None |
| 36 | IfSpeedCompareEqualTo | 1102 | the speed comparison (see the routines below) | Real |
| 37 | IfSpeedCompareNotEqualTo | 1114 | the speed comparison | Real |
| 38 | CountAlivePartyBattlers | 1126 | party HP and species, either side | Real |
| 39 | LoadCurrentMove | 1158 | the AI's current move | Real |
| 40 | LoadCurrentMoveEffect | 1164 | the current move's ROM effect | None |
| 41 | LoadBattlerAbility | 1170 | first, the battler's real Gastro Acid flag (`MOVE_EFFECT_ABILITY_SUPPRESSED`, TA:1177), which loads ABILITY_NONE. Otherwise, for any battler but the AI and its partner: the known ability (TA:1181); with none known, the real ability if it is Shadow Tag, Magnet Pull or Arena Trap, else the species' abilities, with a coin flip between two (TA:1195). The AI and its partner: the real ability | **Knowledge** |
| 42 | CalcMaxEffectiveness | 1268 | the type chart for the AI's moves against the player's real types, ability and item | Real |
| 43 | IfMoveEffectivenessEquals | 1311 | the same, for the current move | Real |
| 44 | IfPartyMemberStatus | 1348 | bench statuses, either side | Real |
| 45 | IfPartyMemberNotStatus | 1381 | bench statuses, either side | Real |
| 46 | LoadCurrentWeather | 1414 | field conditions | Real |
| 47 | IfCurrentMoveEffectEqualTo | 1441 | the current move's ROM effect | None |
| 48 | IfCurrentMoveEffectNotEqualTo | 1453 | the current move's ROM effect | None |
| 49 | IfStatStageLessThan | 1465 | a stat stage, any battler | Real |
| 50 | IfStatStageGreaterThan | 1480 | a stat stage, any battler | Real |
| 51 | IfStatStageEqualTo | 1495 | a stat stage, any battler | Real |
| 52 | IfStatStageNotEqualTo | 1510 | a stat stage, any battler | Real |
| 53 | IfCurrentMoveKills | 1525 | the damage estimate against the player's real current HP | Real |
| 54 | IfCurrentMoveDoesNotKill | 1576 | the damage estimate against the player's real current HP | Real |
| 55 | IfMoveKnown | 1627 | for the player: the known moves (TA:1668). Real for the AI and its partner | **Knowledge** |
| 56 | IfMoveNotKnown | 1683 | for the player: the known moves (TA:1724) | **Knowledge** |
| 57 | IfMoveEffectKnown | 1739 | for the player: the known moves' effects (TA:1765) | **Knowledge** |
| 58 | IfMoveEffectNotKnown | 1781 | for the player: the known moves' effects (TA:1807) | **Knowledge** |
| 59 | IfBattlerUnderEffect | 1823 | Disable or Encore turns, any battler (non-zero only) | Real |
| 60 | IfCurrentMoveMatchesEffect | 1850 | the AI's disabled or encored move | Real |
| 61 | Escape | 1875 | nothing | None |
| 62 | Dummy3E | 1881 | nothing (hangs: the cursor never moves) | None |
| 63 | Dummy3F | 1886 | nothing (hangs) | None |
| 64 | LoadHeldItem | 1891 | the real held item of any battler, the player's included | Real |
| 65 | LoadHeldItemEffect | 1901 | for any battler but the AI: the known item (TA:1909). Real for the AI | **Knowledge** |
| 66 | LoadGender | 2470 | gender, any battler | Real |
| 67 | LoadIsFirstTurnInBattle | 2480 | `fakeOutTurnNumber` against `totalTurns` (exact counter) | Real |
| 68 | LoadStockpileCount | 2494 | Stockpile count (exact counter) | Real |
| 69 | LoadBattleType | 2504 | the battle type | Real |
| 70 | LoadRecycleItem | 2510 | the item Recycle would restore, any battler | Real |
| 71 | LoadTypeOfLoadedMove | 2520 | ROM type of the move in `calcTemp` | None |
| 72 | LoadPowerOfLoadedMove | 2526 | ROM power of the move in `calcTemp` | None |
| 73 | LoadEffectOfLoadedMove | 2532 | ROM effect of the move in `calcTemp` | None |
| 74 | LoadProtectChain | 2538 | `moveProtect` and Protect's success count (exact counter) | Real |
| 75 | PushAndGoTo | 2554 | the script stack | None |
| 76 | GoTo | 2561 | nothing | None |
| 77 | PopOrEnd | 2568 | the script stack | None |
| 78 | IfLevel | 2579 | both levels | Real |
| 79 | IfTargetIsTaunted | 2610 | the player's Taunt turns (non-zero only) | Real |
| 80 | IfTargetIsNotTaunted | 2620 | the player's Taunt turns (non-zero only) | Real |
| 81 | IfTargetIsPartner | 2630 | the two battler slots | None |
| 82 | FlagBattlerIsType | 991 | current types, any battler | Real |
| 83 | CheckBattlerAbility | 1212 | first, the battler's real Gastro Acid flag (TA:1221), which counts as no ability. Otherwise, when the argument is the defender or the defender's partner (TA:1223): the known ability (TA:1225). With none known: the real ability if it is Shadow Tag, Magnet Pull or Arena Trap. Otherwise the species' abilities. With two abilities and neither equal to the one asked about, it takes ability 1; with two abilities and either one equal, it takes none. With one ability, it takes that one (TA:1239–1252). Any other argument: the real ability. Then no ability gives AI_UNKNOWN, the one asked about gives AI_HAVE, and any other gives AI_NOT_HAVE (TA:1259–1265). No coin flip | **Knowledge** |
| 84 | IfActivatedFlashFire | 2641 | the Flash Fire flag, any battler | Real |
| 85 | IfHeldItemEqualTo | 1915 | on the AI's side: the real item. On the player's: the known item (TA:1928) | **Knowledge** |
| 86 | IfFieldConditionsMask | 1936 | field conditions | Real |
| 87 | LoadSpikesLayers | 1948 | Spikes or Toxic Spikes layers on a side (exact counter) | Real |
| 88 | IfAnyPartyMemberIsWounded | 1968 | bench HP, either side | Real |
| 89 | IfAnyPartyMemberUsedPP | 1987 | bench PP, either side | Real |
| 90 | LoadFlingPower | 2014 | the real item's Fling power; 0 under Embargo (Embargo turns non-zero only) | Real |
| 91 | LoadCurrentMovePP | 2024 | the AI's PP in the current slot | Real |
| 92 | IfCanUseLastResort | 2030 | the battler's real move count and Last Resort count (exact counter) | Real |
| 93 | LoadCurrentMoveClass | 2044 | the current move's ROM class | None |
| 94 | LoadDefenderLastUsedMoveClass | 2050 | the player's `movePrevByBattler`, the last move that ran | Real |
| 95 | LoadBattlerSpeedRank | 2056 | speed comparisons between every active battler | Real |
| 96 | LoadBattlerTurnCount | 2096 | `totalTurns` minus `fakeOutTurnNumber` (exact counter) | Real |
| 97 | IfPartyMemberDealsMoreDamage | 2106 | damage estimates for the AI's real bench movesets | Real |
| 98 | IfHasSuperEffectiveMove | 2176 | the type chart against the player's real types, ability and item | Real |
| 99 | IfBattlerDealsMoreDamage | 2187 | the battler's last move that ran, with its real stats, ability and item | Real |
| 100 | SumPositiveStatStages | 2243 | stat stages, any battler | Real |
| 101 | DiffStatStages | 2259 | stat stages of the battler and the AI | Real |
| 102 | IfBattlerHasHigherStat | 2270 | stored stats of the battler and the AI | Real |
| 103 | IfBattlerHasLowerStat | 2287 | stored stats | Real |
| 104 | IfBattlerHasEqualStat | 2304 | stored stats | Real |
| 105 | CheckIfHighestDamageWithPartner | 2369 | damage estimates for the AI and its partner | Real |
| 106 | IfBattlerFainted | 2438 | `battlersSwitchingMask` | Real |
| 107 | IfBattlerNotFainted | 2454 | `battlersSwitchingMask` | Real |
| 108 | LoadAbility | 2654 | the real ability of any battler, the player's included | Real |

That is 30 None rows, 71 Real rows and 8 Knowledge rows.

## The C routines

| Routine | Lines | Reads | Source |
|---|---|---|---|
| Switching: `TrainerAI_ShouldSwitch` and its helpers | TA:3263–3987 | the player's real abilities (`Battler_Ability`), items, types and party; the AI's bench; `moveHit` and `moveHitBattler` (memory's `lastHitBy`); Perish Song turns (exact counter, TA:3263) | Real |
| Item use: `TrainerAI_ShouldUseItem` | TA:4056–4199 | the AI's own HP, status, volatile conditions, Embargo, living party count and bag; `fakeOutTurnNumber` against `totalTurns` (exact counter) | Real |
| Post-KO replacement: `BattleAI_PostKOSwitchIn` | BL:7923–8089 | the player's real types, ability and item; damage from the fainted battler's stats with each bench move | Real |
| Damage estimate: `TrainerAI_CalcAllDamage`, `TrainerAI_CalcDamage`, `BattleSystem_CalcMoveDamage` and `BattleSystem_ApplyTypeChart` | TA:2799–3113, BL:6601–7079, BL:2560–2679 | both battlers' real stats, stages, levels, abilities, items, types, HP and status; the side and field conditions; the speeds the last comparison cached (`monSpeedValues`, for Gyro Ball) | Real |
| Speed comparison: `BattleSystem_CompareBattlerSpeed` | BL:1188–1454 | real speeds, stages, items, abilities, Trick Room, Tailwind and paralysis; `speedRand` for Quick Claw (see below) | Real |

## The first decision: `initialView` (F1)

`initialView` (`src/ai/initialView.ts`) builds the AI's turn-1 view for the sweep and the matchup sheet, and `initialDecision` adds the AI's knowledge then. It loads both leads as `BattleSystem_InitBattleMon` does (BL:70–166), with the field from the trainer's field note (BL:3662–3707), which the engine applies too (the `_PERM` weather, Trick Room and Gravity), so the two paths show the same field. The rest of `BattleSystem_TriggerEffectOnSwitch` (BL:3649–4175) comes from the engine (`src/ai/switchIn.ts`). It starts the two leads in the engine, takes the fields the effects change from its state (`viewFromState`), and takes the knowledge from `battleStartMemory` (`src/ai/model.ts`), the same fold of the battle-start log the EnemyModel's `initialMemory` uses, from the field note's `_PERM` weather. So the two paths know the same at the same battle start (`test/unit/ai/initialView.test.ts`). It checks each step against the C. There is no gap list: a switch-in effect is applied, or the decision is refused with `AiError('UNDEFINED')` and a named reason (`SWITCH_IN_REFUSALS`, message `turn-1 switch-in, <reason>: …`).

| Step | C | Taken from the engine | Checked against the C | Refused when |
|---|---|---|---|---|
| Trace | BL:3712–3737, 7750–7782 | the traced ability, in the `BattleMon` only | who traces | they differ (both refuse Forecast, Trace and Multitype, and a Griseous Orb holder doesn't trace in either) |
| Weather abilities | BL:3739–3793 | (the weather is checked, not taken) | the weather that stays (the last holder in `monSpeedOrder`, BCP:249, BL:3364–3384) and which holders announce | a draw orders two holders (the engine draws it too: its start-chance note); the engine's weather or announcements differ |
| Intimidate, Download | BL:3795–3859; `subscript_intimidate.s` | the stat stages | — (Showdown's Gen 4 rules are the C's: Download's `>=` tie, Clear Body and Hyper Cutter blocks) | — |
| Anticipation to Pressure | BL:3861–4113 | the knowledge only | see the reveals below | — |
| Form changes | BL:6305–6463; pokemon.c:1221, 4319 | Castform's types and form, Cherrim's form, Arceus's types | the C's form and types | they differ (a form or types the engine doesn't give); Giratina-Origin without its orb, which the engine never reverts |
| Status-curing abilities | BL:4378–4431 | the status, in battle and in the party | the status | it differs |
| Held items | BL:4967–5305 | HP, status, PP, stages, the item, `recycleItem` | whether the item acts, and the HP, status and PP after it | an item whose hack record isn't the engine's (`VANILLA_ENTRY_ITEMS`; `HACK_PINCH_ZERO_ITEMS` for the pinch items with parameter 0, Ganlon Berry, Apicot Berry and Shoal Salt, which the cartridge eats at entry at any HP, `maxHP / 0` being `_u32_div_f`'s `maxHP`, and the engine models it, so the overlay checks the +1 stage against the C's) when either side can act; the two disagree (White Herb after an Intimidate) |
| Any step | — | — | — | the engine's battle start has a chance whose outcomes differ (`BATTLE_START_CHANCE_NOTE`) |

**The overlay is checked against the load** (`overlayLead` in `src/ai/switchIn.ts`). Each field the engine gives a lead must equal the loaded value, unless a step that changes it fired, by the port's own rules (`FiredStep`):
- Trace changes the ability;
- the foe's Intimidate and the lead's Download change the stat stages;
- a status-curing ability changes the status;
- an item that acted changes the item, `recycleItem` and its effect's fields.

Otherwise `AiError('BAD_VIEW')` names the field, both values and the steps that fired. The lead's ability must also be the C's after the Trace step, and the engine's leads must have the loaded species, level and stats. So a view with no step fired is exactly its load. `initialDecision` returns the steps that fired. The sweep checks every view without one against `initialLoad`, the load alone with the battle-start speed comparison, and prints the count ("views with no switch-in step fired"). When F1 landed, a one-off comparison of the whole sweep before and after also found every decision that returned before F1 unchanged. That comparison isn't committed; the checks above are.

**The engine's dex is global.** `initialView` installs the dex from its `data` argument (`installKaizoDex`), unless the installed dex is already `data`'s, which it keeps. Everything that makes or reads an engine state runs on the installed dex:
- `createBattle` (the trainer's ROM record, the sets' moves);
- `restore`, and so `viewFromState`, `protocolIds`, `legalChoices`, `expandTurn` and `unmodelledIn`;
- the EnemyModel (`src/ai/model.ts`), which asks its caller to install the dex from the data the model was made with.

A caller that installed a dex from other data before calling `initialView` has `data`'s installed afterwards.

**What the switch-in messages tell the AI.** A message records a battler's ability or item only when its tag names that battler (BS:11798–11806, 11728–11745), or when a script command sets an ability (BS:3074, 3402–3404). `rememberStep` follows this for the battle-start lines:

| Switch-in message | Cartridge's tag | Showdown's line | Fold |
|---|---|---|---|
| Pressure, Mold Breaker, Slow Start, Anticipation, Forewarn; a weather ability whose own `_PERM` bit is clear | the holder's ability (`BTLSCR_MSG_BATTLER_TEMP`) | `-ability`, `-start`, `-activate`, `-weather …[from] ability:` | reveals |
| A weather ability whose own `_PERM` bit is set already (the note's, or an earlier ability's) | none: no subscript runs (BL:3746–3782) | none either: the engine starts the note's weather itself, and Showdown's `setWeather` refuses the same weather | nothing: `rememberStep` keeps the cartridge's `_PERM` weather (`permWeather`, from the note on) and drops such a line's reveal, at battle start and mid-battle, on both paths. Nothing ends a `_PERM` weather: the turn end counts down only a `_TEMP` one (`battle_controller_player.c:1113–1128` and its kin), and a weather's end clears its `_TEMP` bit alone (`subscript_raining_end.s:5` and its kin). A weather move into its own weather fails (`effect_script_0136.s:5` and its kin test both bits), so the engine fails it too, and the plain line of the note's weather at battle start keeps it. Another weather's line clears it, and so does every Hail, which tests only `HAILING_TEMP` (`effect_script_0164.s:5`; `test/real/aiWeather.test.ts`) |
| Trace | the traced battler's ability (`subscript_trace.s:9`); the tracer's new one through the script (BS:3402–3404) | `-ability|<tracer>|X|Trace|[from] ability: Trace|[of] <traced>` | reveals X for the player's battler, whoever traced |
| Intimidate, Download | none: the stat message is buffered (BS:2853–2854, 2955–2961) and `PrintBufferedMessage` skips the tags (BS:1505–1510) | `-ability|<holder>|X|boost` | nothing |
| A stat drop an ability blocks | none: buffered too (BS:2883–2903) | `-fail|<target>|unboost|…[from] ability: X` | nothing |
| Frisk | none: `BTLSCR_MSG_TEMP`, the found item (`subscript_frisk.s:7`, BS:11745–11747) | `-item||X|[from] ability: Frisk|[of] <frisker>` | nothing |
| A form change | none (`subscript_form_change.s:22`) | `-formechange|…|[from] ability: Forecast` | nothing |
| A status-curing ability | none: `msgAbilityTemp` (BL:4442–4445; `subscript_ability_forbids_status.s:6`; BS:11801–11802) | `-activate|<holder>|ability: X` | nothing |
| An entry item | the holder's item (BS:11740–11743), forgotten once it is used up (BL:1822) | `-enditem`, then `-heal` or `-boost …[from] item:` | 0 |

## Reads the adapter can't always give

Some real fields can't always be derived from the engine's Showdown state. The adapter never reads such a field as a default. It lists the field's path in `AiView.unknown` (`src/ai/lib/known.ts`, `PATHS`), and the reader calls `requireKnown` first, which throws `AiError('UNDEFINED')`. `docs/ai-spot-checks.md` items 14–23 say when each path is listed and why.

| Field | Path | Listed | Reader that guards it |
|---|---|---|---|
| `recycleItem[b]` | `recycleItem.<b>` | only after a Recycle or Natural Gift in a slot whose berry Bug Bite or Pluck ate; otherwise derived from `lastItem` and the memory (item 14) | `LoadRecycleItem` (row 70) |
| `MOVE_EFFECT_IMPRISONED` | `mons.<b>.moveEffectsMask.imprisoned` | never: the memory derives it from the log (`imprisonedMark`; see below and item 15) | `IfMoveEffect`, `IfNotMoveEffect` (rows 13, 14) with that bit in the mask |
| `moveProtect`, `protectSuccessTurns` | `moveProtect.<b>`, `mons.<b>.effects.protectSuccessTurns` | after an AI bag item while the last move protects, or a called Protect (item 16) | `LoadProtectChain` (row 74) |
| `slowStartTurnNumber` | `mons.<b>.effects.slowStartTurnNumber` | while transformed (item 17) | Slow Start in the speed comparison (BL:1263) and the damage formula (BL:6709) |
| IVs | `mons.<b>.ivs` | while transformed (item 19) | Hidden Power in `TrainerAI_MoveType` (TA:3208) and `TrainerAI_CalcDamage` (TA:2973). A party Pokémon's IVs (`Move_CalcVariableType`, the bench estimates) are always known |
| `weight` | `mons.<b>.weight` | where the two Pokédex tables differ and the form can't be read; never in either ROM (item 18) | Low Kick and Grass Knot (TA:3055) |
| `friendship` | `mons.<b>.friendship` | never: the engine sets happiness from `BattleMon.friendship`, and `initialView` takes it too (item 22) | Return and Frustration (TA:3018–3026) |
| deep fog | `fieldConditionsMask.fog` | after a Defog with a fog field note, until a weather is set; otherwise derived from the note and the memory's `fog` (item 20) | `LoadCurrentWeather` (row 46), `IfFieldConditionsMask` (row 86) and Solar Beam's halving (BL:7058), where the result hinges on the bit |
| `monSpeedValues` | `monSpeedValues` | only while a transformed Slow Start battler is out; otherwise the engine's `lastSpeedValues` (item 21) | Gyro Ball (TA:2995) reading a speed the run hasn't written, while the copy is the decision start's (`RunInput.startSpeeds`) |
| `battleStatusMask`'s type-chart bits | `battleStatusMask.turn` (`REPLACEMENT_PATHS`) | at the AI's own mid-turn switch, when its switching action ran a move whose effect is in `S_MASK_EFFECTS` (see below) | none: the replacement is refused |
| `powerMul` | `powerMul` | the same, for `S_POWER_EFFECTS`; also when a player's Pursuit is still queued at the AI's U-turn switch and TryPursuit's tests (BS:6900–6916), read from the state, don't rule it out: a fainted, asleep or frozen user, or no PP for the move TryPursuit tests, settles it at 10; a user that passes every test (the engine should have run it), a Truant user (the state lacks `moveEffectsData.truant`) or an Encore whose slot the state lacks stays listed | none: the replacement is refused |
| a fainted AI battler's kept fields | `mons.1.<field>` (ability, types, species, form, stats, moves, weight) | at its replacement, when the log shows Transform, a changed ability, a type change, Power Trick or a form change since its switch-in (`memory.aiKept`); never for an ability a Trace set, which the memory gives (`aiTraced`, see below) | none: the replacement is refused |
| the U-turn user's HP | `mons.1.curHP` | at its switch, when a player's Pursuit is still queued and TryPursuit's tests don't rule it out (as `powerMul`) | none: the replacement is refused |

Everything else in the tables above, the imprisoner's own `MOVE_EFFECT_IMPRISON` with its moves (`Move_Imprisoned`, BL:3316) and its foe's `MOVE_EFFECT_IMPRISONED` (from the memory), the adapter derives exactly. Item 15 notes one engine difference for the imprisoner's own bit: an Imprison used after its foe fainted earlier in the turn.

### What a replacement reads of the turn

`BattleAI_PostKOSwitchIn` (BL:7923) reads three `battleStatusMask` bits through its type chart (`IGNORE_TYPE_CHECKS` and `IGNORE_IMMUNITIES` at BL:2592, 2655–2656 and 7544–7545; `LAST_OF_MULTI_TURN` through `MoveIsOnDamagingTurn`, BL:7601) and multiplies every move's power by `powerMul` (BL:6688). `BattleContext_Init` resets all four (BL:1980, 2009), and it runs at the end of every action (`MoveEnd`, BCP:3998) as well as at the turn's end (BCP:1855). So:

- **After a KO,** `ReplaceFainted` runs at the turn's end (BCP:1848), after the last action's reset. Only the turn-end checks run in between, and their scripts write neither field. In the hack, the changed turn-end subscripts (238 and 251) write neither either (`test/real/aiBattleScripts`). The view's 0 and 10 are exact, whatever moves the turn ran.
- **At the AI's own mid-turn switch** (U-turn, Baton Pass), the pick runs inside the switching action, before its reset. The memory keeps that action's moves (`switchAction`), and the adapter lists a field when one of their effects can write it. The sets are in `src/ai/battleScripts.ts`. They are built from the decompilation's effect scripts, their subscripts and the C handlers they run, and every effect whose script the hack changed joins both. A Pursuit that hits the U-turn user before the pick (`subscript_attack_then_switch_out.s:54`, TryPursuit, BS:6928) leaves `powerMul` at 20: Showdown runs it at the same point, so the view takes 20 when the action shows it. A player's Pursuit Showdown left queued gets TryPursuit's own tests on its user (`compose.ts` `tryPursuitRuledOut`): where they rule it out, `powerMul` stays 10 and the U-turn user's HP is the state's; elsewhere both are listed (the table above).
- **A fainted battler's own fields.** `BattleSystem_CleanupFaintedMon` (BL:2156–2210) resets the stat stages, volatiles, move effects and turn flags, but keeps species, types, ability, stats and status. Showdown's faint resets them (`clearVolatile`). The status is exact: Showdown keeps it in `statusState.id`. An ability a Trace set is exact too: `subscript_trace.s:6–7` copies the traced battler's ability into the tracer's `BattleMon`, Showdown's Gen 4 Trace takes the same foe's, and its line names it (`-ability|p2a…|X|Trace|[from] ability: Trace|[of] p1a…`). The memory keeps X (`aiTraced`) until another change of the battler's ability or its next switch-in, and the view gives it at the replacement, where stage 2 reads it as the fainted attacker's (BL:8054–8063). The rest are listed when the log shows a change since the battler's switch-in.

## What the AI learns, and from which log lines

The cartridge writes the knowledge, `movePrevByBattler` and `moveHit` at the events below. `rememberStep` (`src/ai/memory.ts`) finds the same events in the engine's Showdown-protocol log. Side `p1` is the player (battler 0) and `p2` the AI (battler 1).

| Cartridge event | C | Log line | Memory |
|---|---|---|---|
| The AI runs `TrainerAI_Main` after choosing Fight, and its first step records the player's last move | TA:295, TA:2705 | the turn's first step (the one from the turn choice) shows no AI switch or bag item: no AI `\|switch\|`, no `\|-activate\|p2a…\|item: X\|[trainer]`, and no `\|move\|p1a…\|Pursuit\|p2a…\|[from] Pursuit` before the AI's first move line. An AI that faints before it acts counts: it chose Fight | if the turn-choice state's fact (`turnFight`) is `menu`, before the step's own lines `recordLastMove` writes `lastMoveBy[0]` (as of the turn's start) into the known moves. Once per turn: the first step uses the fact up |
| No `TrainerAI_Main`: the battle forces the move (recharge, Thrash-type locks, Uproar, moves the battle script locks in; every move unusable, so Struggle; an Encore lock) | BCP:334, 433, 443; BL:6224 | none needed: a fact of the turn-choice state (`fightKind` in `src/ai/model.ts`, the classification `support` uses), which `remember` stores as `turnFight = 'forced'` | nothing recorded |
| The fact can't be computed (the turn-choice state's view throws an `AiError`) | | `turnFight = 'unknown'` | when the AI chose Fight and the record would change the known moves, they are listed unknown (`PATHS.knownMoves(0)`, guarded by the four known-move commands) until the player's battler switches |
| A move ran, hit or miss: `movePrevByBattler` is the chosen move | BCP:3212, 3945 | `\|move\|` with no `[from]`, including `[miss]`, `-fail` and `-immune` outcomes | `lastMoveBy[b]` is the move |
| A move called by another (Metronome, Sleep Talk and so on) | BCP:3945 (`moveTemp` is the caller) | `\|move\|…\|[from]move: X` | `lastMoveBy` unchanged |
| The Pokémon couldn't move: sleep, freeze, paralysis, flinch, Truant, attraction, Disable, Taunt, Imprison, Gravity, Heal Block, no PP, a confusion self-hit, no target | BCP:2430–2711, 3317, 2311, then 3948 | `\|cant\|`, `\|-damage\|…\|[from] confusion`, `[notarget]` | `lastMoveBy[b] = 0` |
| Focus Punch lost its focus: the move ran, then failed in its script after the "used" message | BCP:3212, `subscript_missed.s` | `\|cant\|…\|Focus Punch` | `lastMoveBy[b]` is Focus Punch; on the player, also `lastHitBy` |
| A player move aimed at the AI showed its "used" message, hit or not | BCP:4498–4502 | a player `\|move\|` whose target is `p2a` (`moveCur`, so a called move counts as itself) | `lastHitBy = { move, battler: 0 }` |
| The player's attempt failed before its "used" message | BCP:4504–4506 | `\|cant\|p1a…` | `lastHitBy = null`. The cartridge clears the attempted move's target, which is the player itself for a move aimed at the user (BL:1665–1669). It makes no difference at a decision, because the AI's own action in the same turn leaves `moveHit[1]` cleared either way (BCP:4389) |
| Every AI action ends by clearing its own `moveHit` | BCP:4389 | an AI `\|move\|` (no `[from]`), `\|cant\|` or confusion self-hit; its bag item's `\|-activate\|p2a…\|item: X\|[trainer]` (`src/engine/trainerItems.ts`); its switch-in | `lastHitBy = null` |
| Magic Coat reflects a move: `SYSCTL_REUSE_LAST_MOVE` skips the `moveHit` update | BCP:3073–3077, 4498 | `\|move\|…\|[from]move: Magic Coat` | the bounced move doesn't set `lastHitBy` |
| Switch-in: knowledge, `movePrevByBattler` and `moveHit` are cleared | BL:2151–2153, 2124, 2121–2122 | `\|switch\|`, `\|drag\|` | that battler's slot cleared |
| Faint: the same clears | BS:1803, BL:2223–2225, 2202, 2199–2200 | `\|faint\|` | that battler's slot cleared |
| Imprison marks its user's foe with `MOVE_EFFECT_IMPRISONED`, working or not: `TryImprison`, the first command of its effect script, sets the mark before its checks | BS:6686–6692, `effect_script_0192.s:5`, BCP:3214 | any `\|move\|…\|Imprison` line, a called one (`[from]move: X`) included; not `\|cant\|` or a confusion self-hit, which run no script | `imprisonedMark[foe] = true` |
| Only a new BattleMon clears the mark: a switch-in (Baton Pass's kept bits lack it) or a faint. The imprisoner leaving doesn't | BL:2071, 2076, 2166 | `\|switch\|`, `\|drag\|`, `\|faint\|` of the marked battler | `imprisonedMark[b] = false` |
| An ability is named in a message, or changed by a script command | BS:11800–11807, 3074, 3403, then 12106 | `\|-ability\|`; a `[from] ability:` tag; an `ability:` argument to `-activate` or `-start`; except the lines whose cartridge message tags no battler: the switch-in ones (see "The first decision"), and the same stat-change lines mid-battle (Speed Boost, Steadfast, an Intimidate or Download at a later switch-in, a blocked stat drop: `\|-ability\|…\|boost` and `\|-fail\|…\|unboost`), but not Motor Drive's, whose own message tags its holder (`subscript_absorb_and_speed_up_1_stage.s:14`) | `battlerAbilities[0]` |
| An item is named in a message | BS:11728–11745, then 12119 | `\|-item\|`; a `[from] item:` tag; an `item:` argument to `-activate` or `-start`, except Quick Claw and Frisk's find | `battlerHeldItems[0]` |
| The item is gone: the known item is cleared once `heldItem` is none | BL:1822 | `\|-enditem\|` | `battlerHeldItems[0] = 0`; a later line in the same step that names the item doesn't bring it back |

Reveals are kept only for the player's battler. In singles, every command reads real data for the AI's own battler (TA:1179, 1638, 1908, 1925), so knowledge of it would only split the memory key. A `[from]` tag's owner is the `[of]` Pokémon when there is one; otherwise it is the line's own Pokémon. On `-heal` lines the owner is always the line's own Pokémon, because `[of]` there is the attacker.

## Quick Claw: which draw the AI reads

The AI reads the draw that orders **this** turn, not one the log has already shown.

- **Battle start:** `BattleContext_InitCounters` draws `speedRand` for every battler (BL:2024). It runs once (BCP:185).
- **Command selection:** at each turn's command selection, the AI reads `speedRand[b]` through `BattleSystem_CompareBattlerSpeed(…, ignoreQuickClaw = TRUE)` (BL:1279, 1345). Quick Claw still decides the comparison's result (BL:1402–1411).
- **Turn order:** `BATTLE_CONTROL_CALC_TURN_ORDER` comes next (BCP:698, 707). It compares the battlers that chose Fight with the same `speedRand` (BCP:779–780) and sets the Quick Claw flag that this turn's actions show (BL:1279–1284, BCP:3140).
- **The next draw:** only after the turn order does `PRE_MOVE_ACTION_STATE_SPEED_RNG` draw the next `speedRand` (BCP:853–856), for the next turn.

So turn N's decision and turn N's Quick Claw activation use the same draw, and the activation reaches the log only after the AI has decided. The memory never derives Quick Claw from the log.

Inside the AI's decision, the draw is exact where the engine has drawn it. The engine stores each side's Quick Claw roll of the current `speedRand` (`quickClawRolls(state)`; `quickClawThisTurn` in the view). That is the same draw, so the AI's read is exact. The engine's roll is `speedRand % 5 == 0`, so the adapter takes it only for an item whose `100 / param` is 5, as Quick Claw's param 20 gives.

Where the engine hasn't drawn it (no stored roll: the root of a battle, and a holder coming in at a mid-turn or replacement phase), the view's draw is `null`, never "no activation". The AI's speed compares then sum it over both outcomes at the cartridge's prior of 13108/65536. In that case the draw is treated as independent of the engine's own Quick Claw chance (the project's independence model: a sound superset for proofs, with approximate odds).

Two more rules follow from the draw being fixed for the whole turn:
- **A refused pick.** `TrainerAI_Main` re-runs on the same draw (`speedRand` is redrawn only at BCP:855 and BL:2024). So with a `null` draw, the slot played is conditioned on each value of the draw, renormalised per value, and mixed by the prior (`playedSlots` in `src/ai/model.ts`).
- **The post-KO pick reads no speed.** `BattleAI_PostKOSwitchIn` never compares speeds, so an absent roll at the replacement phases is never read.

The decision and the adapter handle this, not the memory.

One exception: Trick Room starting mid-turn re-sorts the remaining actions with Quick Claw active, after the next draw is made (BCP:3990–3992, BL:7276–7300). The current turn can then show the draw that the next decision reads. Showdown doesn't re-roll Quick Claw there, so the engine's log can't show it.

## Approximations

These are places where one step of the engine's log can't show the cartridge's event exactly. Each has a spot-check item in `docs/ai-spot-checks.md` (items 9 to 13).

Two former approximations are now exact, and stay listed so their spot checks keep their numbers:

1. **An Encore lock, and a forced AI that can't act.** Exact. Whether the battle forces the AI's move is a fact of the turn-choice state: `Battler_CanPickCommand` FALSE, Struggle, or an Encore lock (BCP:334, 433, 443). `remember` computes it from that state with the classification `support` uses (`fightKind`) and stores it for the turn's first step. An encored move's plain `|move|` line, or a locked AI's `|cant|` line, no longer counts as a free choice.
2. **The AI faints before acting.** Exact. Choosing Fight is read from the turn's first step: a switch or a bag item is an action of its own, which runs before every move, so it shows as an AI line first. A Pursuit at a switching AI shows as `[from] Pursuit`, even when it knocks the AI out before its `|switch|` line. With none of these, the AI chose Fight, so `TrainerAI_Main` ran and recorded the player's last move, whether or not the AI then acted. A turn that spans several steps (a mid-turn switch, a replacement) records once, at its first step, with the move the player had used before the turn.

   The one case the memory can't settle is a turn-choice state whose view can't be built (an `AiError`). Then the fact is `unknown`, and if the AI chose Fight and the record would change the known moves, they are listed unknown (`PATHS.knownMoves(0)`) until the player's battler is replaced.
3. **Showdown and the cartridge name abilities and items in different places.**
   - **In the fold:** every Showdown naming of the player's ability or item is a reveal (see the table above), except the switch-in lines whose cartridge message tags no battler: Intimidate and Download, a blocked stat drop, Frisk, a form change and a status-curing ability. The AI's Trace reveals the player's ability (F1, "The first decision").
   - **Where they may differ:** the cartridge's message may not tag the ability for some events Showdown names. Suspected cases:
     - a Ground move against Levitate ("It doesn't affect…"; Showdown shows `-immune … [from] ability: Levitate`);
     - Truant (Showdown's `|cant|…|ability: Truant`, which the fold doesn't treat as a reveal);
     - Skill Swap, where Showdown's line doesn't name the player's ability the way the cartridge's message does;
     - Damp. Showdown's `|cant|` line names the Damp holder with `ability: Damp` and puts the blocked user in `[of]`. The fold skips that line, so the player's Damp is never revealed by it.
   - **The C boundary a spot check would settle:**
     - A message reveals only when its ability or item tag names a battler.
     - A tag built from `msgAbilityTemp` or `msgItemTemp` (`BTLSCR_MSG_TEMP`) doesn't call the AI setters (BS:11801–11802, 11745–11747).
     - So the exact rule is: a Showdown naming is a reveal when the cartridge's matching message tags the battler, not the stored name.
     - The fold can't see which tag the cartridge uses for the cases above, so it keeps treating those Showdown namings as reveals. The switch-in messages are read from their subscripts (F1).
   - **Quick Claw** is encoded: the cartridge shows only an animation, so it isn't a reveal.
4. **A move the AI's Magic Coat bounces.** The cartridge leaves `moveHit` unchanged (BCP:3073–3077). The fold sets `lastHitBy` from the player's `|move|` line, then undoes it when the reflected line appears. It relies on Showdown printing the player's move first and the reflection as `[from]move: Magic Coat`.
5. **The AI's item use.** Exact. The item action ends with the AI's `moveHit` cleared (`MoveEnd`, BCP:4389). The engine logs the item as `|-activate|p2a: …|item: X|[trainer]` (`src/engine/trainerItems.ts`), and the fold clears `lastHitBy` on that line.

The fold also assumes these Showdown forms:
- `[from]lockedmove` on a forced move (since item 3 it only keeps such a move as the battler's last move: whether the move was forced comes from the turn-choice state);
- `[from]move: X` on a called or reflected move;
- `|cant|…|Focus Punch` for lost focus;
- `[of]` naming the user on Damp's `|cant|` line;
- `[from] Pursuit` on a Pursuit at a switching Pokémon, and `|-activate|p2a…|item: X|[trainer]` for the AI's bag item.

`test/unit/ai/memory.test.ts` folds hand-written lines in all of these forms. The engine-run tests (`test/unit/ai/model.test.ts` and `adapter.test.ts`) fold the engine's own logs for moves, switches, faints, Trace, Transform, the trainer item, a Pursuit at a U-turn user, and a working and a failed Imprison. No test yet runs the engine on a locked move, a called or reflected move, a lost Focus Punch or Damp, so those four forms are still checked against Showdown's source only.
