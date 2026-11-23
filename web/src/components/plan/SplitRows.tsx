// The exchange (the turn's hero): directly under
// "Your action", his picked move on theirs, then their shown move on his (the likelihood list's pick for this turn, else
// their likeliest), each as a heading line over `CritSplit` rows (non-crit large, crit small; display only).
// Their line takes the danger stripe when one hit can KO him, the warn stripe when only a crit can (`koStripe`). The
// roll legend sits on the first heading's line, and what the bars mean behind its ⓘ. Nothing here works out an outcome:
// the bars are what a move takes off a full HP bar, and HP never changes. No crit rate is printed here: a row's chance is
// the server's, in CritSplit.
//
// `hot` is the side whose Pokémon takes the hit (`splitTone`): his move on theirs is 'theirs' (a sure KO reads ok), their
// move on his is 'mine' (a KO reads danger).
//
// Below the full AI odds (aiOdds.ts) their line has no figure: at `likeliest` and `ranked` it says "their likeliest move"
// ("one of their likeliest moves" in a tie) for a move the AI ranks first, and at `ranked` the place of a lower one ("2nd
// likeliest", "joint 2nd likeliest"); at `off` it is the exchange alone, their first move until he picks another.

import type { JSX, ReactNode } from 'react';
import { ordinal, useAiOdds } from '../../aiOdds';
import type { PlanPick } from '../../plan';
import { InfoTip } from '../InfoTip';
import { CritSplit } from './parts';
import { koStripe, shownMine, shownTheirs, type StepPanel } from './planScreen';

/** What their line says of the shown move's place below the full AI odds (see the top of the file). */
function placeWords(rank: number | null | undefined, tied: boolean): string | null {
  if (rank == null) return null;
  if (rank === 1) return tied ? ' · one of their likeliest moves' : ' · their likeliest move';
  return ` · ${tied ? 'joint ' : ''}${ordinal(rank)} likeliest`;
}

export const SPLIT_NOTE = 'Bars show what a move takes off a full HP bar. HP never changes in the plan.';

const STRIPE = { danger: ' is-danger', warn: ' is-warn' } as const;

export function SplitRows({ panel, pick, theirPick, mine, theirs }: {
  panel: StepPanel | null;
  /** His pick on this turn. */
  pick: PlanPick | null;
  /** Their move picked in the likelihood list for this turn; null for their likeliest. */
  theirPick: string | null;
  /** The plan's names for his Pokémon and theirs. */
  mine: string; theirs: string;
}): JSX.Element | null {
  const level = useAiOdds();
  const yours = shownMine(panel, pick);
  const their = shownTheirs(panel, theirPick, level);
  if (yours === null && their === null) return null;
  // The percent keeps its exact fraction as `title`.
  const odds = their === null ? null : level !== 'full' ? placeWords(their.rank, their.tied === true) : their.percent === null ? null : (
    <>{their.likeliest ? ' · their likeliest move, ' : ' · '}<span title={their.exact ?? undefined}>{their.percent}</span></>
  );
  const legend = (
    <span className="plan-legend">
      <span className="plan-legend-key"><span className="plan-swatch is-low" aria-hidden="true" /> lowest roll</span>
      <span className="plan-legend-key"><span className="plan-swatch is-range" aria-hidden="true" /> roll range</span>
      <InfoTip label="the damage rows">{SPLIT_NOTE}</InfoTip>
    </span>
  );
  /** A side's heading line, with the legend on the first one. */
  const head = (words: ReactNode, first: boolean) => (
    <div className="plan-split-head">
      <h4>{words}</h4>
      {first && legend}
    </div>
  );
  const tone = their === null ? null : koStripe(their.move);
  return (
    <div className="plan-splits">
      {yours !== null && (
        <section className="plan-split" data-side="mine" aria-label="Your move">
          {head(<>Your {yours.name} on {theirs}</>, true)}
          <CritSplit move={yours} targetName={theirs} hot="theirs" />
        </section>
      )}
      {their !== null && (
        <section className={`plan-split${tone === null ? '' : STRIPE[tone]}`} data-side="theirs" aria-label="Their move">
          {head(<>{theirs}'s {their.move.name} on {mine}{odds}</>, yours === null)}
          <CritSplit move={their.move} targetName={mine} hot="mine" />
        </section>
      )}
    </div>
  );
}
