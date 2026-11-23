// A whole-number field for the draft (its EXP, HP, IVs, EVs and levels). It keeps its own text while it is typed in and
// commits on blur or Enter, so a half-typed number ("1" on the way to "16") is never sent as an edit.

import { useState, type JSX } from 'react';

/**
 * A whole-number field. It keeps its own text while typed in and commits on blur or Enter: a whole number from `min` to
 * `max` goes to `onCommit`; anything else, or a commit `onCommit` answers false to, puts the text back to `value`. A
 * taken commit shows the new `value` the parent gives (which may differ from the text: a percent, say). The same number
 * as `value` is not sent. A text that is not a whole number from `min` to `max` (an emptied field included) calls
 * `onInvalid`, so the parent can say why it snapped back. A null value shows empty. The input is always `.draft-number`,
 * with `className` added.
 */
export function NumberField({ label, value, min, max, disabled = false, className, onCommit, onInvalid }: {
  label: string; value: number | null; min: number; max: number; disabled?: boolean; className?: string; onCommit(n: number): boolean;
  onInvalid?(): void;
}): JSX.Element {
  // null: not being typed in, so the field shows `value`.
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    setText(null);
    const n = Number(text);
    if (text.trim() === '' || !Number.isInteger(n) || n < min || n > max) onInvalid?.();
    else if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number" inputMode="numeric" aria-label={label} className={className === undefined ? 'draft-number' : `draft-number ${className}`}
      min={min} max={max} step={1} disabled={disabled}
      value={text ?? (value === null ? '' : String(value))}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
    />
  );
}
