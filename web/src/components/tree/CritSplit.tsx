// A move's non-crit and crit cases side by side: each row has its chance, its damage, the band over a full bar, and its KO words.
// Nothing here is a button or selectable. A row with no chance to give (a multi-hit move's, or a crit the server could not
// work out) shows none; a multi-hit move's rows say the one-hit chance in their title (`splitRows`). One row alone says
// why: "No crit possible" where the server says 0/1, "Crit not worked out here" where it sent no chance. The KO words'
// tone is `splitTone`'s.

import type { LineMoveDamageJson } from '../../../../src/server/apiTypes';
import { isCritRow, odds, splitRows, splitTone } from '../../line';
import { BandBar } from './DamageBand';

export interface CritSplitProps { move: LineMoveDamageJson; targetName: string; hot: 'mine' | 'theirs' }

const BASE_NOTE = " · base rate: the server did not work out this move's crit chance";
const TONE_CLASS = { danger: 'is-danger', ok: 'is-ok' } as const;

export function CritSplit({ move, targetName, hot }: CritSplitProps) {
  const rows = splitRows(move);
  const only = rows.length === 1 ? rows[0]! : null;
  return (
    <section className="crit-split" data-hot={hot} aria-label={`${move.name} on ${targetName}`}>
      {rows.length === 0 && <p className="crit-none">{move.status ? 'Status move · no damage' : (move.note ?? 'No damage figures here.')}</p>}
      {rows.map((row) => {
        const tone = splitTone(move, row, hot);
        const base = row.base ? BASE_NOTE : '';
        return (
          <div className="crit-row" key={row.label} title={row.title === undefined ? undefined : `${row.title}${base}`}>
            <span className="crit-label">{row.label}</span>
            {row.chance !== null && <span className="crit-chance" title={`${odds(row.chance).exact}${base}`}>({odds(row.chance).percent})</span>}
            <span className="crit-damage">{row.damage}</span>
            <BandBar move={move} percent={100} side={hot} crit={isCritRow(row)} />
            <span className={tone === null ? 'crit-ko' : `crit-ko ${TONE_CLASS[tone]}`}>{row.ko}</span>
          </div>
        );
      })}
      {only !== null && <p className="crit-none">{only.chance === null ? 'Crit not worked out here' : 'No crit possible'}</p>}
    </section>
  );
}
