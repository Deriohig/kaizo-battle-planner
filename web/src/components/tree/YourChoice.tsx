// The tree's step, the player's side of the turn: each legal choice with its numbers before
// anything is picked. A move is a compact tile (`MoveTile`): a type chip and its name, "Physical · 70 power", the damage
// band over their HP bar, the % range (the HP and top crit sit in the crit split; no PP, a plan spends none) and its
// KO words (`moveText`'s parts), with every exact fraction on hover and "Priority +1" under a
// priority move. Its KO tone is ok only for a sure KO (`sureKo`: "OHKO 100%", never Beat Up or Triple Kick). A switch is
// a chip: the name, HP and status of the Pokémon it sends in ("Gloom 40/57 · poisoned"). At his turn the chips sit under
// a "Switch instead" micro-label (the moves sit under "Use move") that names their list; at a replacement or a mid-turn switch the heading says it and names
// the list. An item choice never reaches his panel, so it shows nothing. A pick is reported to the caller (`onChoose`); nothing is
// worked out beyond the calc. Under the options, at his turn, a line when his Pokémon's status may stop it moving. The key
// to the KO words sits behind the heading's ⓘ when a listed move shows KO figures (a move has them exactly when
// it has a `koTitle`).
//
// While a step is worked out every option is busy (`busyProps`: aria-disabled, never disabled, so focus stays on it), and
// the pick being worked out is the selected one, with "Working out…" in it. An AI error never disables
// an option: a pick only records the player's choice, so the error bears on the trainer's odds (TheirReply) alone, and a
// replacement can always be picked. Each option carries its
// choice's key (`data-choice`), so the page can put focus back on it when Stop or Try again goes.
//
// The heading takes focus from code only (`tabIndex={-1}`, `data-focus="choice"`): the page focuses it when a step
// arrives, so the next Tab is the first option.

import { Fragment, useId, type ReactNode } from 'react';
import type { Choice } from '../../../../src/contracts/engine';
import type { LineMoveDamageJson, LineNodeJson } from '../../../../src/server/apiTypes';
import { percentRange } from '../../format';
import { choiceKey, choiceName, KO_KEY, koLines, koTitle, mayNotMove, priorityText, sureKo } from '../../line';
import type { StepPanel } from '../../tree';
import { busyProps } from '../busy';
import { InfoTip } from '../InfoTip';
import { MoveTile } from '../MoveTile';
import { BandBar } from './DamageBand';

/** A tile's KO words as one block span per short line (`koLines`), spaced so the button's text still reads as words; undefined with none. */
function koSpans(m: LineMoveDamageJson): ReactNode {
  const lines = koLines(m);
  if (lines.length === 0) return undefined;
  return lines.map((line, i) => <Fragment key={line}>{i > 0 && ' '}<span className="tile-ko-line">{line}</span></Fragment>);
}

/** "Physical · 70 power", "Status", "Special"; undefined when the category is unknown. */
function subText(m: LineMoveDamageJson): string | undefined {
  if (m.status) return 'Status';
  const category = m.category ?? null;
  if (category === null) return undefined;
  if (category === 'status') return 'Status';
  const name = `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
  return m.power == null ? name : `${name} · ${m.power} power`;
}

const HEADINGS: Partial<Record<LineNodeJson['phase'], string>> = {
  turnChoice: 'Your choice', playerReplacement: 'One of yours fainted: send out', playerMidTurnSwitch: 'Switch in',
};

export function YourChoice({ node, selected, working, busy, onChoose }: {
  node: StepPanel;
  /** The choice picked at this step (`{ choice: null }` for a step the AI alone takes), or none. */
  selected: { choice: Choice | null } | null;
  /** The pick being worked out (the caller's `working`): it is the selected option meanwhile, and no other is. Null when none. */
  working: Choice | null;
  busy: boolean;
  onChoose(choice: Choice): void;
}) {
  const headingId = useId();
  const switchLabelId = useId();
  const { choices, view } = node;
  if (choices === undefined || choices.length === 0) return null;
  const enemyPercent = view.enemy.active?.percent ?? 100;
  /** A listed move's numbers against their active Pokémon, if the node has them. */
  const numbersOf = (choice: Choice): LineMoveDamageJson | undefined => (choice.kind === 'move' ? node.damage?.yours.find((m) => m.slot === choice.slot) : undefined);
  const stuck = node.phase === 'turnChoice' ? mayNotMove(view.player.active) : null;
  const keyed = choices.some(({ choice }) => {
    const numbers = numbersOf(choice);
    return numbers !== undefined && koTitle(numbers) !== undefined;
  });
  const options = choices.map(({ choice, label }) => {
    const picking = working !== null && choiceKey(working) === choiceKey(choice);
    const on = working === null ? selected !== null && choiceKey(selected.choice) === choiceKey(choice) : picking;
    // `tree-option` is the option buttons' class, and `data-choice` is how the page finds one to put focus back on.
    const button = { className: 'tree-option', 'data-choice': choiceKey(choice), ...busyProps(busy, () => onChoose(choice)) };
    return { choice, label, picking, on, button };
  });
  const tiles = options.filter((o) => o.choice.kind === 'move');
  const chips = options.filter((o) => o.choice.kind === 'switch');
  if (tiles.length === 0 && chips.length === 0) return null;
  const labelled = node.phase === 'turnChoice';
  const title = HEADINGS[node.phase] ?? 'Switch in';
  return (
    <section className="tree-choice" aria-label="Your choice">
      <div className="tree-choice-head">
        <h4 id={headingId} tabIndex={-1} data-focus="choice">{title}</h4>
        {keyed && <InfoTip label={title}>{KO_KEY}</InfoTip>}
      </div>
      {tiles.length > 0 && labelled && <p className="matchup-label">Use move</p>}
      {tiles.length > 0 && (
        <ul className="tree-tiles">
          {tiles.map(({ choice, label, picking, on, button }) => {
            const numbers = numbersOf(choice);
            const sub = numbers === undefined ? undefined : subText(numbers);
            const priority = numbers === undefined ? null : priorityText(numbers.priority);
            const extra = priority === null && !picking ? undefined : (
              <>
                {priority !== null && <span className="tile-priority">{priority}</span>}
                {priority !== null && picking && ' '}
                {picking && <span className="tile-working">Working out…</span>}
              </>
            );
            return (
              <li key={choiceKey(choice)}>
                <MoveTile
                  name={choiceName(choice, label)}
                  type={numbers?.type ?? null}
                  sub={sub}
                  band={numbers === undefined || numbers.status || numbers.percent === null ? undefined : <BandBar move={numbers} percent={enemyPercent} side="theirs" />}
                  damage={numbers?.percent == null ? undefined : percentRange(numbers.percent)}
                  ko={numbers === undefined ? undefined : koSpans(numbers)} koTitle={numbers === undefined ? undefined : koTitle(numbers)}
                  koTone={numbers !== undefined && sureKo(numbers) ? 'ok' : null}
                  extra={extra}
                  selected={on} button={button}
                />
              </li>
            );
          })}
        </ul>
      )}
      {chips.length > 0 && labelled && <p className="matchup-label" id={switchLabelId}>Switch instead</p>}
      {chips.length > 0 && (
        <ul className="tree-chips" aria-labelledby={labelled ? switchLabelId : headingId}>
          {chips.map(({ choice, label, picking, on, button }) => {
            const member = choice.kind === 'switch' ? view.player.party[choice.index] : undefined;
            const text = member === undefined ? choiceName(choice, label) : `${member.name} ${member.hp}/${member.maxHp}${member.status === null ? '' : ` · ${member.status}`}`;
            return (
              <li key={choiceKey(choice)}>
                <button type="button" {...button} className={`chip tree-option${on ? ' is-selected' : ''}`} aria-pressed={on}>
                  {text}
                  {picking && <span className="chip-working"> Working out…</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {stuck !== null && <p className="line-muted">{stuck}</p>}
    </section>
  );
}
