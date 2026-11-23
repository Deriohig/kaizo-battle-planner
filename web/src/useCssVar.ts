// A ref callback that publishes an element's height as a CSS variable on the page root (`--header-height`, for the
// sticky offsets). While an element is attached the root holds `name` as its `offsetHeight` in px, kept current by a
// ResizeObserver when the browser has one (written once when it does not); detaching removes the property.

import { useCallback, useRef } from 'react';

export function useCssVar(name: `--${string}`): (el: HTMLElement | null) => void {
  const release = useRef<(() => void) | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      release.current?.();
      release.current = null;
      if (el === null) return;
      const root = document.documentElement;
      const write = () => root.style.setProperty(name, `${el.offsetHeight}px`);
      write();
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(write);
      observer?.observe(el);
      release.current = () => {
        observer?.disconnect();
        root.style.removeProperty(name);
      };
    },
    [name],
  );
}
