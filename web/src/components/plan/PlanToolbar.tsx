// The plan's toolbar (under the turn chips): a name and Save a copy (PlanView lists the saved plans
// under it, with Open and Delete, while the plan is on the page), Copy plan (the turns and notes
// as text, `planText`), Edit team (the draft editor, shown as a band above the grid), the world when the answer
// has more than one, and, apart at the right end, Clear plan (the click clears at once; PlanView offers Undo).
//
// The name box is the name the next Save a copy uses. Opening a saved copy fills it with that copy's name (PlanView holds
// it, as an opened copy arrives from there); Save a copy empties it again, showing the placeholder, because the plan on
// the page stays the working plan and the copy is a separate saved plan (I1, I3).
//
// Copy plan says how it went in words beside it and through the page's one status region (`onSay`), so it is not
// lane-shared `CopyButton`, which carries a status region of its own.

import { type JSX, useEffect, useId, useRef, useState } from 'react';
import { copyText } from '../../clipboard';
import { planText } from '../../planStore';
import { savedCopyText, type UsePlan } from '../../usePlan';
import { busyAria } from '../busy';

const COPIED_MS = 2000;

export function PlanToolbar({ plan, name, onName, trainer, copies, lead, teamOpen, onToggleTeam, onClear, onSay }: {
  plan: UsePlan;
  /** The plan's name box, and its change. */
  name: string; onName(name: string): void;
  /** The trainer's name and how many copies of the fight there are, for the copied text's first line. */
  trainer: string; copies: number;
  /** The lead's name, for the name's placeholder. */
  lead: string;
  teamOpen: boolean; onToggleTeam(): void;
  onClear(): void;
  /** Says words in the page's status region. */
  onSay?(words: string): void;
}): JSX.Element | null {
  const nameId = useId();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const shown = plan.plan;
  if (shown === null) return null;
  const n = shown.turns.length;
  const placeholder = `${lead}, ${n} ${n === 1 ? 'turn' : 'turns'}`;
  const worlds = plan.answer?.worlds ?? plan.stale?.worlds;

  // Never replaces a saved plan: a name in use (the placeholder repeats at the same turn count) takes a free one, said.
  const save = () => {
    const wanted = name.trim() === '' ? placeholder : name.trim();
    const as = plan.saveCopy(wanted);
    onName('');
    onSay?.(savedCopyText(wanted, as));
  };
  const copy = async () => {
    const ok = await copyText(planText({ trainer, copies }, shown));
    if (!mounted.current) return;
    setCopied(ok ? 'copied' : 'failed');
    onSay?.(ok ? 'Plan copied.' : 'The plan could not be copied.');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), COPIED_MS);
  };

  return (
    <div className="plan-toolbar" role="group" aria-label="Plan">
      <label htmlFor={nameId} className="visually-hidden">Plan name</label>
      <input
        id={nameId} type="text" className="plan-name" value={name} placeholder={placeholder}
        onChange={(e) => onName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
      />
      <button type="button" className="button" onClick={save}>Save a copy</button>
      <span className="plan-copy">
        <button type="button" className="button" title="Copy the turns and notes as text" onClick={() => void copy()}>Copy plan</button>
        {copied !== 'idle' && <span className={copied === 'failed' ? 'plan-copy-state is-failed' : 'plan-copy-state'}>{copied === 'copied' ? 'Copied' : 'Not copied'}</span>}
      </span>
      <button type="button" className="button" aria-expanded={teamOpen} onClick={onToggleTeam}>Edit team</button>
      {worlds !== undefined && worlds.length > 0 && (
        <label className="plan-world">
          World{' '}
          <select
            value={shown.start.world} aria-disabled={busyAria(plan.busy)}
            onChange={(e) => { if (!plan.busy) void plan.setWorld(Number(e.target.value)); }}
          >
            {worlds.map((w) => <option key={w.index} value={w.index}>{w.label}</option>)}
          </select>
        </label>
      )}
      <button type="button" className="button plan-clear" onClick={onClear}>Clear plan</button>
    </div>
  );
}
