# How the solver works

The solver (`src/solver`) takes a fight (or a gauntlet of fights), a team and a time budget, and answers with a
verdict: a line that is proven safe (tier 1), a line that can only die to enemy crits (tier 2), the line with the lowest
exact death chance (tier 3), or "unproven" with the reason. This page explains it in plain language. The code comments
carry the details.

## The pieces

**The arena.** The solver plays the battle on the engine. One *member* is an exact battle state plus what the trainer
AI remembers. When the player picks an action, the arena works out every way the next step can go: every action the AI can
pick (with its exact odds), every damage roll, crit, miss, speed tie and so on, enemy replacements included, until the player
has to decide again. Each way is a *successor*: a win, a death, an unlabelled outcome (a random draw the engine could not
name), or the next decision. Any faint on the player's side is a death; a simultaneous final KO is a death too.

**Beliefs.** the player cannot see everything: enemy HP shows as a bar, sleep counters are hidden, disputed natures and
abilities give several candidate *worlds*. A *belief* is the set of exact members the player cannot tell apart, because they
share everything he has seen. The solver picks one action per belief, never per member, so a plan only ever depends on
what is on screen. In RAM mode (a later option) each belief is one exact state.

**Tier 1, the proof search.** An AND-OR search over beliefs: at the player's decision one action must work (OR); for that
action, every AI action and every chance outcome in every member must lead to a win (AND). It deepens the horizon one
turn at a time up to the request's limit. A line that can loop back to a position already on the search path fails
(the AI could repeat it forever).

**The caching rule.** Positions repeat, so results are stored by exact key. A win within d turns is reused with at least
d turns left. A failure is stored only if it did not depend on positions higher up the search path; a horizon failure
is reused only with as few or fewer turns left. Running out of time is never stored. This keeps every reuse exact.

**Ranking.** Once a tier-1 line exists, better ones are looked for by proof, never by estimate: "is there a line that
ends with more than this much HP?" is itself a yes/no proof. The keys are applied in the request's order within the
request's horizon; by default the highest lowest-HP fraction, then total HP, PP and the fewest turns, with the fewest
chance dependencies breaking ties last.

**Tiers 2 and 3.** If tier 1 fails, the solver drops every enemy-crit step and tries again (game G_0). If that is safe,
only crits can kill: tier 2, and it finds the largest crit budget j such that the line survives any j crit steps (with
at most half of the time left; a proven j is kept when the next one runs out of time). If not,
tier 3: the line with the lowest exact death chance. These lines are found by an exact backward calculation over beliefs
(no sampling); a horizon cut-off counts as a failure. A mid-turn loop that takes no turn (a switch straight back to a
position still being worked out) counts as a failure too, so the calculation always ends. When two choices tie, the one
that does not go round such a loop is taken: the line then never cycles back on itself, which the checker would
otherwise report as a mismatch.

**The certificate.** A found line is written down as a small controller: each node is one of the player's actions, and each
edge is labelled by what he sees next. Because the next node depends only on the label, the line is a function of the
screen by construction.

**The checker.** Before anything is claimed, a separate checker replays the certificate on the engine in every world,
without trusting the search code. It cross-checks every damage number and every turn order against independent oracles,
re-checks that the AI's odds and the outcome odds each sum to exactly 1, and computes the line's figures itself. A
damaging hit the damage oracle does not compare (one the calc cannot work out, such as Counter or an OHKO move; a
multi-hit move's; False Swipe's; one after a change the oracle cannot follow) is not cross-checked: the checker counts
those hits per move, per outcome it walks (every world and branch), so one hit in the plan can count many times, and
the report's verification lists them, most first. Any
disagreement makes the verdict unproven (verification mismatch). A state reached twice at the same point of the line is
walked once (the checker remembers it by the state's exact bytes, never by the search's key), and a state met again on
its own path is a cycle. Those bytes are taken with the battle log's wall-clock time line (Showdown's `|t:|<seconds>`)
blanked, as the engine already does: the same state met in two different seconds is the same state, so the walk, its
counts and its cycle check never depend on the clock. For a tier-2 line the solver also compares the crit
budgets: the search proved that every failing branch takes more than j enemy crit steps, so a checked crit budget below
j (a failing branch with j steps or fewer) is a verification mismatch too, and no tier-2 claim is made. A tier-1 or
tier-2 verdict is never given without a passing check.

**The figures.** Every number in a verdict comes from the checker, as an exact fraction:

- `deathProbability`: the chance of failing under the AI's own odds (deaths, unlabelled outcomes and horizon cut-offs);
- `guaranteeDeathProbability`: the same with the AI picking its worst supported action at every turn;
- tier 2's `critBudget`: the fewest enemy-crit steps on any failing branch, minus one;
- `killers`: each kill cause with its exact chance, and the plan branch that leads to it.

Both death figures take the worst world. The plan tree shows the AI's most likely action and the most likely outcome
first, and every other branch folds out. A level-2 line shown for the badge is drawn at level 1 too: its branches carry
the AI's real odds, the AI's most likely action first, while the certificate behind it covers every legal enemy action.

**The level-2 badge.** The main proof covers every action the ported trainer AI can pick (level 1). When the request
asks for the badge and a tier-1 line has passed the checker, the solver tries the stronger proof: safe against every
legal enemy action, the trainer's item uses included (level 2). Such a line stays safe even if the AI port is wrong, so
the AI port leaves the trust base. It gets half of the search time left when it starts. The cheapest route comes first:
the checker replays the shown line as a level-2 proof (safety only: its ranking figures are level 1's, already checked).
If that passes, the badge is proven on the shown line. If not, the solver searches level 2 from scratch and ranks the
level-2 lines with the request's keys; the best one is checked at level 2 and again at level 1, and only when both pass
does it become the shown line, with its level-2 figures (worst cases over every legal action). If the level-2
ranking did not finish, the report calls it the best level-2 line found within the badge budget rather than the
best-ranked one; it is still checked safe against every legal enemy action. In every other case the level-1 line stays,
with the badge `failed` (refuted, not proven, or out of time). A proven badge's verification adds both checks together.
Every report says whether the badge was attempted and how it ended.

*Known limitation: no badge in RAM mode.* In RAM mode an observation key includes the AI's memory, which level 1 keeps
and level 2 does not, so no certificate could pass the checker at both levels. The badge is not attempted there; the
report says "badge not attempted in RAM mode: level-1 and level-2 observation keys differ".

**The hidden-information probe.** In display mode, when the verdict would be tier 2 or tier 3, the solver asks one more
question with a quarter of the search time left: is there a tier-1 line when the player may read the exact state (RAM mode)?
For tier 3 a yes makes the verdict "unproven: needs hidden information", with the tier-3 line as `best`. For tier 2 it
only adds the report line "figure: a tier-1 line exists in RAM mode". The probe proves nothing on screen
and is never checked; it only explains why no safe screen-only line exists. Config `probeHiddenInformation` turns it
off.

**Gauntlets.** A gauntlet is several trainers in a row with one team. HP, PP and status carry over
from one fight to the next; a "heal here" gap starts the next fight at full HP and PP with no status (a heal cures it).
The solver always hands the engine the team's state explicitly, healed after a heal: given nothing, the engine would
start from the save.
The whole gauntlet is one proof, not one proof per fight: when the last enemy of fight k falls, the arena makes the
team's exact end state the entry of fight k+1, where the player picks the lead again, so the lead may change between fights.
Every end state the line can reach must lead to a proven next fight, so the search steers fight k towards end states
the next fight can take, for example a slower line that keeps more HP. Two lines that end a fight in exactly the same
state share one entry and one proof of what follows. The horizon counts turns per fight; the crit budget and the death
odds count across the whole gauntlet, so a crit in fight 1 and one in fight 2 make two crit steps. A faint on the player's
side ends the line where it happens: no fight is ever started with a fainted Pokémon (the engine refuses that too).
Manual pre-statuses apply to the first fight only; later fights take their statuses from the carry. A double battle
anywhere in the gauntlet makes it "unproven: unsupported battle". The verdict adds, for each later fight the line
reaches, the range of HP and the statuses each team member can enter it with (`entries`), read from the checker's
replay; a sleep whose counter was never drawn is carried as it is and reads `sleepUndrawn:<k>` (asleep for k turns so
far), and a win's end state in the plan keeps it too. `entries` is left out when that replay was cut short (it is never computed from a partial one), and is `[]`
when no line reaches a later fight. Experience between fights is ignored, which can only underrate the team.

**Starting status and pre-status proposals.** Party Pokémon start with the status the save gives them; box Pokémon start
healthy. The player can set a starting status by hand (the request's `startStatus`); it applies at the start of the first
fight, and the verdict's `preStatus` repeats it. With the pre-status option on (`preStatus: 'propose'`), the solver may
also propose one itself, for example burning a Guts user so the AI's sleep move can no longer land. It first solves the
fight as given. If that is tier 1, it proposes nothing. Otherwise it tries each candidate the resolver lists for a team
member (at most 12, team order first), skipping members the save or the player has already given a status. Pre-sleep is
always the last turn of sleep (counter 1). Each candidate is solved with an equal share of the search time left when it
starts, and the checker's deadline still bounds every check. A proposal is shown only when it is strictly better than
the result without it: a better tier; or in tier 1 a better rank; in tier 2 a larger crit budget, then a lower death
chance (in the ranking's order of those two keys); in tier 3 a lower death chance. The verdict then names the proposal
in `preStatus` and gives the result without it in `preStatusBaseline` (its tier and, for tier 2 or 3, its exact death
chance), so the page can show the odds with and without the pre-status. The plan does not say how to inflict it. The
report says what was proposed and tried, or why nothing was.

**Team pick.** Instead of a fixed team, a request can hand the solver a pool of box Pokémon and a team size limit. Pool members at 0 HP in the save are left out (they cannot fight), unless the first
fight starts with a heal; an empty pool is "unproven: no eligible team"; the size limit shrinks to the pool if the pool
is smaller. The candidates are every team of the allowed sizes, the most promising first (the integration may score
teams from the matchup sheet; the score only orders, it never removes a team), then larger teams first, then pool order.
Up to 20,000 candidates (config `maxTeamCandidates`) are listed and sorted by that score. Beyond that nothing is listed
up front (40 Pokémon in teams of 6 are 3,838,380 teams): the pool is ordered by each Pokémon's own score and the teams
are produced one at a time in that order, larger teams first; the total is counted exactly without listing them.

The player can steer the search with what he knows. `mustBring` names Pokémon that must be on the team: every
candidate holds them all, so team sizes run from their number up to the limit (40 Pokémon in teams of 6 with two that
must come are 73,815 teams, not 3,838,380). More of them than the size limit, or one at 0 HP in the save (without a heal
before the first fight), is "unproven: no eligible team", naming them. `preferred` names Pokémon to try first: teams
holding more of them come before teams holding fewer, and the order above breaks ties. A preferred Pokémon at 0 HP is
simply left out, like any fainted pool member. Above 20,000 candidates the teams are produced by the number of preferred
Pokémon they hold, most first, so the most preferred teams always come first there too. Leaving both out (or sending
them empty) changes nothing. A name in either list that is not in the pool, a name in both lists, or a name listed twice
is a request error. The report line on the search names both lists.
The player decides who enters a fight, so a proof that uses some members works for any team that contains them. That holds
only when no fight reads his bench (no Roar or Whirlwind dragging in a random bench member, no AI read of his party):
then only full-size teams are tried, and a complete disproof of a team (it fails on deaths alone, with no horizon
cut-off, engine limit or unmodelled mechanic involved, and never a timeout) rules out every smaller team inside it
(a *no-good*). When some fight reads the bench, every size is tried and nothing is ruled out unseen. Today no-goods
prune nothing: a monotone search tries only full-size teams, which already covers every smaller team (a proof for a
subset is a proof for the full team), and no full-size team lies inside another. The code is kept, guarded, for a later
search over participant sets (the smallest proven set per fight, the report's set cover), where no-goods do cut.

The search runs in two phases. Phase A asks only the tier-1 question of each candidate in order, with up to 60% of the
time, each candidate getting the Phase A time still left divided by the candidates left, or by 32 when more are left,
so every team tried gets a real slice and the rest are simply not tried: no line is extracted, ranked or checked yet, so
nothing is claimed. A proven team with an unmodelled mechanic at the start of a battle does not count: it is listed and
the search goes on. The first other proven team is then solved in full with all the time left (ranked, badge, checked)
and, if it is tier 1, shown with the pre-status proposals when asked. If that full solve runs out of time, it is shown
as it is (no time is left for anything else). If it comes back unproven for any other reason (a verification mismatch,
something unmodelled), it is listed with the reason and Phase A goes on with the next candidates while time remains.
If no team is shown by then, Phase B looks for the best tier-2 or tier-3 line, team by team in the same order, each
with the time left divided the same way (plus one share for the pre-status proposals when asked, which only the best
team gets). A team whose tier-1 search already failed goes straight to tiers 2 and 3 (the search is exact, so repeating
it would fail the same way); a team Phase A already solved in full keeps that result; a team whose tier-1 search ran out
of time, or was never reached, tries tier 1 again first. The best line by the pre-status comparison (tier, then rank,
crit budget or death chance) is shown, the earlier team on a tie. The report lists every team that was not proven tier
1 (`rejectedTeams`), in the order tried, with the first branch that failed it ("Team Staraptor, Machamp: Lead with
Staraptor / … / enemy crit Rock Slide on turn 3 kills Staraptor"), or "not proven within its share of the budget", or
the reason ("unmodelled: …", "verificationMismatch: …"). Only the first 200 are kept, followed by one line "… and n
more teams not proven". A team shown at tier 1 is never listed. The report adds one line on the search: how many
candidates were tried, the team sizes, the pool, whether the bench rule held, and how the shown team was chosen. Its
other counts (nodes, time, table) are the shown team's own run; progress counts the teams settled out of the exact
total, and the nodes of the whole search, and its best tier is only ever a tier a finished run has passed the checker
with: tier 1 appears once the shown team's full run is checked, not when the tier-1 search first proves it.

**Parallel search.** With more than one thread and a deps module for the workers (config `threads`, `depsModule`, or a
pool of workers that outlives the solve, `SolverDeps.pool`), the
solver splits independent work at the root over worker threads, and gives the same answers as one thread. For a fixed team, each possible lead is searched in its own thread. The best lead is then
chosen by the same rules as above: a tier-1 line first, by rank, with a proven level-2 badge beating none; otherwise
the lowest death chance (a tier-3 line is called the proven least only when every lead's own result is). Ties go to the
lead listed first, so the answer never depends on which thread finished first.
Before a line from a worker is compared or shown, the main thread replays it through the checker once more, and a line
that fails this check is never chosen. Only the lines that can be shown are replayed, best first: the main thread stops
at the first line whose replay finishes and agrees, which is the line shown, so a line ranked below it is not replayed.
Each replay has its own time allowance, at least 2 seconds or twice the worker's own check time, past the checker's
deadline if need be: the replays run after every worker has finished, so a worker check that ended near that deadline
would otherwise leave its replay no time. A replay cut short past the checker's deadline ends the replays (the lines
left are not replayed, and the verdict is a time-out), so at most one replay runs out its allowance. The two checks
disagree in what decides a verdict: whether the check
passed and why not, the set of mismatches found, the set of unmodelled entries, the figures the line's tier stands
on (the worst end for tier 1; both death odds, and for tier 2 the crit budget), and the numbers of damage and order
checks, of states visited and of hits not cross-checked per move. The counts are deterministic (the
engine's state carries no wall-clock text, and the checker's memo and cycle keys ignore it), so two finished checks of one line that differ only in them mean the worker's
deps or data differ: a verification mismatch like any other, naming the counts that differ
("damage checks 218 here, the worker's 252; ..."). A check cut short, the
worker's or the main thread's, is a time-out, never a mismatch: the line stays as the `best` of "unproven: time limit",
saying how far it was checked ("the worker's check of this line did not finish; this thread did not re-check it", or
"this line was checked by a worker thread only; this thread's re-check did not finish"). A real disagreement is never
silent: it means the worker's set-up differs from the main thread's (for example a data table installed on one and not
the other), a configuration bug that loses lines. The verdict is then "unproven: verification mismatch", naming the
lead and the difference, and how many other leads ran out of time; the disputed line is its `best`, saying "this
thread's re-check of this line disagrees with the worker's check (see the verdict detail)", and the main thread's check
of that line is its verification. In a team search it names the team, with the verdict that would
otherwise have been shown as `best`. When no line passes its replay and none disagrees (every check was cut short),
the verdict shown carries the best line any lead found, never a lead with no line while another has one. That holds
with pre-status proposals too, where the result without a
pre-status and each proposal are split on their own: a difference in any of them (the one without first, then the
proposals in order, named "pre-status …") makes the shown verdict a verification mismatch, even when another proposal's
line would have been shown. The main thread also checks every lead's starting battles for unmodelled mechanics,
as one thread would. If a worker fails outright, every other worker stops and the solve reports the error. For a team search, several candidate teams are searched
at once, but their results are taken in candidate order. The shown team and the rejected list are therefore the same
as with one thread. The only facts shared between candidates are complete disproofs, which hold in any order. A lead
plus a first move is not split yet. Cancelling stops every worker running the solve's jobs at once; on a shared pool,
other solves' jobs run on. The report's search counts then add up every
thread's work. How to wire the real engine and AI, and the measured speed, are in `docs/solver-integration.md`.

**Running out of time.** A verified result stands; refinements cut short never erase it. The tier-1 search
gets 60% of the search time. If it has neither proven nor refuted tier 1 by then, it stops, and the rest of the time
goes to the best tier-2 or tier-3 line, which is checked and shown as the `best` of "unproven: time limit". A tier-1
line whose ranking was cut short (by the time limit, or by a refutation that met an engine limit or something
unmodelled) is still a tier-1 verdict: its rank is the line's own, and the report adds "ranking stopped early (why): the
line is proven safe and checked, but a better-ranked safe line may exist". A tier-3 line found when time ran out is a
tier-3 verdict, "best found within the budget". A tier-2 line is a tier-2 verdict as soon as its crit budget is proven,
and the report adds that a larger budget or a lower death chance may exist: the search for larger budgets gets at most
half of the time left, so a proven budget is never lost to the next one running out of time. In a root split, a lead
that ran out of time does not override another lead's verified tier-1 line; the report names the unfinished leads. These
"stopped early" lines say the line is checked, so they appear only on a tier-1 (or, for the crit budget, tier-2) verdict:
never when the check failed or another reason makes the verdict unproven, even later (a root split, the main thread's
re-check), and not on the `best` line shown under it either. The
level-2 badge and the probe keep their own budgets and outcomes. A check cut short is still a timeout: nothing is
claimed without a finished, passing check.

**Unproven.** These reasons win over any tier, in this order: unsupported battle (a double, too many candidate worlds) or
no team (an empty team or pool, a fainted team member, a pool with nobody fit to fight, more must-bring Pokémon than the
team size, a fainted must-bring Pokémon); the time limit or a cancel (when
no checked line stands, as above); a verification mismatch; anything unmodelled (an unmodelled move, ability or item in
the battle, an unlabelled random draw, undefined AI behaviour); an engine limit; a tier 2 or 3 line whose every
failure is a horizon cut-off; and, only in place of a tier-3 verdict, "needs hidden information" (the probe above). A
tier-1 failure refutes tier 1 only when every choice the player has is refuted: some outcome dies, repeats a position or
misses a ranking threshold. When some choice only met something unmodelled, an engine limit or the horizon, tier 1 is
not refuted (that choice might be safe), so the verdict is unproven for that reason, even if other choices die; the
search records this as it goes, never from the failure reasons alone, which merge every choice's. A root split and the
team search's no-goods follow the same rule. The best line found is still shown, as `best`.

## Design decisions

1. **Belief search, not per-world proofs.** An alternative is to prove each world on its own and check one shared policy afterwards; belief sets are used instead, so they are built from the start and the search itself only ever
   finds lines the player can play. A belief's identity is its set of member keys.
2. **Edges carry the whole observation segment** from the player's choice to his next decision. Grouping by the last screen
   only would be coarser than what he sees: sound, but it would lose proofs.
3. **Which phase comes next is visible** (turn menu, U-turn switch prompt, lead choice), so it is part of the edge: the player
   can act on it.
4. **Tiers 2 and 3 optimise the AI's own odds and report both figures.** Expectation over the AI's odds splits exactly
   over beliefs, so the best line can be computed exactly; the worst case over its support does not split, so the checker
   computes it exactly for the chosen line instead.
5. **Worlds in tiers 2 and 3 are adversarial**: the checker reports the worst world. The search weights worlds evenly to
   stay exact, so with more than one world the line is "best found", not proven optimal.
6. **A horizon cut-off counts as a failure in tier 3.** Not winning in time is not a win. When all the failure is
   cut-off (nothing dies), the verdict is "unproven: horizon", with the line as `best`.
7. **Crit counting is conservative:** a step with several enemy crits counts as one, so a budget of j crit steps is never
   weaker than j crits.
8. **Ranking metrics** are exact and proven: the lowest HP fraction over win leaves, HP points, PP, the shortest horizon
   that still works; chance dependencies break ties last. Crit keys apply to tier 2 only, where they mean something.
9. **Level-2 badge preference:** if the best-ranked line fails the "any enemy action" check but another passes, the
   passing one is shown: the best-ranked level-2 line, with its level-2 rank. A line that survives AI-port mistakes is
   worth a slightly worse rank. It is shown only after the checker passes it at level 2 and at level 1 (a level-2 proof
   covers level 1 only while the AI picks legal actions, which the level-1 check confirms).
10. **Hidden-information probe:** if the screen-only result is tier 3 but an exact-state proof exists, the verdict is
    "unproven: needs hidden information", with the tier-3 line as `best`: a safe line exists that the player could follow with
    more information. For a tier-2 result the finding is only a report line, since the line shown is already crit-only.
    The badge gets half of the search time left, the probe a quarter; neither moves the checker's deadline.
11. **Plan tree truncation** at 20,000 nodes, shown as `truncated` (a display cut, not the horizon). The certificate still
    covers every branch.
12. **Level 2 weighs legal enemy actions evenly.** The weights only keep sums at 1; the level-2 game is yes or no.
13. **Pre-status proposals must be strictly better.** A tie keeps the result without a pre-status, since a pre-status
    costs the player effort. An unproven result is never better than another unproven one, and never better than a tier, even
    when its `best` line would be. A team member the player gave any manual status, "none" included, gets no proposal: that
    is his call.
14. **The team search proves before it ranks.** Phase A asks each candidate only the tier-1 question; the first
    proven team in a modelled battle is then solved again in full (ranked, checked) with the time left. Tier 1, or out
    of time, is shown; any other unproven result (a checker mismatch, something unmodelled) is listed with its reason
    and the search goes on. Ranking and checking every candidate would spend the
    budget on teams that are thrown away.
15. **A no-good needs a complete disproof in a modelled battle.** Besides the reasons above (no horizon, engine limit,
    unmodelled outcome or timeout), a battle with an unmodelled mechanic at the start never gives a no-good: its deaths
    come from an engine that does not model the battle.
16. **Pre-status in a team search** is proposed only for the team shown: after Phase A's proven team (inside its full
    solve), or for Phase B's best team, which gets one share of Phase B's time for it. A candidate's request carries
    the manual pre-status of its own members only, so the verdict's `preStatus` names team members only.
17. **Every team not proven tier 1 is listed**, the shown Phase B team included (that is why it is not tier 1), and a
    team whose tier-1 search ran out of time too ("not proven within its share of the budget"); a team cut off by a
    cancel was not tried, so it is not listed. A cancel stops the search; the best verdict so far, if any, is shown.

18. **The root split is by lead only, and the main thread checks again.** A split by lead and first move would need
    the root restriction applied below the fight's entry; it is left for later. Lines from different leads are compared
    only at the same certification level (level-2 figures are worst cases over every legal action), ties keep the lower
    lead, and every line a worker found that could be shown is replayed through the checker on the main thread before
    it is compared (one that fails is never chosen; a real disagreement makes the verdict a verification mismatch; which lines, and what counts as a disagreement, are in item 21 below).
    Each lead is judged alone, so a split can be more cautious than one thread, never less (`docs/solver-integration.md`,
    known limitations).
19. **A verified result stands** (a mid-ranking deadline does not return "unproven: timeout"). The ranking and the search for a larger crit budget or a lower death chance are
    refinements: a checked line is claimed even when they are cut short, and the report says a better line may exist.
    Tier 1 gets 60% of the search time, so that the rest can find a line to show as `best` when tier 1 is still open.
    The budgets bind on real fights, and every timeout must carry the best line.

20. **The player's team priorities**. `mustBring` restricts the candidates; `preferred` only orders them,
    and the order of the `preferred` list itself means nothing (the contract: the solver's own order breaks ties), so
    preferred Pokémon are taken by their own score like the rest. More must-bring Pokémon than the size limit is
    refused first, whatever HP the save gives them. A "stopped early" line is a claim that the line is checked, so
    it is kept only on a verdict of its tier, for the crit-budget search's tier-2 line as for the ranking's tier-1 line; and in a tiers-2-and-3 tie the solver avoids a choice that loops
    without a turn, but still takes such a choice when it is strictly better.

21. **The main thread's replay of a worker's line** (this followed a false "verification mismatch": the real engine's state bytes held Showdown's wall-clock `|t:|` line, so the
    checker's memory, and with it its counts, depended on the second, and the replay compared counts exactly).
    - *Deterministic bytes.* The engine blanks the `|t:|` lines in every state it returns, and the checker blanks them
      again before it remembers a state or looks for a cycle.
    - *What disagrees*. What decides a verdict: passed, the reason, the set of mismatch texts, the
      set of unmodelled entries, or a figure the claim stands on (tier 1 the worst end; tier 2 both death odds and the
      crit budget; tier 3 both death odds); and the counts: damage and order checks, states visited, and the hits not
      cross-checked per move. Since the `|t:|` fix the counts are deterministic, so two finished checks
      that differ only in a count mean the worker's set-up differs: a verification mismatch like any other, the detail
      naming the counts that differ. A check cut short, on either side, is never compared: it stays a time-out (below).
    - *Cut short is a time-out.* The worker sends its check's result, states visited, time and whether it finished. A
      worker check that did not finish is not compared or replayed; a replay that stops at its deadline is not
      compared. Either way the lead is "unproven: time limit", its line kept as `best` with a line saying how far it was
      checked: "the worker's check of this line did not finish; this thread did not re-check it" when the worker's own
      check was cut short, else "this line was checked by a worker thread only; this thread's re-check did not
      finish". A deadline stop is never a mismatch.
    - *Order and budget.* Only the lines that can be shown are replayed, best first by the usual comparison: the first
      whose replay passes is the chosen line; a disagreement ends the replays. Each replay's deadline is the later of
      the checker's deadline and now plus the larger of 2 seconds and twice the worker's check time (for a line with
      the level-2 badge, the worker's time for both levels). A replay cut short past the checker's deadline ends the replays too: the lines left are not replayed and the verdict is a time-out. So at most one replay
      runs out its time, and a split's replays end by the later of the checker's deadline and that replay's start plus
      its allowance. A disagreement on any replayed line still makes the verdict a verification mismatch.
    - *The verdict.* After a disagreement it is the disagreeing lead's: its line as `best` (keeping the worker's
      report, with the line "this thread's re-check of this line disagrees with the worker's check (see the verdict
      detail)", so it never reads as verified), the main thread's replay as the verification, and "; k of n leads ran
      out of time" in the detail when others timed out. With no claim at all,
      the verdict shown carries the best line any lead has.

Also: a fight with more than 64 candidate worlds (configurable, `maxWorlds`) is "unproven: unsupported battle"; an
in-game spot check settles the disputed values (decision solver-018).

## Assumptions every report lists

- Chance: every random draw is enumerated exactly with the engine's probabilities and is independent of every other
  draw.
- Certification level 1: safe against every action the ported trainer AI can pick, at its exact odds.
- The observation mode (display: decisions depend only on the screen; RAM: on the exact state).
- No mid-fight level-ups: experience is ignored, which can only underrate the team.
- The engine's and the AI's ids.
- The horizon per fight; a line not won by then counts as failing.
- The crit budget is counted in steps: a step with several enemy crits counts as one.
- Worlds are treated adversarially: each candidate world for disputed natures and abilities is taken at its worst.
- The level-2 badge: not requested, not attempted (no verified tier-1 line, or RAM mode), proven (on the shown line, or
  on the best-ranked level-2 line, or the best found within the badge budget, that is then shown), or failed (with the
  reason).
- For a gauntlet: one team throughout; HP, PP and status carry over (except where a heal is set, named by fight: full
  HP and PP, no status); the lead may change before each fight; experience is ignored between fights too; the crit
  budget and the death odds count across the whole gauntlet.
- With pre-status proposals on: the pre-status proposed, how many candidates were tried (and whether the time limit or
  a cancel cut that short), and the result without it; or that none was tried (tier 1 without one), none was possible
  (no candidate), or none was better.
- For a team search: how many candidate teams were tried out of how many, the team sizes, the eligible pool (and how
  many were left out at 0 HP), the must-bring Pokémon every team holds and the preferred ones tried first (when given),
  whether no-goods applied (no fight reads the bench) or every size was tried, and how the shown team was chosen (the
  first tier-1 team, or the best of the teams evaluated for tiers 2 and 3).

Until the in-game spot checks pass, every report says "model not yet verified in game".
