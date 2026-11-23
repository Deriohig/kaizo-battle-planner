// One small ⓘ per panel: the panel's explanation, out of the way. Hover shows it as the button's native
// `title`; a click, Enter or Space opens it as a small popover under the button, and Escape, a second click, a press
// anywhere outside the tip or leaving the button closes it (a press, as Safari does not focus a clicked button, so blur
// alone would leave it open). Escape on an open tip is the tip's alone: it is taken before the page's own listeners, so
// it never also closes the Settings sheet around it. While open the button drops its `title`, so the text is not shown
// twice. The text stays in the page while closed (hidden), so the button's description always holds it.

import { useEffect, useId, useRef, useState } from 'react';

export function InfoTip({ label, children }: {
  /** What the panel is, for the button's name: "About Your choice". */
  label: string;
  /** The explanation: plain text, a sentence or two. */
  children: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    // On the document's capture phase, so it runs first; stopping it there keeps it from the sheet's Escape (SettingsShell).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  return (
    <span className="info-tip" ref={root}>
      <button
        type="button" className="info-tip-button" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={id}
        title={open ? undefined : children} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}
      >
        ⓘ
      </button>
      <span id={id} role="tooltip" className="info-tip-text" hidden={!open}>{children}</span>
    </span>
  );
}
