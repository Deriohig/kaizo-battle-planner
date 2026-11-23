// Dropping a save file anywhere on the window. Only a drag that carries `Files` counts, so the Pokémon drag
// (`monDrag.ts`, which sets its own type and no `Files`) is left alone.

import { useEffect, useRef, useState } from 'react';

const isSave = (name: string) => /\.(dsv|sav)$/i.test(name);

/** The first `.dsv` or `.sav` (any case), else the first file, else null. */
export function pickSaveFile(files: ArrayLike<File>): File | null {
  const all = Array.from(files);
  return all.find((f) => isSave(f.name)) ?? all[0] ?? null;
}

const carriesFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Listens on the window for a file drag. Returns whether one is over the window now (for the overlay); a drop calls
 * `onFile` with the chosen file. `enabled` false turns it all off.
 */
export function useFileDrop(onFile: (file: File) => void, enabled = true): boolean {
  const [over, setOver] = useState(false);
  const latest = useRef(onFile);
  latest.current = onFile;

  useEffect(() => {
    if (!enabled) {
      setOver(false);
      return;
    }
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth += 1;
      setOver(true);
    };
    const hover = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const file = pickSaveFile(e.dataTransfer?.files ?? []);
      if (file !== null) latest.current(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', hover);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', hover);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);

  return over;
}
