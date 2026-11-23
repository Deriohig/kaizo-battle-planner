// Toy oracles for the checker's cross-checks (src/solver/check/checker.ts): they re-derive what a step's protocol lines
// must say from the toy rules and the step's chance labels, without calling the engine.
// Damage: each move's |-damage| line ('[from]' residuals aside) must take (roll + raw + 2 with guts while statused) × 2
// on a crit, capped at the target's HP, tracking HP, statuses and actives from `before`. bugDamagePlusOne is ignored on
// purpose (the oracle is the rules). Hits of `skip` moves count in `skipped` under the move's name, never as checks.
// Order: when both sides move, the first |move| or |cant| line is the higher priority, else the faster side; a full tie
// needs a speedTie label and then allows either order.

import type { ChanceKind, ChanceLabel, Side } from '../../../../src/contracts/engine.js';
import { cmp, isZero, ONE, ZERO } from '../../../../src/solver/rational.js';
import type { DamageOracle, OracleResult, SpeedOracle, StepContext } from '../../../../src/solver/types.js';
import { readToyState, STRUGGLE, toyMonOf, type ToyState } from './engine.js';
import type { ToyMove, ToyRegistry } from './game.js';

const toId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** 'p1a: Hero' → { side: 'p1', name: 'Hero' }. */
function positionOf(text: string | undefined): { side: Side; name: string } | null {
  const m = /^(p1|p2)a: (.*)$/.exec(text ?? '');
  return m === null ? null : { side: m[1] as Side, name: m[2]! };
}

/** '7/10' → 7, '0 fnt' → 0. */
function hpOf(text: string | undefined): number | null {
  if (text === '0 fnt') return 0;
  const m = /^(\d+)\/\d+$/.exec(text ?? '');
  return m === null ? null : Number(m[1]);
}

/** The move named `name` of `side`'s mon at party `index` (Struggle when it has no move of that name). */
function moveNamed(registry: ToyRegistry, s: ToyState, side: Side, index: number, name: string | undefined): ToyMove | null {
  const found = toyMonOf(registry, s, side, index).moves.find((m) => m.name === name);
  return found ?? (name === STRUGGLE.name ? STRUGGLE : null);
}

/** The step's labels, taken in draw order. */
class Labels {
  private cursor = 0;
  constructor(private readonly labels: ChanceLabel[]) {}

  /** The next label of this kind, side and source after the last one taken; null when there is none. */
  take(kind: ChanceKind, side: Side, source: string): ChanceLabel | null {
    for (let i = this.cursor; i < this.labels.length; i++) {
      const l = this.labels[i]!;
      if (l.kind !== kind || l.side !== side || l.source !== source) continue;
      this.cursor = i + 1;
      return l;
    }
    return null;
  }
}

interface Mover { side: Side; user: number; move: ToyMove }

/** What one hit must take, from the move's data and the hit's labels; mismatches go to `out`. */
function hitDamage(registry: ToyRegistry, s: ToyState, mover: Mover, targetHp: number, critLine: boolean, labels: Labels, out: string[]): number {
  const { side, move } = mover;
  const source = toId(move.name);
  const chance = move.critChance ?? ZERO;
  let crit = false;
  if (cmp(chance, ONE) >= 0) crit = true;
  else if (!isZero(chance)) {
    const label = labels.take('crit', side, source);
    if (label === null) out.push(`${move.name} by ${side}: no crit label`);
    crit = label?.outcome === 'crit';
  }
  if (crit !== critLine) out.push(`${move.name} by ${side}: the labels say ${crit ? 'a crit' : 'no crit'}, the log says ${critLine ? 'a crit' : 'no crit'}`);
  const values = [...new Set(move.damage)].sort((x, y) => x - y);
  let base = values[0] ?? 0;
  if (values.length > 1) {
    const label = labels.take('roll', side, source);
    const m = /^dmg=(\d+)$/.exec(label?.outcome ?? '');
    if (m === null) out.push(`${move.name} by ${side}: no roll label`);
    else base = Number(m[1]);
  }
  let extra = 0;
  if (move.effect === 'raw3') {
    const m = /^raw=(\d+)$/.exec(labels.take('raw', side, source)?.outcome ?? '');
    if (m === null) out.push(`${move.name} by ${side}: no raw label`);
    else extra = Number(m[1]);
  }
  if (toyMonOf(registry, s, side, mover.user).guts && s[side][mover.user]!.status !== 'none') extra += 2;
  const damage = (base + extra) * (crit ? 2 : 1);
  return Math.min(damage, targetHp);
}

function damageOracle(registry: ToyRegistry, skip: ReadonlySet<string>): DamageOracle {
  return {
    id: 'toy-damage@1',
    check({ before, outcome }: StepContext): OracleResult {
      const s = readToyState(before);
      const labels = new Labels(outcome.labels);
      const mismatches: string[] = [];
      const skipped: Record<string, number> = {};
      let checks = 0;
      let mover: Mover | null = null;
      let critLine = false;
      for (const line of outcome.log) {
        const parts = line.split('|');
        const at = positionOf(parts[2]);
        if (at === null) continue;
        const mon = s[at.side][s.active[at.side]]!;
        switch (parts[1]) {
          case 'switch': {
            const index = s[at.side].findIndex((m) => m.name === at.name && !m.fainted);
            if (index >= 0) s.active[at.side] = index;
            mover = null;
            break;
          }
          case 'move': {
            const user = s.active[at.side];
            const move = moveNamed(registry, s, at.side, user, parts[3]);
            if (move === null) mismatches.push(`unknown move in ${line}`);
            mover = move === null ? null : { side: at.side, user, move };
            critLine = false;
            break;
          }
          case '-crit':
            critLine = true;
            break;
          case '-heal': {
            const hp = hpOf(parts[3]);
            if (hp !== null) mon.hp = hp;
            break;
          }
          case '-status':
            if (parts[3] === 'slp') mon.status = 'sleep';
            break;
          case '-curestatus':
          case 'faint':
            mon.status = 'none';
            break;
          case '-damage': {
            const hp = hpOf(parts[3]);
            if (hp === null) {
              mismatches.push(`unreadable HP in ${line}`);
              break;
            }
            if (parts.some((p) => p.startsWith('[from]'))) {   // residual damage (burn), not a move's
              mon.hp = hp;
              break;
            }
            if (mover !== null && skip.has(mover.move.name)) {   // not cross-checked: named, never counted as a check
              skipped[mover.move.name] = (skipped[mover.move.name] ?? 0) + 1;
              mon.hp = hp;
              critLine = false;
              break;
            }
            checks += 1;
            if (mover === null) mismatches.push(`${line} follows no move`);
            else {
              const expected = hitDamage(registry, s, mover, mon.hp, critLine, labels, mismatches);
              const taken = mon.hp - hp;
              if (taken !== expected) mismatches.push(`${mover.move.name} by ${mover.side} took ${taken} HP from ${at.name}, expected ${expected}`);
            }
            mon.hp = hp;
            critLine = false;
            break;
          }
        }
      }
      return { checks, mismatches, ...(Object.keys(skipped).length === 0 ? {} : { skipped }) };
    },
  };
}

function speedOracle(registry: ToyRegistry): SpeedOracle {
  return {
    id: 'toy-speed@1',
    check({ before, choices, outcome }: StepContext): OracleResult {
      const s = readToyState(before);
      const { p1, p2 } = choices;
      if (s.phase.kind !== 'turnChoice' || p1?.kind !== 'move' || p2?.kind !== 'move') return { checks: 0, mismatches: [] };
      const contender = (side: Side, slot: number): { priority: number; speed: number } => {
        const user = s.active[side];
        const mon = s[side][user]!;
        const struggle = !mon.pp.some((pp) => pp === null || pp > 0);
        const move = struggle ? STRUGGLE : toyMonOf(registry, s, side, user).moves[slot];
        return { priority: move?.priority ?? 0, speed: mon.speed };
      };
      const a = contender('p1', p1.slot);
      const b = contender('p2', p2.slot);
      const expected: Side | null = a.priority !== b.priority ? (a.priority > b.priority ? 'p1' : 'p2')
        : a.speed !== b.speed ? (a.speed > b.speed ? 'p1' : 'p2') : null;
      const first = outcome.log.map((l) => l.split('|')).find((p) => p[1] === 'move' || p[1] === 'cant');
      const actual = positionOf(first?.[2])?.side ?? null;
      if (actual === null) return { checks: 1, mismatches: ['both sides chose a move, but no |move| or |cant| line'] };
      if (expected === null) {
        const tie = outcome.labels.some((l) => l.kind === 'speedTie');
        return { checks: 1, mismatches: tie ? [] : ['equal priority and speed, but no speedTie label'] };
      }
      return { checks: 1, mismatches: actual === expected ? [] : [`${actual} acted first; priority and speed say ${expected}`] };
    },
  };
}

/** The damage and order oracles over `registry`'s toy rules; the damage oracle does not cross-check `opts.skip`'s moves. */
export function toyOracles(registry: ToyRegistry, opts: { skip?: readonly string[] } = {}): { damage: DamageOracle; speed: SpeedOracle } {
  return { damage: damageOracle(registry, new Set(opts.skip ?? [])), speed: speedOracle(registry) };
}
