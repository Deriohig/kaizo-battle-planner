// The plan screen's parts (components/plan/parts.ts) are the real tree and box components and drag contract, each tested
// in its own file; here they are checked as the same modules, and with what the plan screen hands them (a step answer as
// a `StepPanel`, the box and the draft).
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BoxAndTeam as RealBoxAndTeam } from '../../../web/src/components/plan/BoxAndTeam';
import { FieldRow as RealFieldRow } from '../../../web/src/components/plan/FieldRow';
import { MonToken as RealMonToken } from '../../../web/src/components/plan/MonToken';
import * as parts from '../../../web/src/components/plan/parts';
import type { StepPanel } from '../../../web/src/components/plan/planScreen';
import { CritSplit } from '../../../web/src/components/tree/CritSplit';
import { DamageBand } from '../../../web/src/components/tree/DamageBand';
import { TheirReply } from '../../../web/src/components/tree/TheirReply';
import { YourChoice } from '../../../web/src/components/tree/YourChoice';
import * as monDrag from '../../../web/src/monDrag';
import { AI_NOT_MODELLED } from '../../../web/src/tree';
import { BENCH, NUMBERS, SCRATCH, turnOdds, view } from './lineServer';

const panel = (over: Partial<StepPanel> = {}): StepPanel => ({ phase: 'turnChoice', view: view(), choices: [SCRATCH], damage: NUMBERS, aiOdds: turnOdds, ...over });

it('are the real components and the drag contract, under one type', () => {
  expect([parts.CritSplit, parts.DamageBand, parts.TheirReply, parts.YourChoice, parts.BoxAndTeam, parts.MonToken, parts.FieldRow])
    .toEqual([CritSplit, DamageBand, TheirReply, YourChoice, RealBoxAndTeam, RealMonToken, RealFieldRow]);
  expect([parts.readDraggedMon, parts.writeDraggedMon, parts.carriesMon]).toEqual([monDrag.readDraggedMon, monDrag.writeDraggedMon, monDrag.carriesMon]);
  expect(parts.MON_MIME).toBe(parts.MON_DRAG_TYPE);
});

it('take a step answer: the split and band of his move, their reply rows with exact odds, and his choices', () => {
  const { unmount } = render(<>
    <parts.CritSplit move={NUMBERS.yours[0]!} targetName="Imp" hot="mine" />
    <parts.DamageBand move={NUMBERS.yours[0]!} percent={100} side="theirs" crit />
  </>);
  expect(screen.getByRole('region', { name: 'Scratch on Imp' })).toHaveAttribute('data-hot', 'mine');
  expect(screen.getByText('Non-crit').parentElement).toHaveTextContent(/44–54%.*2HKO 39\.84%/);
  expect(screen.getByText('Crit').parentElement).toHaveTextContent(/90–108%.*OHKO 50% on a crit/);
  expect(document.querySelector('.band[data-side="theirs"] .band-range')).toHaveStyle({ left: '0%', width: '10%' });
  unmount();

  const onSelect = vi.fn();
  const reply = render(<parts.TheirReply node={panel()} selected="Sand-Attack" onSelect={onSelect} />);
  const rows = Array.from(document.querySelectorAll<HTMLElement>('li.likelihood-row'));
  expect(rows[0]).toHaveTextContent(/^Quick Attack.*9–11\.3%/);
  expect(rows[1]).toHaveTextContent(/^Sand-Attack/);
  expect(screen.getByTitle('5/8')).toHaveTextContent('62.5%');
  expect(screen.getByRole('button', { name: /^Sand-Attack/ })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: /^Quick Attack/ }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('Quick Attack');
  reply.rerender(<parts.TheirReply node={panel({ aiOdds: undefined, aiError: 'the AI could not be read' })} />);
  expect(screen.getByText(AI_NOT_MODELLED)).toBeInTheDocument();
  expect(screen.getByText('the AI could not be read').closest('details')).not.toBeNull();
  const shares = Array.from(document.querySelectorAll('.likelihood-percent')).map((cell) => cell.textContent);
  expect(shares.length).toBeGreaterThan(0);
  expect(shares.every((share) => share === '')).toBe(true);                // no move gets a share
  reply.unmount();

  const onChoose = vi.fn();
  const choice = render(<parts.YourChoice node={panel()} selected={null} working={null} busy={false} onChoose={onChoose} />);
  expect(screen.getByRole('button', { name: /Scratch/ })).toHaveAttribute('data-choice', 'm0');
  fireEvent.click(screen.getByRole('button', { name: /Scratch/ }));
  expect(onChoose).toHaveBeenCalledExactlyOnceWith(SCRATCH.choice);
  choice.rerender(<parts.YourChoice node={panel({ phase: 'playerReplacement', choices: [BENCH] })} selected={{ choice: BENCH.choice }} working={null} busy={false} onChoose={onChoose} />);
  expect(screen.getByRole('heading', { name: 'One of yours fainted: send out' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Bench/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /Bench/ })).toHaveTextContent('Bench 30/30');
});

it('MonToken at size l draws the initials and the level in a disc, then the name and the level with its note', () => {
  const { container } = render(<parts.MonToken name="Starly" level={14} types={['Normal', 'Flying']} size="l" note="over cap" />);
  expect(container.querySelector('.disc')).toHaveTextContent('St14');
  expect(container.querySelector('.disc')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByTitle('Starly')).toHaveTextContent('Starly');
  expect(screen.getByText('Lv 14 · over cap')).toBeInTheDocument();
});
