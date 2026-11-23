// A Pokémon's HP bar with the damage band of a move over its right end. The bar is decorative (aria-hidden): the numbers
// are always given in text beside it (`rangeText`). Geometry is in percent of the full bar (`bandParts`). A bar the lowest
// roll empties is drawn as a KO (`bandKo`).

import type { LineMoveDamageJson } from '../../../../src/server/apiTypes';
import { rangeText } from '../../line';

export interface DamageBandProps { move: LineMoveDamageJson | null; percent: number; side: 'mine' | 'theirs'; crit?: boolean }

/** The geometry in percent of the full bar. `range` and `ghost` are [from, to] edges; `low` is the solid segment's width, ending at `fill`. */
export interface BandParts { fill: number; low: number; range: [number, number]; ghost: [number, number] | null }

const clamp = (x: number): number => Math.min(100, Math.max(0, x));

/** The band's pieces: the damage comes off the right end of the fill, and a piece that would pass the left edge stops at 0. */
export function bandParts(move: LineMoveDamageJson | null, percent: number, crit: boolean): BandParts {
  const fill = clamp(Number.isFinite(percent) ? percent : 0);
  const none: BandParts = { fill, low: 0, range: [fill, fill], ghost: null };
  if (move === null || move.status) return none;
  const p = crit ? move.critPercent : move.percent;
  if (p === null) return none;
  const range: [number, number] = [clamp(fill - p[1]), clamp(fill - p[0])];
  const c = move.critPercent;
  const ghost: [number, number] | null = !crit && c !== null && move.percent !== null && c[1] > move.percent[1]
    ? [clamp(fill - c[1]), clamp(fill - move.percent[1])]
    : null;
  return { fill, low: Math.min(clamp(p[0]), fill), range, ghost };
}

/**
 * Whether the move's lowest roll takes all the HP the bar has (a KO on any roll, if it hits), unless a held item survives
 * the hit (`survives`). The bar is then drawn as a KO (`is-ko`, tree.css), never as a plain black bar.
 */
export function bandKo(move: LineMoveDamageJson | null, percent: number, crit = false): boolean {
  if (move === null || move.survives != null) return false;
  const b = bandParts(move, percent, crit);
  return b.fill > 0 && b.low >= b.fill;
}

/** The bar alone, no caption. Spans throughout (tree.css draws them as blocks): it sits inside a move tile's button. */
export function BandBar({ move, percent, side, crit = false }: DamageBandProps) {
  const b = bandParts(move, percent, crit);
  const at = (from: number, to: number) => ({ left: `${from}%`, width: `${to - from}%` });
  return (
    <span className={bandKo(move, percent, crit) ? 'band is-ko' : 'band'} data-side={side} aria-hidden="true">
      <span className="band-fill" style={{ width: `${b.fill}%` }} />
      {b.low > 0 && <span className="band-low" style={at(b.fill - b.low, b.fill)} />}
      {b.range[1] > b.range[0] && <span className="band-range" style={at(b.range[0], b.range[1])} />}
      {b.ghost !== null && b.ghost[1] > b.ghost[0] && <span className="band-ghost" style={at(b.ghost[0], b.ghost[1])} />}
    </span>
  );
}

/** The HP bar with the move's band over it, and a caption "{move}: {rangeText}". */
export function DamageBand(props: DamageBandProps) {
  const { move } = props;
  const text = move === null ? '' : move.status ? 'status move, no damage' : rangeText(move) || (move.percent === null ? move.note ?? '' : '');
  return (
    <>
      <BandBar {...props} />
      {move !== null && text !== '' && <p className="band-caption">{move.name}: {text}</p>}
    </>
  );
}
