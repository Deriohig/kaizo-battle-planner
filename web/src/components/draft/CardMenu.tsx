// A row's ⋯ menu: one small button named "Actions for <name>" (`aria-haspopup="menu"`) that opens the row's
// actions as a strip of menu items under the row, so a dense list shows one button per Pokémon instead of four. The strip
// opens inline rather than floating, so a list that scrolls inside its panel (the box) never clips it. Each item keeps
// the accessible name of the button it replaces ("Try Big (Bibarel)", "Move Starly earlier"). Keyboard: Enter, Space or
// ArrowDown on the button opens it on the first item, ArrowUp on the last; the arrow keys, Home and End move between the
// items; Escape closes it and puts focus back on the button; Tab closes it. An unavailable item (Earlier on the first,
// Team with a full team) is `aria-disabled` like a busy one: it keeps focus and is reached by the arrow keys, its press
// is ignored, and its reason (`title`) is its description too, so a keyboard or a reader gets it. An item runs and closes
// the menu, focus back on the button, unless it `stays` (a move: the menu follows its Pokémon, focus on the item). A
// press outside closes it. `open` may be held by the list (`onOpenChange`), so one menu is open per list and a row that
// is re-created when it moves keeps its menu open; without it the menu keeps its own state. The row lays the two parts
// out: they are the button and, while open, the strip (`flex-basis: 100%` in run.css).

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type JSX } from 'react';

export interface MenuAction {
  /** The visible word ("Try"). */
  text: string;
  /** The accessible name: the name of the button it replaces ("Try Big (Bibarel)"). */
  label: string;
  onSelect(item: HTMLButtonElement): void;
  /** Unavailable (the earliest Pokémon's Earlier, Team with a full team): `aria-disabled`, the press ignored, still reached by the arrow keys. */
  disabled?: boolean;
  /** Busy: `aria-disabled`, the press ignored, and it keeps focus. */
  busy?: boolean;
  /** The hover text; on an unavailable item, its reason, which is also its description. */
  title?: string;
  /** Keep the menu open after it runs: a move, which the menu follows. */
  stays?: boolean;
  /** The item's element, for focus to follow it (useFocusFollow's `bind`). */
  itemRef?(el: HTMLButtonElement | null): void;
}

export interface CardMenuProps {
  /** Whose actions: the button is "Actions for <name>". */
  name: string;
  actions: readonly MenuAction[];
  /** Held by the list: whether this menu is open. Left out, the menu keeps its own state. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** The ⋯ button's element, for focus to follow the row (useFocusFollow's `bind`). */
  triggerRef?(el: HTMLButtonElement | null): void;
}

type Edge = 'first' | 'last';

/** The items: every one takes focus, an unavailable or busy one too. */
const focusable = (menu: HTMLElement | null): HTMLButtonElement[] =>
  menu === null ? [] : Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

export function CardMenu({ name, actions, open: held, onOpenChange, triggerRef }: CardMenuProps): JSX.Element {
  const menuId = useId();
  const [own, setOwn] = useState(false);
  const open = held ?? own;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // Where focus goes once the strip is drawn: set by a press on the button, so a menu drawn open by the list (its row
  // re-created after a move) leaves focus to the list.
  const focusOnOpen = useRef<Edge | null>(null);
  const setOpen = (next: boolean) => {
    if (held === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  // The items unavailable now, by label, and as of the last render: an item that has just become unavailable under focus
  // hands focus on (one that already was, reached by the arrow keys, keeps it).
  const off = new Set(actions.filter((a) => a.disabled === true).map((a) => a.label));
  const wasOff = useRef<ReadonlySet<string>>(off);

  useLayoutEffect(() => {
    const before = wasOff.current;
    wasOff.current = off;
    if (!open) return;
    const edge = focusOnOpen.current;
    focusOnOpen.current = null;
    const items = focusable(menu.current);
    if (edge !== null) {
      (edge === 'first' ? items[0] : items.at(-1))?.focus();
      return;
    }
    // A focused item that has just become unavailable (Move up on the row that is now first) hands focus to its neighbour.
    const active = document.activeElement;
    const label = active instanceof HTMLButtonElement ? active.getAttribute('aria-label') : null;
    if (label !== null && off.has(label) && !before.has(label) && menu.current?.contains(active)) {
      const all = focusable(menu.current);
      const at = all.indexOf(active as HTMLButtonElement);
      const usable = (el: HTMLButtonElement) => !off.has(el.getAttribute('aria-label') ?? '');
      (all.slice(at + 1).find(usable) ?? all.slice(0, at).reverse().find(usable))?.focus();
    }
  });

  // A press anywhere outside the button and the strip closes the menu, focus left where the press put it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target !== null && (trigger.current?.contains(target) || menu.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });

  const openAt = (edge: Edge) => {
    focusOnOpen.current = edge;
    setOpen(true);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) (e.key === 'ArrowDown' ? focusable(menu.current)[0] : focusable(menu.current).at(-1))?.focus();
      else openAt(e.key === 'ArrowDown' ? 'first' : 'last');
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(false);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = focusable(menu.current);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        go(at + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        go(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(-1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
    }
  };

  return (
    <>
      <button
        type="button" className="card-menu-button" aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} title="Actions"
        ref={(el) => {
          trigger.current = el;
          triggerRef?.(el);
        }}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onTriggerKey}
      >
        ⋯
      </button>
      {open && (
        <div id={menuId} ref={menu} role="menu" aria-label={`Actions for ${name}`} aria-orientation="horizontal" className="card-menu" onKeyDown={onMenuKey}>
          {actions.map((a, index) => {
            const held = a.busy === true || a.disabled === true;
            const reasonId = a.disabled === true && a.title !== undefined ? `${menuId}-reason-${index}` : undefined;
            return (
              <Fragment key={a.label}>
                <button
                  type="button" role="menuitem" tabIndex={-1} className="button button-sm card-menu-item" aria-label={a.label}
                  aria-disabled={held ? true : undefined} aria-describedby={reasonId} title={a.title} ref={a.itemRef}
                  onClick={(e) => {
                    if (held) return;
                    const item = e.currentTarget;
                    if (a.stays !== true) close(true);
                    a.onSelect(item);
                  }}
                >
                  {a.text}
                </button>
                {/* The reason as the item's description: hidden, so it is not a second thing in the strip. */}
                {reasonId !== undefined && <span id={reasonId} hidden>{a.title}</span>}
              </Fragment>
            );
          })}
        </div>
      )}
    </>
  );
}
