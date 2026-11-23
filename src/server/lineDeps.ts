// The line builder's deps over the real engine, trainer AI and data (`ServerDeps.lines`, lines.ts): parts of
// src/integration (`baseDeps`: the dex installed in this thread and the AI over `<dataDir>/rom`; the resolver and the
// labeler), and the view of lineView.ts. `main.ts` injects it, so the app never loads these itself.

import type { ResolvedTrainer } from '../battle/types.js';
import { moveId, showdownEngine } from '../engine/index.js';
import { baseDeps } from '../integration/baseDeps.js';
import { createLabeler } from '../integration/labeler.js';
import { createResolver } from '../integration/resolver.js';
import { createLineDamage } from './lineDamage.js';
import { expToNext } from './lineExp.js';
import { createLineView } from './lineView.js';
import type { LineDeps } from './lines.js';
import type { ServerData } from './state.js';

/** Every resolved trainer copy by ROM index, as src/integration/deps.ts finds them (the battle's trainer is looked up by it). */
function trainersByRom(data: ServerData): (romIndex: number) => ResolvedTrainer | undefined {
  let byRom: Map<number, ResolvedTrainer> | null = null;
  return (romIndex) => {
    if (byRom === null) {
      byRom = new Map();
      for (const trainer of data.catalog.trainers) for (const copy of [trainer, ...trainer.variants]) if (!byRom.has(copy.romIndex)) byRom.set(copy.romIndex, copy);
    }
    return byRom.get(romIndex);
  };
}

/** The deps for `data`, loaded from `dataDir`: built once per data load by the app, which calls this on first use. */
export function realLineDeps(data: ServerData, dataDir: string): LineDeps {
  const base = baseDeps(data, dataDir);
  return {
    engine: showdownEngine,
    model: base.enemyModel,
    resolver: (mons) => createResolver({ data: base.data, catalog: base.catalog, moves: base.moves, mons }),
    labeler: (mons, team) => createLabeler({ moves: base.moves, mons, order: team }),
    view: createLineView(base.moves),
    abilityName: (id) => base.data.names.ability(id),
    damage: (team) => createLineDamage({ data: base.data, moves: base.moves, player: team, trainer: trainersByRom(data), inPartyOrder: true }),
    moveName: moveNames(base),
    expToNext: (mon, level, exp) => expToNext(base.data.rom, mon.species, level, exp),
  };
}

/** A move's hack name by its Showdown ID (as the labeler's `moveName` builds it), else the ID: made on first use. */
function moveNames(base: ReturnType<typeof baseDeps>): (showdownId: string) => string {
  let names: Map<string, string> | null = null;
  return (id) => {
    if (names === null) {
      names = new Map();
      for (const move of base.moves.values()) {
        try {
          names.set(moveId(move), move.name);
        } catch {
          // a move the installed dex lacks
        }
      }
    }
    return names.get(id) ?? id;
  };
}
