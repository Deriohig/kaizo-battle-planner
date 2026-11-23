// Keyboard focus follows the Pokémon. These are the only focus moves this component makes, and each
// answers a button that moved or removed itself. A move (earlier, later) puts focus on the same button of the
// moved Pokémon's card, or on the other of the two when that one is now unavailable (`disabled` or `aria-disabled`). A removal (Box on the team, Team in the
// tray) puts it on the given kind of button on the next card in that list, else the previous card's, else the section's
// heading (`tabIndex={-1}`); also the heading when that button is disabled. Since the cards' actions sit in a ⋯ menu,
// a removal names `menu`, the next card's ⋯ button, and a move names the menu item, which the open menu keeps.
// Buttons are found by `MonRef` and kind; the move runs in a layout effect once the list has changed, and only while focus
// is still on the pressed button or was dropped with its card, so a change that lands later never pulls focus away.

import { type RefObject, useLayoutEffect, useRef } from 'react';
import type { MonRef } from '../../../../src/server/apiTypes';

export type ButtonKind = 'team' | 'box' | 'earlier' | 'later' | 'menu';

type Pending =
  | { type: 'move'; ref: MonRef; kind: ButtonKind; other: ButtonKind; before: string; from: Element }
  | { type: 'leave'; ref: MonRef; kind: ButtonKind; order: readonly MonRef[]; before: string; from: Element };

export interface FocusFollow {
  /** The `ref` callback for `ref`'s `kind` button. */
  bind(ref: MonRef, kind: ButtonKind): (el: HTMLButtonElement | null) => void;
  /** Call as `ref`'s `kind` button moves its card; `other` is the button to take when `kind` ends up disabled. */
  moving(ref: MonRef, kind: ButtonKind, other: ButtonKind, from: Element): void;
  /** Call as `ref`'s `kind` button takes its card out of the list. */
  leaving(ref: MonRef, kind: ButtonKind, from: Element): void;
}

const keyOf = (ref: MonRef, kind: ButtonKind) => `${ref} ${kind}`;

/** `list` is the cards' order as shown; `heading` is the section heading, the last place focus can go. */
export function useFocusFollow(list: readonly MonRef[], heading: RefObject<HTMLElement | null>): FocusFollow {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef<Pending | null>(null);
  const now = list.join(' ');

  useLayoutEffect(() => {
    const p = pending.current;
    if (p === null || now === p.before) return; // nothing asked, or the change has not landed yet
    pending.current = null;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && focused !== p.from && focused.isConnected) return;
    const usable = (ref: MonRef | undefined, kind: ButtonKind) => {
      const el = ref === undefined ? undefined : buttons.current.get(keyOf(ref, kind));
      return el !== undefined && !el.disabled && el.getAttribute('aria-disabled') !== 'true' ? el : undefined;
    };
    if (p.type === 'move') {
      if (list.includes(p.ref)) (usable(p.ref, p.kind) ?? usable(p.ref, p.other))?.focus();
      return;
    }
    if (list.includes(p.ref)) return;
    const at = p.order.indexOf(p.ref);
    const next = p.order.slice(at + 1).find((r) => list.includes(r)) ?? p.order.slice(0, at).reverse().find((r) => list.includes(r));
    (usable(next, p.kind) ?? heading.current)?.focus();
  });

  return {
    bind: (ref, kind) => (el) => {
      if (el === null) buttons.current.delete(keyOf(ref, kind));
      else buttons.current.set(keyOf(ref, kind), el);
    },
    moving: (ref, kind, other, from) => {
      pending.current = { type: 'move', ref, kind, other, before: now, from };
    },
    leaving: (ref, kind, from) => {
      pending.current = { type: 'leave', ref, kind, order: [...list], before: now, from };
    },
  };
}
