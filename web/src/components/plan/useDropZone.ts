// One drop zone for a carried Pokémon: `over` is true while one is carried over it (the `is-over` class), and
// `onDrop` gets the ref a `drop` carries. A drag that is not a Pokémon (a file, text) is left alone: not claimed, not
// highlighted, never passed on.

import { type DragEvent, useState } from 'react';
import type { MonRef } from '../../../../src/server/apiTypes';
import { carriesMon, readDraggedMon } from '../../monDrag';

export interface DropZone {
  over: boolean;
  props: {
    onDragEnter(e: DragEvent): void;
    onDragOver(e: DragEvent): void;
    onDragLeave(e: DragEvent): void;
    onDrop(e: DragEvent): void;
  };
}

/** `wouldChange`, when given, is asked in dragover/dragenter: false means the drop would change nothing, so the zone neither lights nor claims the drag. */
export function useDropZone(onDrop: (ref: MonRef) => void, wouldChange?: () => boolean): DropZone {
  const [over, setOver] = useState(false);
  const accept = (e: DragEvent) => {
    if (!carriesMon(e)) return;
    if (wouldChange !== undefined && !wouldChange()) {
      setOver(false);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    setOver(true);
  };
  return {
    over,
    props: {
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave(e) {
        // Moving onto a child of the zone also leaves the zone's own edge: stay lit.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      },
      onDrop(e) {
        setOver(false);
        const ref = readDraggedMon(e);
        if (ref === null) return;
        e.preventDefault();
        onDrop(ref);
      },
    },
  };
}
