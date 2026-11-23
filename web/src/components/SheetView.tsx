// Matchups: the trainer's team against the player's as drafted, as cards in the tree screen's look. One bar on top
// holds the field, "Copy your team", "Copy trainer's team" and "Open PKCalc", the sheet's notes and the AI note; the
// trainer's name, the battle type, the trainer copy and the team are the fight page's, not repeated here. Then one card
// per trainer Pokémon (its level, item, ability, nature and Copy set), and in it one card per pair, in reading order:
// who (his Pokémon, its level, "over the level cap (N)" when it is, the HP, status and held item its numbers use, who
// moves first and both speeds, and his Copy set), "Your moves", "Their moves" and "Their reply". Four parts across on a
// wide screen, two at 1180 px, one at phone width. Each Copy set puts that Pokémon's Showdown import text on the
// clipboard, for PKCalc's Import box, and is named for whose set and which pair ("Copy their Koffing 2", "Copy your Raichu (against Koffing 2)").
//
// A move's damage is HP first, then the percent of the defender's max HP ("22–27 HP (44–54%)"; an equal range is one
// figure, "40 HP (40%)", and none is "0 HP"). Its KO chance is the calc's exact fraction through the odds formatter
// ("OHKO 6.25%"), the fraction on hover.
//
// Danger and uncertainty read in words as well as colour: red for a real one-hit KO chance ("OHKO 31.25%", "KO if it
// hits (N%)"), and a pair where one of theirs has one gets a red edge and "Can KO you in one hit"; amber "KO ?" for a move
// nothing bounds; "depends on weather" for the worse of a pair's weather cases, each case in a fold of its
// own at the foot of the pair.
//
// Given `ai`, each pair's Their reply is the AI's odds for its next action and whom it sends in if its
// Pokémon faints (sheet/AiOdds.tsx), "Working out the AI…" until they come, under one note in the bar that these are the
// AI's odds in that situation, not a proof. A request that failed is one line there, and the pairs go on without Their
// reply. A double battle's note says the odds are for single battles only, and its pairs have no Their reply.
//
// Between the bar and the first section, two rows of chips: "Show" one of yours or All, a filter held in
// this view's state (it is All again when that Pokémon leaves the team) that scrolls with the page, and "Go to" one of his
// Pokémon (scrolls its card to the top and focuses its heading), the only row that sticks under the app header. Shared
// notes and "Copy your team" always cover everyone, filter or not.

import { useEffect, useId, useRef, useState } from 'react';
import type { SheetJson, SheetMonJson, SheetMoveJson, SheetPairCaseJson, SheetPairJson } from '../../../src/server/apiTypes';
import { useAiOdds } from '../aiOdds';
import { damageRange, formatChance, formatOdds } from '../format';
import { type SideSpeed, speedOrder, statusLabel, trainerName } from '../labels';
import { teamText } from '../teamText';
import { CopyButton } from './CopyButton';
import { MoveTile } from './MoveTile';
import { InfoTip } from './InfoTip';
import { AiNote, aiNoteAt, AiOdds, type RowAi, type SheetAi } from './sheet/AiOdds';
import { fieldLabel, sameField } from './sheet/field';
import { MatchupsNav } from './sheet/MatchupsNav';
import { enemyLabels, monName } from './sheet/names';
import { SHARED_PREFIX, splitNotes, type NoteLine } from './sheet/notes';

export const PKCALC_URL = 'https://pkcalc.anastarawneh.com';
/** A dispute with more options than this shows their count, with the list in its title. */
const LISTED_OPTIONS = 3;

type Order = SheetPairJson['order'];
type Dispute = SheetMonJson['disputed'][number];

/**
 * Who moves first and both Speeds, in the plan's words (`speedOrder`): "Purugly moves first · Speed 48 vs 41", each
 * Speed titled with whose it is; "Either may go first (see notes)" points at the pair's notes. `title` is on the two Speeds.
 */
function OrderWords({ order, player, enemy, playerSpeed, enemySpeed, title }: {
  order: Order; player: string; enemy: string; playerSpeed: number; enemySpeed: number; title?: string;
}) {
  const { words, speeds } = speedOrder(order, player, enemy, playerSpeed, enemySpeed);
  const speed = (s: SideSpeed) => <span title={s.side === 'player' ? 'Your Speed' : `${enemy}'s Speed`}>{s.speed}</span>;
  return (
    <>
      <span className={`sheet-order-${order}`}>{order === 'depends' ? `${words} (see notes)` : words}</span>
      {speeds !== null && <>{' · '}Speed <span title={title}>{speed(speeds[0])} vs {speed(speeds[1])}</span></>}
    </>
  );
}

/** A pair's field with nothing set: its order line leaves the field out. */
const EMPTY_FIELD = 'No weather';

const WEATHER_DEPENDS_TITLE ='The weather here is not settled: these numbers are the worse case for you, statistic by statistic. The weather folds at the foot of this pair hold each case\'s numbers.';

/**
 * The sheet for one trainer copy. `ai` is the trainer AI's odds for this sheet; left out, the sheet has no AI. `levelCap`
 * is the save's level cap: his Pokémon above it say so in each of their pairs.
 */
export function SheetView({ sheet, ai, onRetry, levelCap }: { sheet: SheetJson; ai?: SheetAi; onRetry?: () => void; levelCap?: number }) {
  // A failed request and a double leave the pairs without Their reply: the note in the bar says why, once.
  const rowAi = ai?.state === 'failed' || sheet.trainer.battleType === 'double' ? undefined : ai;
  // The filter is this view's state: another trainer copy's sheet mounts a new view, and a Pokémon that left is All again.
  const [chosen, setChosen] = useState<string | null>(null);
  const only = chosen !== null && sheet.players.some((player) => player.key === chosen) ? chosen : null;
  // A choice whose Pokémon has left is dropped, so it does not come back if that Pokémon returns.
  useEffect(() => { if (chosen !== null && only === null) setChosen(null); }, [chosen, only]);
  const visible = only === null ? sheet.players : sheet.players.filter((player) => player.key === only);
  const labels = enemyLabels(sheet.enemies);
  const sections = useRef(new Map<string, { section: HTMLElement | null; heading: HTMLElement | null }>());
  const sheetRef = useRef<HTMLDivElement>(null);
  const hasNav = sheet.enemies.length >= 2 || sheet.players.length >= 2;

  // The one "Show / Go to" bar sticks under the app's own bars: its height is a custom property on the sheet, for the sections' scroll margin.
  useEffect(() => {
    const root = sheetRef.current;
    if (root === null || typeof ResizeObserver === 'undefined') return undefined;
    // Not tied to one nav node: the sheet root is observed too (its size changes when a hidden tab is shown), and each
    // callback re-queries the nav that is mounted now, re-attaching the observer if it is a different node.
    let observed: HTMLElement | null = null;
    const write = () => {
      const navEl = root.querySelector<HTMLElement>('.matchups-nav');
      if (navEl !== observed) {
        if (observed !== null) observer.unobserve(observed);
        if (navEl !== null) observer.observe(navEl);
        observed = navEl;
      }
      root.style.setProperty('--matchups-nav-height', `${navEl?.offsetHeight ?? 0}px`);
    };
    const observer = new ResizeObserver(write);
    observer.observe(root);
    write();
    return () => observer.disconnect();
  }, [hasNav]);

  const jump = (enemyKey: string) => {
    const entry = sections.current.get(enemyKey);
    if (entry === undefined) return;
    if (typeof entry.section?.scrollIntoView === 'function') entry.section.scrollIntoView({ block: 'start' });
    entry.heading?.focus({ preventScroll: true });
  };

  return (
    <div className="sheet" ref={sheetRef}>
      <MatchupBar sheet={sheet} ai={ai} onRetry={onRetry} />
      <MatchupsNav
        enemies={sheet.enemies.map((enemy, index) => ({ key: enemy.key, label: labels[index] ?? enemy.name }))}
        players={sheet.players.map((player) => ({ key: player.key, label: monName(player) }))}
        only={only} onJump={jump} onOnly={setChosen}
      />
      {sheet.enemies.map((enemy, index) => (
        <EnemySection
          key={enemy.key} enemy={enemy} label={labels[index] ?? enemy.name} players={sheet.players} shown={visible} pairs={sheet.pairs} ai={rowAi} levelCap={levelCap}
          barField={sheet.trainer.field}
          register={(section, heading) => { sections.current.set(enemy.key, { section, heading }); }}
        />
      ))}
    </div>
  );
}

/**
 * The bar, one line: the field ("Rain all fight"), the three actions (Copy your team only with someone in it) and one ⓘ
 * holding the sheet's notes and the AI note. A double's note and a failed request stay in view; the docs' field note
 * is left out where it only repeats the field.
 */
function MatchupBar({ sheet, ai, onRetry }: { sheet: SheetJson; ai: SheetAi | undefined; onRetry: (() => void) | undefined }) {
  const { trainer, notes } = sheet;
  const theirs = teamText(sheet.enemies.map((enemy) => enemy.showdown));
  const yours = teamText(sheet.players.map((mon) => mon.showdown));
  const double = trainer.battleType === 'double';
  const level = useAiOdds();
  const tip = [
    ...notes.filter((note) => trainer.field === null || note.trim().toLowerCase() !== `docs field note: ${trainer.field}`.toLowerCase()),
    ...(ai !== undefined && !double && ai.state !== 'failed' ? [aiNoteAt(level)] : []),
  ].map((line) => (/[.!?]$/.test(line.trim()) ? line.trim() : `${line.trim()}.`)).join(' ');
  return (
    <header className="matchup-bar">
      {trainer.field !== null && <p className="matchup-field">{fieldLabel(trainer.field)}</p>}
      <div className="matchup-actions">
        {yours !== '' && <CopyButton text={yours} label="Copy your team" title="Copy your team as Showdown import text, for PKCalc's Import box" />}
        {theirs !== '' && (
          <CopyButton text={theirs} label="Copy trainer's team" title={`Copy ${trainerName(trainer.name)}'s team as Showdown import text, for PKCalc's Import box`} />
        )}
        <a className="sheet-pkcalc" href={PKCALC_URL} target="_blank" rel="noreferrer">Open PKCalc</a>
      </div>
      {tip !== '' && <InfoTip label="matchups">{tip}</InfoTip>}
      {ai !== undefined && <AiNote ai={ai} double={double} onRetry={onRetry} />}
    </header>
  );
}

/** One trainer Pokémon: its head line, then one card per pair. `ai` undefined leaves every pair without Their reply. */
function EnemySection({ enemy, label, players, shown, pairs, ai, levelCap, barField, register }: {
  enemy: SheetMonJson; label: string; players: SheetMonJson[]; shown: SheetMonJson[]; pairs: SheetPairJson[]; ai: RowAi | undefined; levelCap: number | undefined;
  barField: string | null;
  register(section: HTMLElement | null, heading: HTMLElement | null): void;
}) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { register(sectionRef.current, headingRef.current); });
  const dispute = (field: Dispute['field']) => enemy.disputed.find((d) => d.field === field);
  const abilityDispute = dispute('ability');
  const natureDispute = dispute('nature');
  // Shared notes read every pair of his, not only the ones the filter shows.
  const enemyPairs = players.map((player) => pairs.find((pair) => pair.player === player.key && pair.enemy === enemy.key)).filter((pair) => pair !== undefined);
  const { shared, own } = splitNotes(enemyPairs);
  return (
    <section className="matchup-enemy" aria-labelledby={headingId} ref={sectionRef}>
      <div className="matchup-enemy-head">
        <h3 id={headingId} tabIndex={-1} ref={headingRef}>{enemy.name} <span className="sheet-level">Lv {enemy.level}</span></h3>
        <dl className="sheet-facts">
          <div><dt>Item</dt><dd>{enemy.item ?? 'No item'}</dd></div>
          <div><dt>Ability</dt><dd>{enemy.ability}{abilityDispute !== undefined && <Disputed dispute={abilityDispute} />}</dd></div>
          <div>
            <dt>Nature</dt>
            <dd>
              {enemy.nature ?? <span title="No source gives a nature; the numbers use a neutral one">Unknown (neutral)</span>}
              {natureDispute !== undefined && <Disputed dispute={natureDispute} />}
            </dd>
          </div>
        </dl>
        <CopySet mon={enemy} name={`Copy their ${label}`} />
        {shared.length > 0 && (
          <ul className="matchup-shared-notes">
            {shared.map((line) => <li key={line.text} className={line.warn ? 'sheet-note-warn' : undefined}>{SHARED_PREFIX + line.text}</li>)}
          </ul>
        )}
      </div>
      {players.length === 0 ? (
        <p className="sheet-empty">Add a Pokémon to the team to see matchups.</p>
      ) : (
        // role="list": the pairs' `list-style: none` would otherwise drop the list semantics in Safari/VoiceOver.
        <ul className="matchup-pairs" role="list">
          {shown.map((player) => (
            <PairCard
              key={player.key} player={player} enemy={enemy} label={label} ai={ai} levelCap={levelCap} barField={barField}
              pair={pairs.find((pair) => pair.player === player.key && pair.enemy === enemy.key)} own={own}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "disputed: Hardy or Adamant": the options, the one the numbers use first; more than `LISTED_OPTIONS` read as a
 * count ("disputed: one of 25"), and a single option (a source nothing contradicts, unchecked) as "disputed". The
 * title lists every option.
 */
function Disputed({ dispute }: { dispute: Dispute }) {
  const { field, options } = dispute;
  const text = options.length <= 1 ? 'disputed'
    : options.length <= LISTED_OPTIONS ? `disputed: ${options.join(' or ')}`
      : `disputed: one of ${options.length}`;
  const title = options.length <= 1
    ? `This ${field} comes from one source and is not confirmed. The numbers use the one shown; an in-game check should settle it.`
    : `This ${field} may be ${options.join(', ')}. The numbers use the one shown; an in-game check should settle it.`;
  return (
    <>
      {' '}
      <span className="sheet-disputed" title={title}>{text}</span>
    </>
  );
}

/**
 * One pair, his Pokémon against theirs: who, "Your moves", "Their moves" and "Their reply" (left out when `ai` is, and the
 * card is then `.no-reply`), then the pair's notes and its weather cases when it has any. A red edge and "Can KO you in
 * one hit" when one of their moves can (a weather case's moves do not count: the moves above already hold the worse of
 * them). A pair the sheet has no matchup for keeps who and says so.
 */
function PairCard({ player, enemy, label, pair, ai, levelCap, barField, own }: {
  player: SheetMonJson; enemy: SheetMonJson; label: string; pair: SheetPairJson | undefined; ai: RowAi | undefined; levelCap: number | undefined;
  barField: string | null;
  own: (pair: SheetPairJson) => NoteLine[];
}) {
  const headingId = useId();
  if (pair === undefined) {
    return (
      <li className="matchup-pair no-reply" aria-labelledby={headingId}>
        <Who player={player} headingId={headingId} levelCap={levelCap} label={label} />
        <p className="sheet-empty">No matchup for this pair.</p>
      </li>
    );
  }
  const danger = pair.enemyMoves.some((move) => koView(move).oneHit);
  const cases = pair.weatherCases ?? [];
  const notes = own(pair);
  const className = ['matchup-pair', ...(danger ? ['is-danger'] : []), ...(ai === undefined ? ['no-reply'] : [])].join(' ');
  return (
    <li className={className} aria-labelledby={headingId}>
      <Who player={player} headingId={headingId} levelCap={levelCap} label={label} pair={pair} enemy={enemy} danger={danger} barField={barField} />
      <div className="matchup-side">
        <p className="matchup-label">Your moves</p>
        <MoveList moves={pair.playerMoves} defenderHp={enemy.stats.hp} side="player" />
      </div>
      <div className="matchup-side">
        <p className="matchup-label">Their moves</p>
        <MoveList moves={pair.enemyMoves} defenderHp={player.stats.hp} side="enemy" />
      </div>
      {ai !== undefined && (
        <div className="matchup-reply">
          <p className="matchup-label">Their reply</p>
          <AiOdds ai={ai} player={pair.player} enemy={pair.enemy} />
        </div>
      )}
      {notes.length > 0 && (
        <ul className="matchup-notes">
          {notes.map((line, index) => <li key={index} className={line.warn ? 'sheet-note-warn' : undefined}>{line.text}</li>)}
        </ul>
      )}
      {cases.length > 0 && (
        <div className="matchup-cases">
          <p className="sheet-cases-head">
            Weather cases for {monName(player)} against {enemy.name}: each move above is the worse of these for you.
          </p>
          {cases.map((weatherCase, index) => <WeatherCase key={index} weatherCase={weatherCase} player={player} enemy={enemy} />)}
        </div>
      )}
    </li>
  );
}

/**
 * A pair's who: his Pokémon and its level, "over the level cap (N)" when it is, what its numbers use (`MonState`), then
 * (given the pair) who moves first, both speeds and the field ("Weather not settled" when it is not), "Can KO you in one
 * hit" when `danger`, and his Copy set.
 */
function Who({ player, headingId, levelCap, label, pair, enemy, danger = false, barField = null }: {
  player: SheetMonJson; headingId: string; levelCap: number | undefined; label: string; pair?: SheetPairJson; enemy?: SheetMonJson; danger?: boolean;
  barField?: string | null;
}) {
  const over = levelCap !== undefined && player.level > levelCap;
  const speedTitle = (pair?.weatherCases ?? []).length > 0 ? 'Your lowest Speed and its highest over the weather cases' : undefined;
  return (
    <div className="matchup-who">
      <h4 id={headingId}>{monName(player)} <span className="sheet-level">Lv {player.level}</span></h4>
      {over && <span className="pill matchup-over">{`over the level cap (${levelCap})`}</span>}
      <MonState mon={player} />
      {pair !== undefined && enemy !== undefined && (
        <p className="matchup-order">
          <OrderWords
            order={pair.order} player={monName(player)} enemy={enemy.name} playerSpeed={pair.playerSpeed} enemySpeed={pair.enemySpeed} title={speedTitle}
          />
          {pair.field !== EMPTY_FIELD && !sameField(barField, pair.field) && (
            <>
              {' · '}
              {pair.field === null ? <span className="sheet-flag" title={WEATHER_DEPENDS_TITLE}>Weather not settled</span> : `Field: ${pair.field}`}
            </>
          )}
        </p>
      )}
      {danger && <p className="matchup-danger">Can KO you in one hit</p>}
      <CopySet mon={player} name={`Copy your ${monName(player)} (against ${label})`} />
    </div>
  );
}

/**
 * What his Pokémon's numbers are built on, in the team column's words: "HP 5/46" when it is not at full HP, its status
 * ("Burned"), and "Held item: Oran Berry"; nothing at full HP with no status and no item.
 */
function MonState({ mon }: { mon: SheetMonJson }) {
  const parts = [
    ...(mon.hp < mon.stats.hp ? [`HP ${mon.hp}/${mon.stats.hp}`] : []),
    ...(mon.status !== null ? [statusLabel(mon.status)] : []),
    ...(mon.item !== null ? [`Held item: ${mon.item}`] : []),
  ];
  if (parts.length === 0) return null;
  return <p className="matchup-state" title="The HP, status and held item these numbers use, as the team has them">{parts.join(' · ')}</p>;
}

/** One weather case, folded: "If <when> · <field>", then that case's order, speeds and both sides' moves. */
function WeatherCase({ weatherCase, player, enemy }: { weatherCase: SheetPairCaseJson; player: SheetMonJson; enemy: SheetMonJson }) {
  const c = weatherCase;
  return (
    <details className="sheet-case">
      <summary>If {c.when === '' ? 'this case' : c.when} · {c.field}</summary>
      <div className="sheet-case-body">
        <p className="sheet-case-meta">
          <OrderWords order={c.order} player={monName(player)} enemy={enemy.name} playerSpeed={c.playerSpeed} enemySpeed={c.enemySpeed} />
          {' · '}{enemy.name}'s ability: {c.enemyAbility}
        </p>
        <div className="sheet-case-moves">
          <div>
            <span className="sheet-case-label">Your moves</span>
            <MoveList moves={c.playerMoves} defenderHp={enemy.stats.hp} side="player" />
          </div>
          <div>
            <span className="sheet-case-label">Their moves</span>
            <MoveList moves={c.enemyMoves} defenderHp={player.stats.hp} side="enemy" />
          </div>
        </div>
      </div>
    </details>
  );
}

type Side = 'player' | 'enemy';

function MoveList({ moves, defenderHp, side }: { moves: SheetMoveJson[]; defenderHp: number; side: Side }) {
  if (moves.length === 0) return <span className="sheet-empty">No moves</span>;
  return (
    <ul className="sheet-moves">
      {moves.map((move, index) => <MoveCell key={index} move={move} defenderHp={defenderHp} side={side} />)}
    </ul>
  );
}

/**
 * One move: its damage in HP and as % of the defender's max HP ("?" when nothing bounds it), the KO text (an exact chance,
 * its fraction on hover), the hit chance below 100%, and the flags. An enemy move with a real chance to KO in one use (a
 * one-use KO chance, or an OHKO move that can land) is marked as danger; an enemy move nothing bounds is marked unknown,
 * in amber (thousands of red "KO ?" cells would bury the real OHKOs, and "KO ?" already says it in words).
 */
function MoveCell({ move, defenderHp, side }: { move: SheetMoveJson; defenderHp: number; side: Side }) {
  const ko = koView(move);
  const danger = side === 'enemy' && ko.oneHit;
  const unknown = side === 'enemy' && ko.unknown;
  const inaccurate = move.inaccurate || move.hitChance < 1;
  // "is-ko-unknown" marks "KO ?" on either side (amber, as before); "is-unknown" (the dashed edge) is the enemy's alone.
  const cellClass = ['sheet-move', ...(danger ? ['is-danger'] : unknown ? ['is-unknown'] : []), ...(ko.unknown ? ['is-ko-unknown'] : [])].join(' ');
  const { damage } = move;
  const flags = move.hitChance < 1 || inaccurate || move.unmodelled !== null || move.weatherDepends;
  return (
    <li className={cellClass} title={moveTitle(move, defenderHp)}>
      <MoveTile
        name={move.name}
        damage={damage === null ? undefined : damage.bounded ? keepRange(damageRange([damage.min, damage.max], damage.percent)) : '?'}
        ko={ko.text} koTitle={ko.title} koTone={danger ? 'danger' : null}
        extra={flags ? (
          <>
            {move.hitChance < 1 && <span className="sheet-move-hit">{formatChance(move.hitChance)} to hit</span>}
            {inaccurate && <span className="sheet-flag">inaccurate</span>}
            {move.unmodelled !== null && <span className="sheet-flag" title={move.unmodelled}>unmodelled</span>}
            {move.weatherDepends && <span className="sheet-flag" title={WEATHER_DEPENDS_TITLE}>depends on weather</span>}
          </>
        ) : undefined}
      />
    </li>
  );
}

/**
 * A damage range ("22–27 HP (44–54%)") kept whole: U+2060 WORD JOINER after each en dash and U+00A0 between a figure and
 * "HP", so the only place a line can break is the space before "(".
 */
function keepRange(text: string): string {
  return text.replace(/–/g, '–⁠').replace(/(\d) HP/g, '$1 HP');
}

/** One Pokémon's Copy set button, named by `name` ("Copy their Koffing 2", "Copy your Raichu (against Koffing 2)"). */
function CopySet({ mon, name }: { mon: SheetMonJson; name: string }) {
  return (
    <CopyButton
      text={mon.showdown} label="Copy set" name={name} title={`Copy ${monName(mon)} as Showdown import text, for PKCalc's Import box`}
    />
  );
}

type Damage = NonNullable<SheetMoveJson['damage']>;

/** One KO chance as printed: its number of uses, whether it is above 0, its percent and its title. */
interface KoFigure { hits: number; some: boolean; percent: string; title: string }

/**
 * A move's KO chances for 1 to 4 uses, fewest first: each the calc's exact fraction (`koExact`) through the odds
 * formatter ("6.25%"), titled with that fraction ("1/16"). A pair's own cell when its weather is not settled has, for
 * each number of uses, the worse case's fraction. Null when the move has no KO chances.
 */
function koFigures(damage: Damage): KoFigure[] | null {
  if (damage.koExact === null) return null;
  return [...damage.koExact].sort((a, b) => a.hits - b.hits).map(({ hits, num, den }) => ({
    hits, some: num !== '0', percent: tinyPercent(num, den) ?? formatOdds(`${num}/${den}`).percent, title: `${num}/${den}`,
  }));
}

/** "<0.1%" for a chance above 0 and under 0.1%: the calc's exact tail digits are false precision here (the title keeps them). */
function tinyPercent(num: string, den: string): string | null {
  const n = BigInt(num);
  return n > 0n && n * 1000n < BigInt(den) ? '<0.1%' : null;
}

/** The fewest hits with a chance above 0, or null when 1 to 4 hits never KO. */
function firstKo(figures: KoFigure[]): KoFigure | null {
  return figures.find(({ some }) => some) ?? null;
}

/** Whether an OHKO move can land on the defender at all: it KOs in one use when it hits. */
function ohkoLands(move: SheetMoveJson, figures: KoFigure[]): boolean {
  return (figures.find((figure) => figure.hits === 1)?.some ?? false) && move.hitChance > 0;
}

/** A move's KO text and its title, whether it has a real chance to KO in one use, and whether its KO chance is unknown. */
interface KoView { text: string; title?: string; oneHit: boolean; unknown: boolean }
const NO_KO: KoView = { text: '', oneHit: false, unknown: false };

/**
 * "KO ?" for a move nothing bounds (it may KO in one, for all anyone knows, but nothing says it can); "KO if it hits
 * (N%)", N the hit chance, for an OHKO move that can land; else the fewest hits that may KO ("2HKO 75%", titled "3/4").
 * Nothing (no "—") for no damage, no KO chance, or no KO in 1 to 4 hits.
 */
function koView(move: SheetMoveJson): KoView {
  const { damage } = move;
  if (damage === null) return NO_KO;
  if (!damage.bounded) return { text: 'KO ?', oneHit: false, unknown: true };
  const figures = koFigures(damage);
  if (figures === null) return NO_KO;
  if (damage.ohko) return ohkoLands(move, figures) ? { text: `KO if it hits (${formatChance(move.hitChance)})`, oneHit: true, unknown: false } : NO_KO;
  const ko = firstKo(figures);
  return ko === null ? NO_KO : { text: `${koName(ko.hits)} ${ko.percent}`, title: ko.title, oneHit: ko.hits === 1, unknown: false };
}

const koName = (hits: number) => (hits === 1 ? 'OHKO' : `${hits}HKO`);

/**
 * HP as a percent of max HP, rounded down to 0.1 as the calc rounds a move's `percent` (src/calc/calc.ts `percentOf`), so
 * a crit's percent agrees with the damage line's: a fixed-damage move's 16 HP is the same 26.6% of 60 HP on both.
 */
const percentOfMax = (hp: number, maxHp: number) => Math.floor((hp * 1000) / maxHp) / 10;

/**
 * The cell's tooltip: the move, the HP damage, the crit range, all 16 rolls, every KO chance and the hit chance. A move
 * nothing bounds says so in place of its numbers, which bound nothing; an OHKO move says whether it can land.
 */
function moveTitle(move: SheetMoveJson, defenderHp: number): string {
  const lines = [`${move.name}: ${move.type}, ${move.category}${move.power > 0 ? `, ${move.power} power` : ''}`];
  const damage = move.damage;
  if (damage !== null && !damage.bounded) {
    lines.push('Damage ?: the calc cannot bound it, so it may do any damage and its KO chance is unknown');
  } else if (damage !== null) {
    lines.push(`Damage ${damageRange([damage.min, damage.max], damage.percent)}`);
    const figures = koFigures(damage);
    if (damage.ohko) {
      const lands = figures !== null && ohkoLands(move, figures);
      lines.push(lands ? `OHKO move: it KOs whenever it hits, ${formatChance(move.hitChance)} of the time` : 'OHKO move: it cannot land on this target');
    } else {
      if (damage.critRolls.length > 0) {
        const low = Math.min(...damage.critRolls);
        const high = Math.max(...damage.critRolls);
        lines.push(`Crit ${damageRange([low, high], [percentOfMax(low, defenderHp), percentOfMax(high, defenderHp)])}`);
      }
      lines.push(`Rolls: ${damage.rolls.join(', ')}`);
      if (figures !== null && figures.length > 0) {
        lines.push(`KO chance, no crits: ${figures.map(({ hits, percent }) => `${koName(hits)} ${percent}`).join(', ')}`);
      }
    }
  }
  if (damage !== null && damage.desc !== '') lines.push(damage.desc);
  lines.push(`Hit chance: ${formatChance(move.hitChance)}`);
  if (move.weatherDepends) lines.push(`Depends on weather: ${WEATHER_DEPENDS_TITLE}`);
  if (move.unmodelled !== null) lines.push(`Unmodelled: ${move.unmodelled}`);
  return lines.join('\n');
}
