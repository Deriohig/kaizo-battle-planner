# Trainer AI: spot checks the diff can't settle

These items are the list of spot checks. Each one is something `docs/ai-changes.md` reads from the bytes or infers but can't prove. Each item says what to check, how, and what the diff predicts.

## Overlay 16's changed functions

Overlay 16 is now compared function by function (`docs/ai-changes.md`, "Overlay 16 and the code around it, by function"). Exactly four functions changed. Their names and boundaries come from the command tables and the source order. What each change does is read from the bytes, so these items check the readings. None of the four is a function overlay 14 reaches, but each one changes what the planner simulates.

1. **Hurricane's weather accuracy**: `BattleControllerPlayer_CheckMoveHitAccuracy` (battle_controller_player.c:2865, vanilla 0x13DE0) and `BattleControllerPlayer_CheckMoveHitOverrides` (:3001, vanilla 0x14134). Both are named from their caller's calls; each grew by 4 bytes, at vanilla 0x13EF8 and 0x14216.
   - **How:** use Hurricane in sun, and again in rain.
   - **Prediction:** about 50% accuracy in sun; it never misses in rain, as Thunder does. If it behaves otherwise, the two inserted compares mean something else.
   - **The engine** already has this rule (`src/engine/mod/accuracy.ts`).
2. **The battle-start field effects**: `BattleSystem_TriggerEffectOnSwitch` (battle_lib.c:3649, vanilla 0x1B2D4, named by count). It grew by 20 bytes, and the nine changed regions from 0x1B2F0 to 0x1B638 all lie in it.
   - **What the bytes show:** the field-weather switch (:3664) now takes map weathers 0 to 18, not 0 to 15:
     - weather 12 (`OVERWORLD_WEATHER_SPIRITS`) runs subscript 297, which vanilla doesn't have. It plays Gravity's animation and starts Gravity.
     - weathers 17 and 18 run the harsh-sun and Trick Room subscripts (294 and 295), which only weathers 1001 and 1002 ran in vanilla.
     - The other changed regions are the function's jump tables, branches and literal pool, laid out again around the 20 new bytes. The two apparently new `BattleContext` offsets are vanilla's own literals (0x2D8C is in vanilla's pool too).
   - **How:** fight a trainer whose field note is Gravity, one with Trick Room and one with sun. Read `fieldConditionsMask` on turn 1, and watch the message before the first move.
   - **Prediction:** Gravity, Trick Room or harsh sun is on from the first turn. Gravity and Trick Room never end, because subscripts 238 and 251 re-arm them (item 8). Then check sun against a weather ability.
   - **Why:** this overlaps permanent weather against weather abilities and item 23 (the field note).
   - **What the AI sees of them:** these map-weather cases reach the AI only through the trainer's field note. Neither the engine nor the decompilation has them, or subscript 297.
     - **`initialView`** applies the note itself: sun as `FIELD_CONDITION_SUNNY_PERM`, and Trick Room and Gravity at their starting counters, and fog as the deep fog bit (`src/ai/initialView.ts`, `fieldOf`); nothing is listed. The other switch-in effects come from the engine (`src/ai/switchIn.ts`).
     - **The engine path** shows the note's conditions, as the engine applies them at battle start (`src/ai/read/showdown.ts`, `fieldMaskOf`; item 23), and the fog from the note (read through the engine's `battleField(state)`, `fieldNoteOf`) and the memory (item 20).
     - **Without a note:** a battle whose map weather starts the effect with no field note is missed by both.
3. **Obedience**: `BattleControllerPlayer_CheckObedience` (battle_controller_player.c:2109, vanilla 0x12FFC, named by count). Its one changed halfword is vanilla 0x13090; `test/real/aiChangesDoc.test.ts` pins that.
   - **How:** with fewer than 8 badges, use a traded Pokémon above the badge level cap.
   - **Prediction:** it always obeys, because the "8 badges" test now always passes.
   - **Note:** this isn't AI. Showdown has no disobedience, so the engine already matches.

## Unchanged AI code meeting the hack's moves

Overlay 14 is unchanged apart from relocations. So the AI's C code is vanilla, but it now runs on the hack's move table. These results follow from the code, but they're surprising enough to confirm once in game.

4. **The AI estimates Triple Axel as Psywave.**
   - **Why:** `TrainerAI_CalcDamage` switches on move ID 149, which is Psywave's ID and now Triple Axel's (trainer_ai.c:3014). The estimate is `level × (rand % 11 + 5) / 10`, which costs one RNG draw.
   - **How:** give an AI Pokémon with Triple Axel a target that Triple Axel's real damage would KO but `1.5 × level` would not, or the reverse.
   - **Prediction:** the AI's kill bonuses follow the Psywave estimate.
5. **The AI estimates Bulldoze as Magnitude.**
   - **Why:** move 222 was Magnitude, so the estimate rolls a power of 10 to 150 from Magnitude's table (trainer_ai.c:3028).
   - **How:** as item 4.
6. **The "1/2 recoil" moves.** Hyper Beam, Giga Impact, Draco Meteor, Outrage, Superpower and Hydro Cannon now have effect 48.
   - **Prediction:** they follow `Expert_RecoilMove`: +1 for a Rock Head or Magic Guard attacker, and no change if the target resists. Unlike vanilla's Hyper Beam, the AI now damage-scores them.
   - **Why it needs a check:** the tab's "bugged targeting" fix isn't in the AI script or in overlay 14. If the AI's choices with these moves differ from this prediction, the fix lives somewhere this diff didn't look.
7. **The "1/4 recoil" moves.** Take Down, Close Combat and Brave Bird now have effect 182, so they follow `Expert_Superpower`.
   - **Prediction:** at most −1 in total, from the first of four conditions that holds. The extra condition, which the tab doesn't list, is the attacker's Attack stage below neutral.
   - **Also:** the AI never damage-scores these moves, because effect 182 is in `sNoDamageCalcMoveEffects`.
   - **How:** use a lowered-Attack AI Pokémon that is faster and at low HP. The tab's conditions predict no −1; the routine predicts −1.

## Not diffed

8. **The ARM9 binary and the other overlays.**
   - **Now diffed** (`docs/ai-changes.md`, "The other binaries"):
     - **Overlay 12** (battle animations) is identical.
     - **Overlay 13** (the battle bag and party menus) differs only by 25 BLs into overlay 16 that reach the paired function.
     - **The ARM9 binary** is compared in place, since both copies are the same size. It has 161 changed regions; 2 are pointers that follow overlay 16's growth. Its C code is laid out and named between pret's address-named files, and none of the 705 ARM9 functions that overlays 14 and 16 reach changed. The battle-relevant change is `TrainerData_BuildParty` (items 8a and 8b). The rest is field, menu and boot code, map headers, the TM list and two item icons.
     - **`sSideEffectSubscripts`** is identical, entry for entry. So is the rest of overlay 16's data, apart from pointer relocations and 4 bytes of padding.
   - **The battle scripts were diffed** (`test/real/aiBattleScripts.test.ts`). Every member of `battle/skill/be_seq.narc` (the move effects), `sub_seq.narc` (the subscripts) and `waza_seq.narc` (each move's entry script) was compared with vanilla's:
     - `waza_seq.narc` is identical.
     - Five effect scripts differ: 48 (its recoil now goes through side-effect pointer 138), 88 (a three-hit script), 104 (Triple Kick's, now reading the move's power), 141 (unused in vanilla, now a hit-during-Fly confusing move) and 182 (Superpower's, now a recoil move's). `src/ai/battleScripts.ts` puts them in both of its sets, as a sound over-approximation.
     - Three subscripts differ: 238 (`subscript_gravity_end`) and 251 (`subscript_trick_room_end`), which now re-arm Gravity and Trick Room, and 297, new (the switch-in field effect of item 2). A raw scan finds no effect that calls one, and no write to `battleStatusMask`'s AI-read bits or to `powerMul` in them.
   - **The C side of the scripts is diffed too:** all 223 `BtlCmd_*` handlers, the 45 controller steps and the 67 battle IO commands are unchanged up to relocations, and each table entry points at the paired function.
   - **Still not diffed:**
     - the code the hack loads to 0x023C8000 at boot. Only the ARM9 calls it, from the party menu, the summary screen and script commands; overlays 12 to 16 never do.
     - the data files other than the battle scripts and the move table, such as `itemtool/itemdata/pl_item_data.narc`, which differs.
     - the names of 2 overlay 16 functions and 1,722 ARM9 functions, where the counts disagree. Their bytes are still compared.
     - a data word in overlay 16 that kept its vanilla value while the data it points at moved. It would align as unchanged. The diff doesn't re-check such words, because a lone data word can look like a pointer by chance. The command tables are the exception: they are checked entry by entry.

8a. **Trainer natures after an override**: the hack's ARM9 `TrainerData_BuildParty` (trainer_data.c:176, ARM9 0x020793B8, named by count) is rewritten (`docs/ai-changes.md`, "The hack's `TrainerData_BuildParty`: inferred").
   - **What the bytes seem to show** (my reading of the disassembly, not yet confirmed): the PID is vanilla's, `(rnd << 8) + genderMod`. An entry's override byte changes `genderMod` first:
     - gender 1 or 2 (low nibble) sets it to the species' gender ratio + 2 or − 2;
     - then ability 1 or 2 (high nibble) clears or sets bit 0. With a gender override, that bit is of the new `genderMod`. **With an ability override alone, the helper stores `species & ~1` or `species | 1` into `genderMod`.**
     - `genderMod` is never reset, so every later entry in the party keeps the changed value.
   - **How:** read the enemy party's PIDs and natures in RAM (PKCalc's PKLuaScript) for three entries: one with only an ability override, one with a gender override, and one with no override after either of them.
   - **Prediction:** each PID is `(rnd << 8) + genderMod`, with `genderMod` as above.
     - **Check the ability-only override first.** `genderMod` there becomes the species ID with bit 0 forced. That is surprising and probably a hack bug (HGSS's rule works on `genderMod`). It is also the case most worth checking: if it holds, it decides the natures of every ability-only override and of every later entry in those parties.
     - `src/rom/trainers.ts` marks these entries `natureKnown: false`. Once confirmed, this rule would derive them.
8b. **Trainer friendship**: a helper the hack's `TrainerData_BuildParty` calls (ARM9 0x02079570).
   - **What the bytes seem to show** (inferred): the helper sets friendship to 255, then to 0 when any of its four reads of the Pokémon returns 218 (Frustration's move ID).
     - Only the first read is certain to be move 1 (`MON_DATA_MOVE1`). The field ID (54) is set before the loop and not reloaded after the call to `Pokemon_GetValue`, so the field IDs of reads 2 to 4 are undetermined.
   - **How:** read `BattleMon.friendship` for trainer Pokémon: one with Frustration in slot 1, one with it in a later slot, and one without it.
   - **Prediction:** 0 with Frustration in slot 1. Otherwise 255 is likely, but 0 is possible: Frustration in a later slot, or any undetermined field that happens to read 218, can make it 0. Item 22 and `src/engine/sets.ts` give a trainer Pokémon its species' base friendship instead. In battle this changes nothing known: in this hack Return and Frustration are plain 121-power hits (effect 0).

## What the AI remembers

`src/ai/memory.ts` rebuilds the AI's knowledge from the engine's battle log. These are the approximations listed in `docs/ai-reads.md`. Each one is checked most directly by watching `AIContext.battlerMoves`, `battlerAbilities` and `battlerHeldItems` (ai_context.h) in an emulator's memory viewer. Find them with a RAM search for a move ID the player has just used.

9. **Encore and locked moves.**
   - **How:** Encore the AI's Pokémon. While the Encore lasts, use a new move each turn.
   - **Prediction:** none of those moves enters `battlerMoves[0]` during the Encore (battle_controller_player.c:443). The fold now agrees (the force is a fact of the turn-choice state). The check confirms the C reading.
10. **The AI faints before acting.**
    - **How:** use move X on turn 1. On turn 2, knock out the AI's Pokémon before it moves while it has chosen to fight.
    - **Prediction:** X is in `battlerMoves[0]` afterwards, because `TrainerAI_Main` ran at the start of turn 2. The fold now records it (item 3). The check confirms the C reading.
11. **Abilities named where the cartridge may not name them.**
    - **How:** hit a Levitate Pokémon with a Ground move, and loaf with Truant. Use a two-ability species, so that `LoadBattlerAbility` would otherwise flip a coin.
    - **Prediction:** check whether `battlerAbilities[0]` is set after each. The fold sets it for Levitate's immunity and leaves it for Truant.
    - **Also:** check Skill Swap, and a player's Damp blocking the AI's Explosion, the same way. The switch-in messages are item 25.
    - **What this settles:** a message whose tag is built from `msgAbilityTemp` or `msgItemTemp` reveals nothing (battle_script.c:11801–11802, 11745–11747).
12. **A move bounced by the AI's Magic Coat.**
    - **How:** the AI uses Magic Coat, then the player uses Toxic.
    - **Prediction:** `moveHit[1]` is unchanged by the Toxic (battle_controller_player.c:3073–3077).
13. **The AI uses a bag item.**
    - **How:** on turn 1, hit the AI after it moves. On turn 2, let it use a bag item while the player uses a move that doesn't target it, such as Swords Dance.
    - **Prediction:** `moveHit[1]` is cleared at the end of the item action (battle_controller_player.c:4389). The fold clears it on the engine's item line (`|-activate|p2a…|item: X|[trainer]`).

## The engine adapter

`src/ai/adapter.ts` (`viewFromState`) builds the AI's view from the engine's Showdown state: the Showdown source's read of the state (`src/ai/read/showdown.ts`), composed with the memory and the ROM data (`src/ai/read/compose.ts`). These are the view fields the AI reads that the state can't always give exactly; each is a `// GAP:` comment in one of the two.

**How each gap is handled.** A field the adapter can't derive is never read as a default. The view lists its path in `AiView.unknown` (`src/ai/lib/known.ts`, `PATHS`), and the code that reads it calls `requireKnown` first. That throws `AiError('UNDEFINED')`, so a decision that would read the field fails instead of guessing. The field still holds the adapter's best guess, for display only. Each item below says when the path is listed. Where the state does settle a field, the adapter derives it exactly, and the item says how.

Check each item by reading the named `BattleContext` or `BattleMon` field in an emulator's memory viewer at the AI's next decision. Once a check settles an item, the adapter can derive the field and drop its path.

14. **Recycle's item** (`recycleItem`, read by `LoadRecycleItem`). **Derived:** Showdown's `lastItem`, overridden by the memory's `recycleOverride`. Slots 2 and 3 are never written in singles, so they are exact.
    - **Why it derives:** Showdown's Gen 1–4 `lastItem` already follows the battler slot, as the cartridge's per-slot `recycleItem` does: a switch-in takes the outgoing Pokémon's (`sim/battle-actions.ts`, `switchIn`). Both are set by the same uses: a consumed held item, Fling and Natural Gift (`BtlCmd_RemoveItem`, battle_script.c:8978). Recycle clears both (:9005–9007). Of the `RemoveItem BTLSCR_DEFENDER` callers, Jaboca and Rowap Berry (`subscript_held_item_recoil_when_hit.s:17`) and Focus Sash (`subscript_move_followup_message.s:18`) remove the defender's own item, which Showdown's `eatItem`/`useItem` record too. Bug Bite and Pluck (`subscript_pluck.s:10`) record the eaten berry in the victim's slot, while Showdown's `takeItem` leaves the victim's `lastItem` alone: the memory keeps that berry from the `-enditem … [from] stealeat` line, until the slot uses up its own item.
    - **Listed** as `recycleItem.<b>` only when a Recycle or Natural Gift runs in a slot the memory overrides: the log can't settle what each side then holds.
    - **How:** let the player's Bug Bite eat the AI's berry, then have the AI consider Recycle or Embargo (script.s `Basic_CheckCanRecycle`, `Basic_CheckEmbargo`, `Expert_Recycle`), and read `recycleItem[1]`.
    - **Prediction:** the cartridge holds the berry, as the memory says.
15. **Imprison** (read by `BattleSystem_CheckInvalidMoves` and by the script's `IfMoveEffect`).
    - **The imprisoner's own bit, from Showdown:** `Move_Imprisoned` (battle_lib.c:3316–3336), the check that bans the AI's moves, reads the imprisoner's own `MOVE_EFFECT_IMPRISON` and its moves. The adapter takes these from Showdown's `imprison` volatile on the user and its move slots. Both sides set the bit only on a working Imprison and drop it at the switch-out (Showdown's `imprison` is `noCopy`, so Baton Pass doesn't pass it).
    - **The foe's mark, derived from the log (F3):** `MOVE_EFFECT_IMPRISONED` (bit 30), which `IfMoveEffect` and `IfNotMoveEffect` check when their mask holds the bit (script.s `Basic_CheckCanImprison`). Showdown keeps only the user's volatile, so the memory keeps the mark per battler slot (`imprisonedMark` in `src/ai/memory.ts`) and the adapter takes the bit from there.
      - **Set:** `BtlCmd_TryImprison` marks the user's foe before it checks that Imprison works (battle_script.c:6686–6692). In singles both slots it marks are `attacker ^ 1` (battle_system.c:419–421). It is the first command of Imprison's effect script (effect_script_0192.s:5), which runs once the move is past the before-move checks (battle_controller_player.c:3137–3219). So every `|move|…|Imprison` line marks the user's foe:
        - a working Imprison (`|-start|…|move: Imprison`);
        - a failed one (`|-fail|`: no shared move, or the user already imprisons);
        - one called by Metronome, Sleep Talk, Assist or Copycat (`[from]move: X`), whose caller runs the same script through `GoToMoveScript` (battle_script.c:2111–2130).
      - **Not set:** a move the before-move checks stop shows `|cant|` (sleep, paralysis, flinch, Disable, Taunt, the foe's Imprison and so on) or a confusion self-hit, and runs no script. `[notarget]` never shows on Imprison, which targets its user (battle_lib.c:1665–1669).
      - **Snatch and Magic Coat don't apply:** neither can take Imprison on either side. The ROM's Imprison has no `MOVE_FLAG_CAN_SNATCH` or `MOVE_FLAG_CAN_MAGIC_COAT` (flags 0 in both ROMs), and Showdown's Gen 4 Imprison has only `bypasssub` and `metronome`.
      - **Cleared:** only when a new BattleMon takes the slot.
        - A switch-in sets the mask to 0 (battle_lib.c:2071). That covers a forced switch (`|drag|`) and a U-turn.
        - Baton Pass keeps only `MOVE_EFFECT_BATON_PASSED` (battle_lib.c:2076), which lacks the bit (moves.h:46–48).
        - A faint sets the mask to 0 (battle_lib.c:2166). A mark set on a battler that has already fainted lasts until its replacement comes in.
        - The imprisoner leaving doesn't clear its foe's mark.
      - **Nothing else writes the bit.** In the decompilation's C only `TryImprison` sets it, and only the three lines above clear it. In its scripts, every write to `BATTLEMON_MOVE_EFFECTS_MASK` touches other bits. The hack's C side is item 8's.
      - **Pinned by `test/real/aiImprison.test.ts`, in both ROMs:**
        - move 286 is the only move with Imprison's effect (192);
        - the hack's effect 192 is vanilla's, and none of the hack's changed scripts holds `TryImprison` or a write that could touch the bit;
        - neither ROM lets Snatch or Magic Coat take Imprison.
      - **The battle start:** nobody is marked (`initialMemoryData`), since nobody has moved.
      - **Merged engine outcomes:** the lines the memory reads (`|move|`, `|switch|`, `|drag|`, `|faint|`) are on the player's screen, so the leaves the engine merges (same observation) agree on them.
    - **Listed:** never. No case is left that the log can't settle. `PATHS.imprisoned` keeps its guard in `IfMoveEffect`.
    - **Not settled here:** the imprisoner's own bit after its foe fainted earlier in the turn. `TryImprison`'s shared-move check reads every battler on the other side, a fainted one included (battle_script.c:6699–6719), because a fainted BattleMon keeps its moves until its replacement. Showdown's Gen 4 check reads `pokemon.foes()`, which skips fainted Pokémon. So an Imprison used after its foe fainted earlier in the turn can work on the cartridge and fail in the engine. The foe's mark is set either way. This is an engine difference, not the memory's, and no path lists it yet.
    - **How:**
      - Let the AI's Imprison fail (no shared move), then read the player's `moveEffectsMask`.
      - Let the AI switch out, and read it again.
      - Separately, let the player use Imprison and the AI switch, then read the new Pokémon's.
    - **Prediction:** bit 30 is set on the player after the failed Imprison, and is still set after the AI switches. It is clear on the AI's new Pokémon.
16. **Protect's chain** (`moveProtect` and `protectSuccessTurns`, read by `LoadProtectChain`).
    - **Derived** from Showdown's `stall` counter and `lastMove`, except where the state can't settle it. Then `moveProtect.<b>` and `mons.<b>.effects.protectSuccessTurns` are listed (`protectChainKnown`):
      - **After a bag item:** the AI's bag has a used slot, and the AI's last move protects or is Sleep Talk. An item turn runs no move, so the cartridge keeps `moveProtect` and the chain through it (`UpdateMoveBuffers` runs only for a move, battle_controller_player.c:3936–3942). A protecting move after it continues the chain (battle_script.c:5154–5158). Showdown's `stall` ends at the item turn's end. The state doesn't say when the item was used. Only the trainer uses bag items in the engine.
      - **A called Protect:** `stall` is live but the last move doesn't protect. Sleep Talk is the one caller that can call Protect, Detect or Endure (battle_script.c:4907–4934; Metronome, Assist and Copycat refuse them, battle_lib.c:7152–7179). `moveProtect` is then the called move, while Showdown's `lastMove` is Sleep Talk.
    - **A switch is no gap:** the switch-in clears both fields on the cartridge (battle_lib.c:2104–2120), as Showdown's switch clears `stall` and `lastMove`.
    - **How:** the AI protects on turn 1 and uses a bag item on turn 2; read both fields on turn 3.
    - **Prediction:** `moveProtect[1]` is still Protect, and the chain is 1, on the cartridge.
17. **Slow Start after Transform** (`slowStartTurnNumber`, read by Slow Start in the speed comparison and the damage formula). **Listed while the battler is transformed:** `mons.<b>.effects.slowStartTurnNumber`.
    - **Why:** Transform sets it to `totalTurns + 1` (battle_script.c:5360). Showdown doesn't record when a Pokémon transformed.
    - **How:** transform into a Slow Start Pokémon (Regigigas) after a few turns in, and compare speeds or the field.
    - **Prediction:** the cartridge halves the transformed Pokémon's speed for five turns from the Transform.
18. **Pokédex weight** (`weight`, read by Low Kick and Grass Knot).
    - **Derived exactly** from the ROM (`src/rom/weights.ts`). `BattleSystem_InitBattleMon` loads member 1 of the Pokédex data NARC as an `int` per species ID (battle_lib.c:145–153, pokedex_heightweight.c:126–130). `Pokedex_SetupGiratina` picks the NARC by the battler's form: `zukan_data_gira.narc` for form 0, `zukan_data.narc` for any other (pokedex_data_index.c:14–25). The cache keeps both tables (`AiRomData.weights` and `formWeights`). In both ROMs they differ only for Giratina: 7500 for Altered, 6500 for Origin. Transform copies the target's weight.
    - **Listed** as `mons.<b>.weight` only where the two tables differ and the form can't be read: a species `FORMS` doesn't list, or a transformed battler. Neither ROM has such a case.
    - **Cross-check:** `npm run test:real -- test/real/aiRom` prints where the hack's weights differ from Showdown's.
19. **IVs after Transform** (`ivs`, read for Hidden Power's type and power). **Listed while the battler is transformed:** `mons.<b>.ivs`. A party Pokémon's IVs are always known: Transform never changes the party data.
    - **Why:** Transform copies the target's IVs (battle_script.c:5346–5348). Showdown copies only its Hidden Power type.
    - **How:** an AI Ditto transforms into a Hidden Power user; watch the AI's Hidden Power scoring.
    - **Prediction:** the cartridge scores the target's Hidden Power type and power.
20. **Deep fog** (`FIELD_CONDITION_DEEP_FOG`). **Derived from the trainer's field note, and from the memory after the start:** the bit is set while the note's fog stands (`AiMemoryData.fog`, `src/ai/memory.ts`). **Listed only after a Defog** the log can't settle: `fieldConditionsMask.fog`. The guard stays for that case, and fires only where the result hinges on the fog bit (`anyFieldBit`): `LoadCurrentWeather`, `IfFieldConditionsMask` with a fog mask, and Solar Beam's halving without rain, sand or hail. Weather Ball's type doesn't hinge on fog: with fog alone or no weather it is `UNDEFINED` either way.
    - **Why it isn't the note's for the whole battle:** `subscript_overworld_fog.s:11` sets the bit at the battle start (`BattleSystem_TriggerEffectOnSwitch`, battle_lib.c:3685–3688), but it lives in `FIELD_CONDITION_WEATHER` (condition.h:132–137), so everything that sets a weather clears it first: the weather abilities (`subscript_drizzle.s:11`, `_sand_stream.s:11`, `_snow_warning.s:12`, `_drought.s:11`) and Rain Dance, Sunny Day, Sandstorm and Hail (`effect_script_0115.s:8`, `_0136`, `_0137`, `_0164`, each `UpdateVar FLAG_OFF FIELD_CONDITION_WEATHER`). Defog clears it too (`subscript_defog.s:64–65`). A weather's end clears only its own `_TEMP` bit. Nothing else mentions the bit (`grep DEEP_FOG src res`: the accuracy and message reads, the AI's, `battle_lib.c:7058`).
    - **How the adapter follows it:** the memory folds the log: a `-weather` line that sets a weather (an ability's, a move's) or the move Hail clears the fog; a Defog with the fog still standing makes it unknown (its script reaches the clear only past checks on the target's evasion and side conditions); a weather after that clears it. On the sheet path the bit is the note's, and a lead's weather ability clears it with the weather bits (`initialView`, `switchIn.ts` `switchInWeather`): nothing before the first decision can blow it away, so it is exact.
    - **The engine** holds the note's fog as a flag it never clears (`formatData.kaizoFog`, `mod/field.ts`; Defog is `unmodelled`), which its hit-rate and Solar Beam reads use; the AI doesn't read it.
    - **How:** fight a trainer whose field note is fog and read `fieldConditionsMask`; then use Rain Dance, or a Defog, and read it again.
    - **Prediction:** bit 15 is set from the first turn, until a weather is set (the bit goes, with the weather's own bits set) or a Defog runs.
21. **The speeds Gyro Ball reads** (`monSpeedValues`). **Derived:** the engine's `lastSpeedValues(state)`, the values its latest cartridge-formula compare wrote (at a turn choice, the turn start's sort, battle_controller_player.c:251, 263). The AI's own compares while it decides are the interpreter's run-local copies.
    - **Listed** as `monSpeedValues` only while a transformed battler with Slow Start is out: Transform resets `slowStartTurnNumber` (battle_script.c:5360) and the engine's compare doesn't (`src/engine/speedValues.ts`).
    - **How:** let a Speed Boost Pokémon boost at a turn end, then read `monSpeedValues` at the AI's next decision.
    - **Prediction:** the cartridge holds the boosted speed, as the turn start's sort wrote it, which is what the engine records.
    - **This turn's Quick Claw** (`quickClawThisTurn`) is read from the engine where it has picked the draw (`quickClawRolls(state)`): the same draw, so exact. Where it hasn't, the AI marginalises it at its prior, as before. The engine's roll is Quick Claw's `speedRand % 5 == 0` (param 20, the hack's too), so the roll is read only for a held item whose param gives `100 / param == 5`.
22. **Friendship** (`friendship`, read by Return and Frustration in the damage estimate). **Derived:** both `initialView` and the adapter take `BattleMon.friendship`; the engine sets each Pokémon's happiness from it (`src/engine/sets.ts`). Transform keeps the transformer's own (it copies the `BattleMon` only up to `ability`, battle_script.c:5346–5348).
    - **The data:** a trainer's Pokémon has its species' base friendship (Personal byte 0x12, which `Pokemon_InitWith` sets, pokemon.c:435–436; trainer_data.c never changes it). The player's is the save's (PK4 block A +0x0C).
    - **How:** read `friendship` for a trainer Pokémon with Return or Frustration.
    - **Prediction:** it is the species' base friendship (70 for most), as `BattleMon.friendship` gives it.
23. **The trainer's field note** (weather, Trick Room, Gravity, fog). **Nothing is listed** since the engine applies the note at battle start (fog: item 20): the weather as the `_PERM` bit (duration 0; `subscript_overworld_rain.s:11` and its kin), Trick Room and Gravity as conditions that never end (a counter of 1 in the engine path's view, `FIELD_CONDITION_*_INIT` in `initialView`'s; the AI only tests them for non-zero).
    - **Why:** the engine used to keep the note without applying it, and the AI listed what the battle didn't show; the guard and its paths (`FIELD_NOTE_PATHS`) are gone.
    - **Both paths agree:** `test/unit/ai/initialView.test.ts` checks that the sheet path and the engine path give the AI the same knowledge under each note weather, and `test/unit/ai/adapter.test.ts` that the engine path's mask is the note's. The sheet path also compares its field with the engine's battle (`switchIn.ts` `checkField`): the weather bits, the fog bit, and whether Trick Room and Gravity are up (not their counters), refusing by name (`turn-1 switch-in, Trick Room: …`) where they differ.
    - **The note** is read through the engine's `battleField(state)` (`fieldNoteOf`); a state `createBattle` didn't make has none, which is `BAD_VIEW`.
    - **How:** fight a trainer whose field note is rain, Trick Room or Gravity, and read `fieldConditionsMask` on turn 1.
    - **Prediction:** the note's bits are set from the first turn (rain as `FIELD_CONDITION_RAINING_PERM`).

## The turn-1 switch-in effects (F1)

`initialView` runs the leads' switch-in effects through the engine and checks each against the C (`src/ai/switchIn.ts`, `docs/ai-reads.md` "The first decision"). Every effect it takes from the engine has its C cited there. These items are what only the game can settle.

24. **Pinch items with parameter 0** (the hack's Ganlon Berry 202 and Apicot Berry 205, and Shoal Salt 70, now a pinch Attack item). **Applied by the engine**: the berry is eaten at battle start (`src/engine/mod/items.ts`, `pinchCheck`) and `initialView` takes the engine's result, checking its +1 stage against the C's. Before, it was refused (153 of the sweep's 5361 decisions).
    - **Why:** the pinch check, `curHP <= maxHP / itemPower` (battle_lib.c:5201, 5214, 5253), divides with `_u32_div_f` (ARM9 0x020E2178, the overlay-16 diff), and x/0 = x there. So with parameter 0 the check reads `curHP <= maxHP`, and the berry is eaten at the holder's first switch-in check (battle_lib.c:4151–4155), as long as the stat can still rise. The engine models that, so the AI's view takes its state; Shoal Salt is `HOLD_EFFECT_PINCH_ATK_UP` (+1 Attack), Ganlon Berry Defense and Apicot Berry Sp. Def.
    - **How:** send in a Ganlon Berry holder at full HP.
    - **Prediction:** it eats the berry and gains +1 Defense before the first move.
25. **What the switch-in messages tell the AI** (`battlerAbilities[0]` and `battlerHeldItems[0]`, read through `LoadBattlerAbility`, `CheckBattlerAbility`, `LoadHeldItemEffect` and `IfHeldItemEqualTo`).
    - **The C reading** (`docs/ai-reads.md`, "The first decision"): the player's Intimidate, Download, Frisk, Forecast form change, a status-curing ability and a Clear Body block reveal nothing; the AI's Trace reveals the player's ability; Pressure, Mold Breaker, Slow Start, Anticipation and Forewarn reveal the holder's. A weather ability reveals the holder's only when its subscript runs: when its own `_PERM` bit is clear (battle_lib.c:3746–3782). Into the field note's same weather, or after an earlier holder of it, it reveals nothing; over another weather, or over a move's weather of the same kind (a `_TEMP` bit), it reveals. A weather move sets its `_TEMP` bit only when its weather's `_PERM` bit is clear (`effect_script_0136.s:5` and its kin), except Hail, which tests only `HAILING_TEMP` (`effect_script_0164.s:5`) and so turns a `_PERM` hail into a `_TEMP` one; nothing else ends a `_PERM` weather.
    - **How:** lead with a two-ability species whose ability is one of these, against an AI whose script branches on the ability (`LoadBattlerAbility`), and watch `battlerAbilities[0]` in a memory viewer. For Frisk, lead the AI with a Frisk Pokémon and watch `battlerHeldItems[0]`.
    - **Prediction:** as the C reading says. In particular, Frisk's find stays unknown to the AI (`subscript_frisk.s:7` tags `BTLSCR_MSG_TEMP`), and a Drizzle lead against a permanent-rain trainer (a rain field note) stays unknown too.
