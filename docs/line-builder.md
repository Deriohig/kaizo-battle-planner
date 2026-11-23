# Line builder

The player, 2026-11-09: "instead of focusing on solving … focus on what we have right now. … select a trainer, I'll get a
list of all of their Pokemon. That I can also then select from my Pokemon. The first starter, and then it will say what
comes next, what Pokemon comes out, what move gets played, and I can go move by move. So I can basically build a whole
line."

The line builder is a hand-driven walk over the same engine and trainer AI the solver uses. The player picks every one of his
own decisions and which chance outcome to follow; the page shows, at each step, the AI's exact odds and every outcome
with its exact probability. It proves nothing and searches nothing.

## What the player does

1. In the Fight tab, with a trainer (and copy) picked as today, a third tab **Line** sits beside Sheet and Plan.
2. The Line tab lists the trainer's Pokémon in party order with their full sets (level, nature, ability, item, moves),
   as the docs and ROM give them, and the player's team: the save's party in order by default, editable to any 1–6 eligible
   Pokémon from the box (the Fight view's own team choice when it is an explicit list; otherwise the save's party). Each
   Pokémon starts at the level, HP and status its draft entry in the team panel gives (there is no HP switch: "All to full HP" there heals the whole team, and each row's "Full" one Pokémon).
3. The player clicks **Lead with X** on one of his Pokémon. The battle starts: X leads, the rest of the team follows in order.
4. At each of the player's turns the page shows:
   - the matchup, headed with the turn and the step's number on its path (**Turn 6 · step 7**; the start is step 1): both
     active Pokémon (name, level, HP, status, stat stages, item and ability; for his, the EXP to the next level and "over
     the level cap (N)" above the cap); his HP reads "HP 51/61 · 83.6%", the trainer's as the game's 48-pixel bar then the HP
     (**HP bar 54.2% (28/50)**), with a muted line under the two: "Their HP bar is the 48-pixel bar the game shows. The HP
     in brackets is what the damage is worked out from."; the field (weather, Trick Room, Gravity, screens, hazards) as
     the engine has it; both parties (each Pokémon's HP, the trainer's in the HP bar form, and status, fainted ones
     greyed, his over the cap marked);
   - **Your choice**: the player's legal choices (`legalChoices(state, 'p1')`), each with its numbers before any click: a move
     with its PP and its damage, a switch with the HP of the Pokémon it sends in;
   - beside it, **Their reply**: the trainer AI's exact odds for its action this turn (`EnemyModel.support`), as labels
     ("Rock Slide 62.5%", "Switch to Onix 12.5%", "Full Restore 25%"), each with the exact fraction on hover, then each
     of their moves against his active Pokémon with its damage and the AI's share ("AI 0%" for one it never picks). The
     AI never reads the player's choice, so these odds are the same whatever he picks.
5. Clicking one of his choices shows that choice's outcomes, without committing. Above them, the choice's totals over
   every exact outcome: **Their Pokémon faints** (the trainer's active Pokémon faints this turn), **One of yours faints**
   (any of the player's faints; red when > 0), **They land a crit**. The outcomes are cards, one per story (`web/src/tree.ts`:
   the same summary with its percents blanked, faints, `death`, next phase, winner and EXP), likeliest first, each with
   its exact probability (the fraction on hover), what happened (from `Outcome.log`), the HP left as a range ("Imp HP bar
   29.2–39.6% (6–8/20) · Blaze 40/44"), the EXP paid, the damage rolls behind it, and a red foot naming who of his faints
   ("Blaze faints"). A crit says who landed it ("You crit Imp", "They crit Blaze"); one that changes nothing else is a
   line of its card ("You crit Imp in 12.5% of these"). Clicking another choice compares; nothing is recorded yet.
6. Clicking a card commits the choice and the card's likeliest exact outcome (the worst for the player on a tie); "Show the N
   exact results" lists every exact outcome of the card, each with its own odds, HP, rolls and crits and what the trainer
   picked ("The trainer picked Quick Attack"), and clicking one commits that one. The step is appended to the path and the
   next step shows.
7. AI-only steps (phase `enemyReplacement`, `enemyMidTurnSwitch`): the page says **Next the trainer sends out** with the
   AI's odds (`replacementSupport`) and works the step out by itself. When it has exactly one outcome, the player has nothing
   to decide: the page takes it and its outline row is marked **taken automatically**. With several, its outcomes show
   as cards to follow, as in 5. When working it out fails after a followed card, the banner says the followed result is
   in the tree, with **Try again**; coming back to that step later works it out, and if that is stopped the step offers
   one button, **Work out the trainer's next move**.
8. The player's own forced decisions (`playerMidTurnSwitch`, `playerReplacement`) show his legal switches. Reaching
   `playerReplacement` means one of his Pokémon fainted (this is a nuzlocke): the step's heading is **One of yours
   fainted: send out**, its outline row is marked **one of yours fainted** in the danger colour, and from there each step
   before the end shows a danger banner naming them ("Blaze fainted on this path."). The player may go on building it.
9. `terminal`: one block ends the path. A win, with a green stripe: **You win.** then "Nobody fainted." or "Fainted on
   this path: Blaze.", then who stands ("Standing: Bench 30/30."). A loss, with a red stripe: **You lose.** All of your
   Pokémon fainted.

The Fight view is the tree screen (`web/src/components/LineView.tsx`): the step, and beside it (below it
on a window narrower than 1180 px) the tree's outline. The step is `components/tree/MatchupHeader`, `YourChoice`,
`TheirReply` and `Outcomes`; the outline is `components/tree/Outline`; what needs no React (the cards, the exact odds,
the outline's rows) is `web/src/tree.ts`, the tree's state `web/src/useLine.ts`, and what is kept and copied
`web/src/line.ts`. The outline has a row for every step the player followed, under the step it was taken from, with its
step's odds and the path's from the root (the product of the cards followed, exact; "path ≈" from the first card that
stood for several exact results, with the one exact path's odds on hover; "path < 0.001%" has no "≈"), its marks (one
of yours fainted, You win, You lose, a level-up, taken automatically) and a line of totals for each choice worked out
there ("Scratch: their Pokémon faints 68.75% · one of yours faints 0% · they land a crit 0%"). The path to the step on screen
is open; every other branch is closed to its first row with "N more steps", and a toggle opens it. One click on a row
goes back to that step; choosing differently there starts a new branch, and the old one stays until **Clear tree**.
The outline scrolls in its own box (at most 70% of the window's height) and keeps the current row in sight.

The tree is kept in the browser (`localStorage` under `pkp.tree.current.<trainer>.<copy>`, wrapped in try/catch) per
trainer copy: the save it was built on, the start (trainer, copy, world, the team in order with each member's draft
entry and Pokémon key), the path shown (each step's choice and the followed outcome's id) and the paths to up to 24
other branches. **Save tree** names it (`pkp.tree.saved.*`); saved trees list under the start screen; **Copy path**
copies the path shown as plain text, one row per step (a step where one of his fainted ends " (one of yours faints)"), e.g.

```
Roark (copy 1) — Infernape, Staraptor, Kadabra
Turn 1: Infernape Close Combat · Geodude Rock Slide (62.5%) → Infernape first, Close Combat 100% → Geodude fainted · path 62.5%
Roark sends out Onix (100%)
…
```

A step where the player won offers the **Next fight** under the matchup (`components/tree/NextFight`): the
split's next single battle, or another single battle of that split or the next one and its copy, a **Heal first** box
(full HP and PP, no status), the team as the win left it (HP and status, or healed), who fainted and is left behind, and
"Lead with X" for each Pokémon still standing; a win reached through a card of several exact results says the team
carries this one's HP and PP. The click keeps the carried tree as that trainer copy's current tree (replacing the one
kept there, which the offer says first) and opens that fight as a click in the strip would, moving the cursor by the same
rule. A carried tree opens through `POST /api/line/next` and says where its team came from in a banner
(`components/tree/CarriedNote`), with who was left behind, that the team panel is not used and the odds start again at
100%, and **Back to …** (naming that trainer), which opens the fight before at its own kept tree. The team panel stays the draft: a
carried tree has no **Change team** and no "another team" or "edited" line, and Matchups says it uses the team panel. What
is kept of a carried tree is its whole recipe: an empty draft, the next fight's team (lead first, with each Pokémon's key)
and `carried`: the fight before's start (itself carried or not), the path to the won node, the server's line and node,
and the heal. When the server has lost that line the page replays the fight before and asks again; on another save every
level follows its Pokémon by key (none of its old lines is asked: they are the old save's) and the fights before are
replayed there. A fight before that no longer goes that way is said in one sentence, which starts "Your save changed"
when the tree was built on another save, and nothing kept is touched; a Pokémon of the chain, at any level, that is not
in the save is said the same way before anything is replayed.

## Server

`src/server/lines.ts` holds the line service; `app.ts` adds its routes. Its deps are injected like the sheet AI's
(`ServerDeps.lines`, built in `main.ts` from `baseDeps`), and the tests inject fakes.

- `POST /api/line/start` `{ trainerId, variant?, team: MonRef[] (lead first, 1–6), world?: number, draft: DraftMonJson[] }`
  → the root node. The battle is built exactly as the solver builds one (`src/solver/arena.ts:264`,
  `battleInput`): the resolver's fight (`createResolver`, src/integration/resolver.ts — field via `fieldSpec`, worlds via
  `fightWorlds`), the team as `PlayerMon`s with the draft's edits (as `teamParam` takes them; an empty draft is the save's
  team as it is), the world by index (default 0, the listed values). A level, HP or status before the fight is set in the
  draft: the start takes no `hp`, `levels` or `startStatus`, and a body with any of them is a 400 saying to
  reload the page. The memory is `enemyModel.initialMemory(state)`. The node also lists the worlds when
  there are more than one, each described by its disputed values ("Geodude: Jolly"), so the page can offer a picker.
- `GET /api/line/node?line=&node=` → a node.
- `POST /api/line/expand` `{ line, node, choice?: Choice }` → the outcomes of the step from that node: with the player's
  `choice` at `turnChoice` (for each AI action in `support`, `expandTurn(state, { p1: choice, p2: action })`), with
  his choice alone at his own switch phases, without one at the AI-only phases (each action in `replacementSupport`).
  Each outcome's probability is the AI action's times the outcome's, exact. Each outcome gets an id
  (a short hash of `state.key`, `observation` and `critBy`) and becomes a stored child node (state, memory after
  `enemyModel.remember(memory, outcome)`, parent, the step taken, whether a death happened on its path). The same
  expand twice answers from the store.
- `POST /api/line/next` `{ line, node, trainerId, variant?, world?, lead?: MonRef, heal?: boolean }` → the
  next trainer's root, from a node that ends a fight the player won. The team is the won battle's, not the box's or the
  draft's: each Pokémon still standing carries its HP, PP, status, item, EXP, level and moves as that node left them
  (the engine's `carryOut`), in the won fight's order, or with `lead` first and the others in that order. With
  `heal: true` each starts at full HP and PP with no status, keeping its item, EXP and moves. A fainted one is left
  behind: it is not revived by the heal and cannot lead. The new root says where the team came from, `carried: {
  fromLine, fromNode, dropped }` (`dropped`: the fainted, by page name, in the won fight's order), and its odds start
  again at 100%. The won line is not changed. A key the request does not have is a 400 ("heel is not part of a
  next-fight request"), as the sheet's request refuses one, so a misspelt `heal` cannot start the fight unhealed.
  Refusals: 400 for a bad body; 404 for an unknown trainer (checked first,
  as the start checks it); 404 `LINE_LOST`; 422 "Next fight starts from a fight you won: this step is not the end of
  one"; 422 with the engine's words for a won state it cannot carry; 422 "Double battles can't be built yet"; 400 for
  a `lead` that is not standing; 400 for a world the fight does not have.
- A node JSON: `{ line, node, turn, phase, dead (a death on the path), view, aiOdds? | aiError?, choices?, terminal?,
  unmodelled: string[] }`; an outcome JSON: `{ id, node, probability: { num, den } as strings, percent, aiAction
  (label), summary: string[], endHp, faints: { p1: names, p2: names }, death: boolean, enemyCrit: boolean, unlabelled }`;
  an expand also returns the totals of item 5. Types go in `src/contracts/api.ts` with the other page JSON.
- Labels use the solver's labeler (`createLabeler`) for choices; the summary is a small formatter over the standard
  Showdown protocol lines in `Outcome.log` (`|move|`, `|-damage|`, `|-heal|`, `|-crit|`, `|-miss|`,
  `|-supereffective|`, `|-resisted|`, `|-immune|`, `|-status|`, `|-curestatus|`, `|-boost|`, `|-unboost|`, `|-item|`,
  `|-enditem|`, `|-ability|`, `|-activate|`, `|faint|`, `|switch|`, `|drag|`, `|-weather|`, `|-fieldstart|`,
  `|-sidestart|`), damage as a percent of max HP; any other line is skipped.
- Errors: an `AiError` (`UNDEFINED`, `DIV_ZERO`) is the node's `aiError`, shown as "The AI's behaviour is undefined here
  (…)", and that node cannot be expanded; an engine error (`UNSUPPORTED_DOUBLE`, `LIMIT`, `BAD_CHOICE`,
  `UNMODELLED_ITEM`) answers 422 with its message; a double battle cannot start ("Double battles can't be built yet").
  `unmodelledIn(state)` is listed on every node: "Not modelled in this battle: …".
- Storage: the server keeps lines in memory, bounded (a cap on stored nodes across all lines, oldest line evicted
  first; measure a node's size on a real fight and set the cap so the store stays under about 300 MB). An unknown line
  or node answers 404 with code `LINE_LOST`; the page then replays the saved path (start, then each step's expand and
  the outcome with the same id) and carries on. A data reload clears the store.
- Each expand yields to the event loop between AI actions, as the sheet AI does between pairs, so the server keeps
  answering.

## Not in this

No proof, no search, no ranking of the player's choices, no damage calc table (the Sheet tab has it), no doubles, no
gauntlets (one fight per line), no e2e test.

## Tests

- Unit (`test/unit/server/lines.test.ts`): the line service over the solver's toy engine and toy AI
  (`test/unit/solver/toy`), or small fakes: start, expand with and without a choice, the probability product, ids
  stable across two runs, the store's reuse, the death flag on the path, `playerReplacement` as death, the AiError
  node, an engine error as 422, `LINE_LOST`, eviction.
- Unit: the log formatter on recorded protocol lines.
- Unit (web, `test/unit/web/line.test.tsx`, as `box.test.tsx` does): the start screen, a choice's outcomes, commit,
  going back, the auto-step, the death marker, `LINE_LOST` replay, copy text.
- Real (`test/real/line.test.ts`): Youngster Tristan (`roark-split/youngster-tristan/1`) over the frozen save: start
  with the party's lead, expand one move, the outcome probabilities sum to exactly 1, commit the likeliest, reach the
  next turn.
