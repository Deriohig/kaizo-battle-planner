# The trainer AI's differential fixtures

`test/real/aiFixtures.ts` holds hand-made battles for the reads the sweep's corpus (`test/real/aiCorpus.ts`) reaches rarely
or never. Each runs on the real ROM data and the real AI script, is driven by `expandTurn` to the situation it names, and
records what the corpus records: the AI's `support` (or `replacementSupport`) at every state and `remember`'s memory key at
every outcome. The records are the golden file's `f/<name>/…` keys; `aiDifferential.fixtures.test.ts` compares them.

## Keys

- `f/<name>/0`: the root (`initialMemory`, then `support`).
- `f/<name>/<t>.<j>`: outcome j of step t: `remember` of the step's start memory and the outcome, then the decision at that
  state (`support` at a turn choice, `replacementSupport` at an enemy replacement or mid-turn switch, `-` for the player's
  phases). A step with more than 8 outcomes is followed at 8 spread evenly, plus the outcome the fixture goes on from (the
  likeliest, or the likeliest whose log matches the step's `want`).

A step throws, and the generator fails, when its choice is refused or no outcome matches, so a fixture that stops reaching
its situation can't quietly record another one.

## What the engine refuses (findings)

A fixture whose battle has a non-empty `unmodelledIn` is not recorded (a finding, not a case to fake). `unmodelledIn` lists a
move that is anywhere in the battle's sets or move slots, so merely knowing the move is enough. `REFUSED` in `aiFixtures.ts`
keeps each such fixture, and `aiFixtures.test.ts` checks that it is still refused for the stated reason; when the engine
models the move, that test fails and the fixture moves to `FIXTURES` (then `--add` records it).

| Fixture | What the engine says |
|---|---|
| `transform` | does not model Transform (what it copies is unchecked against Showdown) |
| `bugbite-recycle` | does not model Recycle (the cartridge's `recycleItem`, a berry Bug Bite took included); the Bug Bite half is `bugbite-berry` |
| `twoturn-ai-fly` | does not model Fly (the flying turn's exceptions are by move ID in Showdown, by ROM effect on the cartridge) |
| `twoturn-ai-shadow-force` | does not model Shadow Force |
| `futuresight-ai` | does not model Future Sight (damage at use and no STAB on the cartridge) |
| `trace-worryseed` | does not model Worry Seed |
| `trace-roleplay` | does not model Role Play |

## The hack's data

- The hack has no Taunt (move 269 is Hidden Power Dark) and no Skull Bash, Spit Up, Heal Block, Trick, Snatch, Nightmare or
  Rapid Spin. "Encore, Disable, Taunt and Torment together" is Encore, Disable and Torment; no fixture can hold Taunt.
- Dig, Dive, Bounce and Sky Attack are one-turn moves in the hack (ROM effects 0, 0, 6, 262), so the two-turn moves it has
  are SolarBeam, Razor Wind, Fly and Shadow Force (the last two refused above).
- PP is low (Swords Dance 2, Rain Dance 1, Tail Whip 1): the fixtures' filler move is Growl (40 PP).
- A Choice lock leaves the other moves invalid but one valid, so `fightKind` is `menu`, not forced: the forced turn facts
  come from Struggle (`imprison-struggle`, `restrictions`, `choice-disable`), Encore (`encore-lock`, `restrictions`), the
  charging turn of SolarBeam and Razor Wind (`twoturn-ai-*`) and Uproar (`uproar-ai`).

## The trainer behind a fixture

The engine reads the AI flags and the bag by the trainer's ROM index, so a fixture takes ROM trainer 1 (flags Basic,
EvalAttack and Expert, no bag; `NO_BAG`) or 261 (the same flags, a bag of two of item 23; `BAG`) and puts its own party in.
The Pokémon are the real ROM's species with the stated abilities (not checked against the species' own).

## Regenerating

`npx tsx test/real/aiDifferentialGolden.ts --add` (through `pkp-heavy`) adds the keys the golden lacks and keeps every
existing record. Run it only on code whose decisions are the reference.

`--add --fixtures` skips the sweep's cases (the file already holds them) and runs only the fixtures, for a change to a
fixture: delete its old `f/<name>/` lines first.

## Situations worth knowing

- `outrage-no-lock`: the hack's Outrage has no lock (ROM effect 48: recoil, no rampage), so the AI repeats it with `menu`
  turn facts.
- `status-thunder-wave-on-player` uses a Tyranitar as the player: Garchomp is Ground and the Thunder Wave would be blocked.
- Pursuit: the engine fires an awake player's Pursuit before the U-turn user leaves, so `pursuit-hits-uturn-user` reaches the
  Pursuit hit and the mid-turn decision with no Pursuit queued. `pursuit-queued-asleep` keeps the Pursuit queued (the player is
  asleep) at the switch, as the unit test in `test/unit/ai/model.test.ts` does, and the AI decides that state: TryPursuit
  doesn't run a sleeping user's Pursuit either (BS:6902), so `powerMul` is 10 and the U-turn user's HP the state's.
- `aiTraced` is cleared only by an `-ability … [from]` line that isn't a Trace (Role Play and Worry Seed: refused above), a
  switch-in or the replacement; `trace-gastro` shows it kept through the faint (Gastro Acid suppresses, not replaces) and gone
  at the next switch-in.
- `stockpile-2`: the hack's Stockpile is ROM effect 206 (Defense and Sp. Def up), so no counter is kept, on the cartridge or
  in the engine; no hack move has the Stockpile effect.

## What the read ledger still lacks

`test/real/aiReadCoverage.test.ts` (run by `npm run test:ai-read`) requires every read field, mask bit and counter to take
two values over the corpus, and five booleans per battler too. Its allow-list marks sixteen rows as THIN: reachable on
this engine but in no corpus state. Each needs
a new fixture, whose records are then added with `--add` (the corpus's states feed the view oracle and the golden file,
so a ledger-only walk would fake the coverage):

| Row | Fixture that would reach it |
|---|---|
| `fieldConditionsMask` UPROAR, battler 0 | `uproar-player`: the player's Uproar |
| `mons.roosting` | `roost-player-uturn`: the player Roosts first, then the AI U-turns (Roost's flag lasts the turn, so only a mid-turn decision sees it) |
| `statusVolatile` FLINCH | an AI U-turn with King's Rock or Razor Fang that flinches the player; the flinch is silent in the log until the player would move, so the step must pick its outcome by state, which `Step.want` can't yet |
| `statusVolatile` FOCUS_ENERGY | `focusenergy-ai`: Focus Energy (move 116) |
| `statusVolatile` FORESIGHT | `foresight-player`: Foresight (193) or Odor Sleuth (316) |
| `moveEffectsMask` GRUDGE | `grudge-ai`: Grudge (288) |
| `moveEffectsMask` MIRACLE_EYE | `miracleeye-player`: Miracle Eye (357) |
| `moveEffectsMask` POWER_TRICK | `powertrick-ai`: Power Trick (379) |
| `moveEffectsMask` LOCK_ON | `lockon-ai`: Lock-On (199) or Mind Reader (170) |
| `effects.flashFire` | `flashfire-ai`: a Fire move into the AI's Flash Fire holder |
| `roosting`, battler 1 | `roost-ai-uturn`: the AI Roosts first, then the player U-turns (the player's mid-turn switch, which the corpus visits) |
| `effects.flashFire`, battler 0 | `flashfire-player`: the AI's Fire move into the player's Flash Fire holder |
| `protectChainKnown`, battler 0 | `sleeptalk-protect-player`: the player's Sleep Talk calls Protect (the player uses no bag item, so this is its only ambiguity) |
| `effects.canUnburden`, battler 0 | `unburden-player`: the player's Unburden holder loses its item |
| `roosting` and `effects.flashFire`, battler 0 and 1 | as their both-battlers rows above |

The rest of the allow-list can't be reached on this engine: singles (`battleType`, `helpingHand`), the HP stage, an effect no
hack move has (Recharge, Rage, Nightmare, Defense Curl, Bide, Thrash's lock, Dig, Dive, Mud Sport, Water Sport, Heal Block,
Yawn's delay, Taunt, Stockpile), or a move the engine refuses (Fly, as `twoturn-ai-fly`; Charge; the player's Transform,
which no corpus player knows and the engine refuses, as `transform`).
