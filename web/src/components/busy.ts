// A busy control: while a step of the tree is worked out, or settings are saved, it says so with
// `aria-disabled="true"` and ignores clicks, but it is never `disabled`, so the focus a keyboard put on it stays there (a
// disabled button drops focus to the page body). A control unavailable for another reason keeps `disabled` for that reason
// only. The words a busy step shows are `workingText`'s, for the page and for the tree's one status region alike.

/**
 * A busy control's `aria-disabled`: true while busy, else none. For a control whose handler is not a click (a select's
 * change, a form's submit), which returns early while busy itself.
 */
export const busyAria = (busy: boolean): true | undefined => (busy ? true : undefined);

/** A control while a step is worked out: `aria-disabled`, never `disabled` (focus stays on it), and a click that does nothing. */
export function busyProps(busy: boolean, onClick: () => void): { 'aria-disabled': true | undefined; onClick(): void } {
  return {
    'aria-disabled': busyAria(busy),
    onClick() {
      if (!busy) onClick();
    },
  };
}

/**
 * What a busy step says: `Working out Scratch…`, then once it is slow (`usePlan`'s `SLOW_MS`) `Still working out Scratch.`.
 * `choice` is the pick as its button names it (`choiceName`); null for the next step (a follow, a start, a restore, a rebuild).
 */
export function workingText(choice: string | null, slow: boolean): string {
  const what = choice ?? 'the next step';
  return slow ? `Still working out ${what}.` : `Working out ${what}…`;
}
