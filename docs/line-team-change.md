# Changing the team during a line

The player, 2026-11-10: "When doing the line builder, I should be able to change Pokémon at any time. … If a Pokémon's
already in the line, obviously you can't remove them, but you should be able to replace Pokémon that aren't in line
yet."

## What the player does

- While a line runs, the line's header has **Change team**. It opens the team as a list in party order. Each Pokémon
  that is **in the line** is locked, with the note "in the line". A Pokémon is in the line once it has been on the
  field at any step of the shown path, the lead included. Each other Pokémon has:
  - **Replace with…**: any box Pokémon that can join the team (over the level cap too) and is not in it, at the level
    of its entry in the team panel (the save's when it has none); it joins with that entry, and a Pokémon that stays
    keeps the line's own;
  - **Remove**.
  **Add** puts a box Pokémon at the end while the team has fewer than 6.
- **Apply** rebuilds the line with the new team and keeps the player's path. It stops early only where a step no longer
  happens with the new team (see "The rebuild"); the page then says "The line now stops at step N: with this team it
  goes differently from there." The new team is the line's start from then on: the kept line, Copy line and Save tree
  all use it. Branches off the shown path are dropped, because they were worked out for the old team. The page says so
  before Apply when there are any.
- The Pokémon that are not in the line keep their party order. A replacement takes the replaced Pokémon's slot.

## The rebuild

The battle state holds the whole party, so every state after the change differs, and with it every outcome id. So the
rebuild starts a fresh line with the new team (same trainer, copy and world, and the team's draft: a start takes `{ trainerId, variant?, team, world?, draft }`, and a level, HP or status before the fight is set in the
draft) and walks the shown path again, step by step:

- **The player's choice:**
  - a move by its slot;
  - a switch by the Pokémon it names, mapped to that Pokémon's index in the new party (a Pokémon that was in the line
    is in the new party at its own place);
  - a level-up by the Pokémon it names, same level, same learned move and slot.
- **The outcome:** the outcome of the new expansion with the same signature, which is everything the player saw of it:
  - the AI's action label;
  - the summary lines;
  - the fainted Pokémon on both sides, by name;
  - who landed a crit;
  - whether it was a death.
  If exactly one outcome matches, it is taken. If none or several match, the rebuild stops there. AI-only steps that
  were taken automatically are taken the same way.

So a step stays only when, with the new team, it is still something that happens and looks the same to the player. Its
probability is worked out again over the new team. A change of bench can change odds that read the party: Roar and
Whirlwind's targets, AI checks on how many Pokémon the player has left, and a sixth Pokémon added. That is correct for the new
team, and the step shows the new odds.

Put the rebuild where the existing `LINE_LOST` replay and kept-line restore live (`web/src/useLine.ts`). Make it share
their walking code, with the matching rule passed in: id equality for a replay, signature equality for a rebuild. If a
server helper makes the signature exact (an outcome's `signature` string, built server-side from the fields above), add
it to the outcome JSON in `src/contracts/api.ts` (additions only).

## Not in this

- Changing a Pokémon that is in the line, the lead included: that is a new line.
- Reordering the Pokémon that are in the line.
- Gauntlets (one fight per line, as before).

## Tests

- Web unit tests (`test/unit/web/line.test.tsx`):
  - the Change team control locks the in-line Pokémon;
  - replace, remove and add;
  - Apply rebuilds and keeps the path;
  - a step that no longer matches stops the rebuild, with the notice;
  - branches are dropped with the warning;
  - the kept line and Copy line show the new team;
  - a switch step maps to the new index;
  - a level-up step is kept.
- Server: the signature, if one is added.
- Real (`test/real/line.test.ts`): Youngster Tristan with the frozen save's party, two steps in, replace a bench
  Pokémon that never came out. The rebuilt path has the same steps, with the same summaries and probabilities. The
  team in the start and the root's party show the replacement.
- No e2e test.
