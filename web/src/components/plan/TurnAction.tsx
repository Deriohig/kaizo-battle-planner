// "Your action" (the centre column): his card, his choices and their card side by
// side, under the exchange (who moves first is one line in the turn's head, PlanView's). The cards draw from the plan whether or not the turn has numbers: with
// none, each is the name alone and the choices column is empty, and the marks still work.
//
// Their card holds the send-in picker once their Pokémon is marked fainted: one button per one of theirs still standing,
// in the order of the step's send-out odds with each one's odds (`formatOdds`, the exact fraction as `title`), else in
// party order with the name alone. The likeliest is pressed until he picks (the hook's `learn`). A send-out the AI cannot
// decide (`sendOutError`) is said in the server's own words in place of the odds. His replacement is `YourChoice` at
// `playerReplacement`, so his card needs no picker. Below the full AI odds (aiOdds.ts) no button has a figure: at
// `likeliest` every one still standing, in party order, the likeliest marked "likely"; at `ranked` the send-out's order
// with each one's place ("1st", "=2nd"); at `off` party order, names alone.
//
// While a failure stands, numbers still shown are the last ones this turn had (`stale`), and say so.
//
// Trying a Pokémon on the turn: a box or team Pokémon dropped on his card becomes his on this turn
// (`plan.tryMon`), unless it is no Pokémon of his, already on the field, or marked fainted. While a tried one is the turn's
// own (`plan.tried`) his card holds the trial strip: Keep closes it (`plan.keepTry`: plan data, so a kept try carries and
// survives a reload), Back to puts the carried one back, and Add to team asks the draft and keeps. Each takes the strip, and
// itself, away: focus that fell to the page body goes to the turn's heading ("Your action", `tabIndex={-1}`).

import { type JSX, type MouseEvent, useLayoutEffect, useRef } from 'react';
import type { BoxMonJson, DraftMonJson, LineMoveDamageJson, MonRef } from '../../../../src/server/apiTypes';
import { rankText, useAiOdds } from '../../aiOdds';
import { MAX_TEAM } from '../../draft';
import { formatOdds } from '../../format';
import type { PlanSendOutJson } from '../../planTypes';
import type { UsePlan } from '../../usePlan';
import { busyProps } from '../busy';
import { MonCard } from './MonCard';
import { spriteSpecies } from './MonToken';
import { YourChoice } from './parts';
import { markedMine, planMonOf, type StepPanel } from './planScreen';

/** Over the choices while a failure stands and the numbers shown are the turn's earlier ones. */
export const PREVIOUS_NUMBERS = "These are this turn's previous numbers.";

export function TurnAction({ plan, panel, mine: mineBox, mons, draft, team, onAddToTeam, bands }: {
  plan: UsePlan; panel: StepPanel | null; trainer: string;
  /** His Pokémon on the field as the box has it: gives his token its types and, with no numbers yet, its level. Neutral without. */
  mine?: Pick<BoxMonJson, 'types' | 'level' | 'speciesId'>;
  /** The Pokémon that may be in the plan, by ref: a drop of any other does nothing. */
  mons: ReadonlyMap<MonRef, BoxMonJson>;
  draft: readonly DraftMonJson[];
  team: readonly MonRef[];
  onAddToTeam(ref: MonRef): void;
  /** The band over each card: his shows their shown move, theirs his pick's. */
  bands?: { mine: LineMoveDamageJson | null; theirs: LineMoveDamageJson | null };
}): JSX.Element | null {
  /** The strip button pressed last and the turn it sits in, until the strip has gone (focus then goes to the turn's heading). */
  const pressed = useRef<{ button: Element; turn: Element | null } | null>(null);
  useLayoutEffect(() => {
    const p = pressed.current;
    if (p === null) return;
    const now = document.activeElement;
    if (now === p.button && p.button.isConnected) return;   // the strip has not gone yet
    pressed.current = null;
    if (now !== null && now !== document.body && now.isConnected) return;
    p.turn?.querySelector<HTMLElement>('[data-focus="turn"]')?.focus();
  });
  const press = (action: () => void) => (e: MouseEvent<HTMLButtonElement>) => {
    pressed.current = { button: e.currentTarget, turn: e.currentTarget.closest('.plan-turn') };
    action();
  };
  const { current, plan: shown } = plan;
  if (current === null || shown === null) return null;
  const nameOf = (key: string | null | undefined) => shown.start.mons.find((m) => m.key === key)?.name;
  const mineName = nameOf(current.mine) ?? 'Your Pokémon';
  const theirName = current.theirs === null ? 'Their Pokémon' : (shown.start.enemies[current.theirs] ?? 'Their Pokémon');
  const step = plan.answer ?? plan.stale;

  const fainted = markedMine(plan.turns);
  const onDropMon = (ref: MonRef) => {
    const mon = mons.get(ref);
    if (mon === undefined || mon.key === current.mine || fainted.includes(mon.key)) return;
    void plan.tryMon(planMonOf(mon, draft));
  };
  const { tried } = plan;
  const keep = () => void plan.keepTry();
  const triedRef = tried === null ? undefined : shown.start.mons.find((m) => m.key === tried.key)?.ref;
  const previousName = nameOf(tried?.previous);
  const trial = tried !== null && (
    <div className="plan-trial">
      <p><strong>Trying {nameOf(tried.key) ?? mineName} here.</strong></p>
      <div className="plan-trial-actions">
        <button type="button" className="button" onClick={press(keep)}>Keep</button>
        {previousName !== undefined && (
          <button type="button" className="button" onClick={press(() => void plan.setMine(null))}>Back to {previousName}</button>
        )}
        {triedRef !== undefined && !team.includes(triedRef) && team.length < MAX_TEAM && (
          <button type="button" className="button" onClick={press(() => { onAddToTeam(triedRef); keep(); })}>Add to team</button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <div className="plan-action">
        <MonCard
          side="mine" name={mineName} mon={panel?.view.player.active ?? null} fainted={current.fainted.mine}
          onToggleFainted={() => void plan.toggleFainted('mine')} busy={plan.busy} band={bands?.mine ?? null} types={mineBox?.types} level={mineBox?.level}
          species={panel?.view.player.active?.speciesId ?? (mineBox === undefined ? undefined : spriteSpecies(mineBox as BoxMonJson))}
          onDropMon={onDropMon} dropLabel={`Drop here to try it against ${theirName}`}
        >
          {trial}
        </MonCard>
        <div className="plan-pick">
          {plan.failure !== null && plan.answer === null && panel !== null && <p className="line-muted plan-previous">{PREVIOUS_NUMBERS}</p>}
          {panel !== null && (
            <YourChoice node={panel} selected={plan.selected} working={null} busy={plan.answer === null} onChoose={plan.choose} />
          )}
        </div>
        <MonCard
          side="theirs" name={theirName} mon={panel?.view.enemy.active ?? null} fainted={current.fainted.theirs}
          onToggleFainted={() => void plan.toggleFainted('theirs')} busy={plan.busy} band={bands?.theirs ?? null} species={panel?.view.enemy.active?.speciesId}
        >
          {current.fainted.theirs && <SendIn plan={plan} sendOut={step?.sendOut} sendOutError={step?.sendOutError} />}
        </MonCard>
      </div>
    </>
  );
}

function SendIn({ plan, sendOut, sendOutError }: {
  plan: UsePlan; sendOut: PlanSendOutJson | undefined; sendOutError: string | undefined;
}): JSX.Element | null {
  const level = useAiOdds();
  const { current, plan: shown } = plan;
  if (current === null || shown === null) return null;
  const { enemies } = shown.start;
  const standing = (n: number) => n !== current.theirs && !current.faintedBefore.theirs.includes(n);
  const party = enemies.map((_, n) => n).filter(standing);
  if (party.length === 0) return null;
  // The server's words stand in place of the odds (the contract sends one or the other); at `off` it sends neither.
  const odds = sendOutError !== undefined || level === 'off' ? undefined : sendOut?.choices.filter((c) => standing(c.index) && c.index < enemies.length);
  const plain = party.map((index) => ({ index, odds: null as { percent: string; exact?: string } | null }));
  let rows = plain;
  if (level === 'likeliest') {
    rows = party.map((index) => ({ index, odds: odds?.some((c) => c.index === index && c.likeliest === true) === true ? { percent: 'likely' } : null }));
  } else if (odds !== undefined && odds.length > 0) {
    const ordered = level === 'ranked' ? [...odds].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)) : odds;
    rows = ordered.map((c) => {
      if (level === 'full' && c.probability !== undefined) return { index: c.index, odds: formatOdds(`${c.probability.num}/${c.probability.den}`) };
      const rank = c.rank;
      return { index: c.index, odds: rank === undefined ? null : { percent: rankText(rank, odds.filter((d) => d.rank === rank).length > 1) } };
    });
  }
  return (
    <div role="group" aria-label="Who comes in?" className="plan-sendin">
      <h4>Who comes in?</h4>
      {sendOutError !== undefined && <p className="banner banner-warn plan-sendout-error">{sendOutError}</p>}
      <ul className="tree-chips">
        {rows.map(({ index, odds: o }) => {
          const on = current.sendIn.theirs === index;
          return (
            <li key={index}>
              <button
                type="button" className={on ? 'chip selected' : 'chip'} aria-pressed={on} title={o?.exact}
                {...busyProps(plan.busy, () => plan.sendIn('theirs', index))}
              >
                {o === null ? enemies[index] : `${enemies[index]} · ${o.percent}`}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
