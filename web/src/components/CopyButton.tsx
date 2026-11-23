// A button that puts text on the clipboard (`copyText`), for PKCalc's Import box, with a status beside it that says
// "Copied" or "Copy failed" for two seconds. The sheet's Copy set and team buttons and the box's Copy party and Copy
// box buttons are all one of these.

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';

/** How long "Copied" or "Copy failed" stays up. */
const COPIED_MS = 2000;

/**
 * A button that shows `label` and copies `text`; `title` is its tooltip, and `name` its accessible name when that
 * differs from `label` ("Copy box 3" on a button that shows "Copy box"). After a click its status reads "Copied" or
 * "Copy failed" for `COPIED_MS`; a copy that finishes after the button has gone changes nothing.
 */
export function CopyButton({ text, label, title, name }: { text: string; label: string; title?: string; name?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const ok = await copyText(text);
    if (!mounted.current) return;
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  }

  return (
    <span className="sheet-copy">
      <button type="button" onClick={() => void copy()} title={title} aria-label={name}>
        {label}
      </button>
      <span className={state === 'failed' ? 'sheet-copy-status is-failed' : 'sheet-copy-status'} role="status">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
