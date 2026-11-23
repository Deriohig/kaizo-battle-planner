// The tree's step, the trainer's side of the turn, as "Next move likelihood": a row for every action the AI may take, likeliest first (`replyRows`), each with a bar and the AI's exact
// percent (the fraction on hover), his active Pokémon's HP range from the move with its top crit, and the KO words. A row
// that can KO him is a danger row; one that can only on a crit, or one his held Focus Sash at full HP survives at 1 HP, a
// warn row; one the AI picks at exactly 0% a muted one. A move of other than normal priority says so after its name. The bar
// is display only: the figure printed is the exact one. The AI never reads the player's choice, so this is the same whatever he
// picks (`REPLY_BLIND` says so at a turn choice, unless the AI is not modelled: then the page claims nothing about how it
// picks). That and what the odds are sit behind the heading's one ⓘ, not as paragraphs. Without the AI's odds (none sent, or an AI error) no move gets a share and nothing claims there are odds: the
// heading is "Their moves" with no odds note, and an AI error is said plainly (`AI_NOT_MODELLED`) with the AI's own words
// behind Details. A move the AI's odds do not name is "0%" only when the moves
// they do name and their switches make up all of them, exactly: a name that does not match is not a 0%, so such a move's
// cell is empty. At a replacement the list is the Pokémon it may send out, with the same odds. With `onSelect`, a row that
// has a move is a button that picks it (the caller shows its crit split); a switch or an item never is.
//
// Below the full AI odds (`PKP_AI_ODDS`, aiOdds.ts) the server sends no odds, and the panel draws no bar and no percent
// (`TheirMoves`): at `likeliest` one line names their likeliest move ("Bonsly's likeliest move: Stealth Rock", every move
// tied for it joined by "or") over their moves in their own order; at `ranked` the rows are in the AI's order, each with its
// place ("1st", "=2nd" for a shared one); at `off` it is "Their moves" alone, in their own order. Every move keeps its
// damage and KO words.

import type { AiOddsLevel } from '../../../../src/server/apiTypes';
import { orList, ordinal, rankText, useAiOdds } from '../../aiOdds';
import { aiOnly, koTitle, odds, priorityText, rangeText } from '../../line';
import { AI_NOT_MODELLED, barWidth, levelRows, REPLY_BLIND, type ReplyRow, replyRows, type StepPanel, topLabels } from '../../tree';
import { InfoTip } from '../InfoTip';
import { ServerWords } from '../ServerWords';

const TONE_CLASS = { danger: 'is-danger', warn: 'is-warn', zero: 'is-zero' } as const;

export interface TheirReplyProps { node: StepPanel; selected?: string; onSelect?(move: string): void }

/** Whether the step has the AI's odds to show: odds sent, and no AI error. */
const hasOdds = (node: StepPanel): boolean => node.aiOdds !== undefined && node.aiError === undefined;

function heading(node: StepPanel): string {
  if (aiOnly(node.phase)) return 'Next the trainer sends out';
  if (!hasOdds(node)) return 'Their moves';                                        // no odds to call a likelihood
  if (node.phase === 'turnChoice') return 'Next move likelihood';
  const active = node.view.player.active;
  return active === null ? 'Their reply' : `Their reply to ${active.name} (${active.hp}/${active.maxHp})`;
}

/** A row's cells. `plain` (below the full AI odds): no bar and no percent, and at `ranked` its place where the AI gives one. */
function RowBody({ row, plain = false }: { row: ReplyRow; plain?: boolean }) {
  const share = row.ai === null ? null : odds(row.ai);
  const { move } = row;
  const priority = move === null ? null : priorityText(move.priority);
  const type = move?.type ?? null;                                                  // absent reads as null
  const range = move === null ? '' : move.status ? 'Status move · no damage' : rangeText(move);
  const ko = move === null || move.status ? '' : row.ko;
  const rank = row.rank ?? null;
  return (
    <>
      <span className="likelihood-name">
        <span className="likelihood-move">{row.name}</span>
        {priority !== null && <>{' '}<span className="tree-reply-priority">{priority}</span></>}
        {type !== null && <>{' '}<span className="type-chip" data-type={type}>{type}</span></>}
      </span>
      {plain ? (
        rank !== null && (
          <span className="likelihood-rank tree-num" title={row.tied === true ? `Joint ${ordinal(rank)}: as likely as another` : undefined}>
            {rankText(rank, row.tied === true)}
          </span>
        )
      ) : (
        <>
          <span className={row.ai === null ? 'likelihood-bar is-unknown' : 'likelihood-bar'} aria-hidden="true"><span style={{ width: `${row.ai === null ? 0 : barWidth(row.ai)}%` }} /></span>
          <span className="likelihood-percent tree-num" title={share?.exact}>{share?.percent}</span>
        </>
      )}
      {range !== '' && <span className="likelihood-range">{range}</span>}
      {ko !== '' && (
        <span className="likelihood-ko" title={move === null ? undefined : koTitle(move)}>
          {row.tone === 'danger' ? <strong className="tree-reply-ko">{ko}</strong> : ko}
        </span>
      )}
    </>
  );
}

function Row({ row, selected, onSelect, plain = false }: { row: ReplyRow; selected?: string; onSelect?(move: string): void; plain?: boolean }) {
  const tone = row.tone === null ? '' : ` ${TONE_CLASS[row.tone]}`;
  return (
    <li className={`likelihood-row${tone}`}>
      {onSelect !== undefined && row.move !== null ? (
        <button type="button" className="likelihood-pick" aria-pressed={selected === row.name} onClick={() => onSelect(row.name)}>
          <RowBody row={row} plain={plain} />
        </button>
      ) : (
        <RowBody row={row} plain={plain} />
      )}
    </li>
  );
}

/** The panel below the full AI odds (see the top of the file). The server sends no odds at `off`, so none are read there. */
function TheirMoves({ node, selected, onSelect, level }: TheirReplyProps & { level: Exclude<AiOddsLevel, 'full'> }) {
  const { aiError, damage } = node;
  const aiOdds = level === 'off' ? undefined : node.aiOdds;
  if (aiOdds === undefined && aiError === undefined && damage === undefined) return null;
  const rows = levelRows(node, level);
  const turn = node.phase === 'turnChoice';
  const active = node.view.player.active;
  const ranked = level === 'ranked' && aiOdds !== undefined && aiError === undefined;
  const title = aiOnly(node.phase) ? 'Next the trainer sends out' : ranked ? 'Their moves, likeliest first' : 'Their moves';
  const top = level === 'likeliest' && aiError === undefined ? topLabels(node) : [];
  const enemy = node.view.enemy.active?.name;
  // The panel's one ⓘ: what the order or the named move is, how to see a move's split, and that the trainer picks blind.
  const about = !turn || active === null || aiOdds === undefined || aiError !== undefined ? null
    : level === 'likeliest' ? `The AI's likeliest move against ${active.name}.`
      : `Their moves in the AI's order of likelihood against ${active.name}; "=" marks a shared place.`;
  const pick = turn && onSelect !== undefined ? 'Pick a move to see its non-crit and crit damage.' : null;
  const tip = [about, pick, turn && aiError === undefined ? REPLY_BLIND : null].filter((words): words is string => words !== null).join(' ');
  return (
    <section className="tree-reply" aria-label="Their reply">
      <div className="tree-reply-head">
        <h4>{title}</h4>
        {tip !== '' && <InfoTip label={title}>{tip}</InfoTip>}
      </div>
      {aiError !== undefined && (
        <div className="banner banner-warn">
          <p>{AI_NOT_MODELLED}</p>
          <ServerWords text={aiError} />
        </div>
      )}
      {top.length > 0 && (
        <p className="tree-reply-likeliest">{enemy === undefined ? 'Their' : `${enemy}'s`} likeliest move: <strong>{orList(top)}</strong></p>
      )}
      {rows.length > 0 && (
        <ul className={ranked ? 'likelihood is-plain is-ranked' : 'likelihood is-plain'}>
          {rows.map((row, i) => <Row key={`${i}-${row.name}`} row={row} selected={selected} onSelect={onSelect} plain />)}
        </ul>
      )}
    </section>
  );
}

export function TheirReply({ node, selected, onSelect }: TheirReplyProps) {
  const level = useAiOdds();
  if (level !== 'full') return <TheirMoves node={node} selected={selected} onSelect={onSelect} level={level} />;
  return <TheirOdds node={node} selected={selected} onSelect={onSelect} />;
}

/** The panel at the full AI odds: every action's exact odds (see the top of the file). */
function TheirOdds({ node, selected, onSelect }: TheirReplyProps) {
  const { aiOdds, aiError, damage } = node;
  if (aiOdds === undefined && aiError === undefined && damage === undefined) return null;
  const rows = replyRows(node);
  const turn = node.phase === 'turnChoice';
  const active = node.view.player.active;
  const title = heading(node);
  // The panel's one ⓘ: what the odds are, and that the trainer picks blind.
  const odds = turn && active !== null && hasOdds(node)
    ? `The AI's exact odds against ${active.name}.${onSelect !== undefined ? ' Pick a move to see its non-crit and crit damage.' : ''}`
    : null;
  const tip = [odds, turn && aiError === undefined ? REPLY_BLIND : null].filter((words): words is string => words !== null).join(' ');
  return (
    <section className="tree-reply" aria-label="Their reply">
      <div className="tree-reply-head">
        <h4>{title}</h4>
        {tip !== '' && <InfoTip label={title}>{tip}</InfoTip>}
      </div>
      {aiError !== undefined && (
        // A state of the step, not an event: no live region. The AI's own words sit behind Details.
        <div className="banner banner-warn">
          <p>{AI_NOT_MODELLED}</p>
          <ServerWords text={aiError} />
        </div>
      )}
      {rows.length > 0 && (
        <ul className="likelihood">
          {rows.map((row, i) => <Row key={`${i}-${row.name}`} row={row} selected={selected} onSelect={onSelect} />)}
        </ul>
      )}
    </section>
  );
}
