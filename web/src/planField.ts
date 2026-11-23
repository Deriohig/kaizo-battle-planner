// The plan step's field and boosts: weather, Trick Room, Stealth Rock, screens, each side's stat stages and
// their status. Inputs only, nothing is worked out here. The type is structurally the server's body; the
// helpers are the defaults for a new plan, what a later step carries over, and the stage arithmetic FieldRow uses.

export type PlanWeather = 'none' | 'sun' | 'rain' | 'sand' | 'hail';
export type PlanStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva';
export type PlanStages = Partial<Record<PlanStat, number>>; // -6..+6, missing = 0
export type PlanStatus = 'none' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
export interface PlanFieldJson {
  weather: PlanWeather;
  trickRoom: boolean;
  rocks: { player: boolean; enemy: boolean };
  screens: { player: { reflect: boolean; lightScreen: boolean }; enemy: { reflect: boolean; lightScreen: boolean } };
  stages: { player: PlanStages; enemy: PlanStages };
  enemyStatus: PlanStatus;
}

export const MIN_STAGE = -6;
export const MAX_STAGE = 6;
export const STATS: readonly PlanStat[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
export const STAT_NAMES: Record<PlanStat, string> = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', acc: 'Acc', eva: 'Eva' };

/** A fresh field: everything off, no stages, no status. Weather starts from `weather` (whoever opens a plan works it out). */
export function planFieldDefault(weather: PlanWeather = 'none'): PlanFieldJson {
  return {
    weather, trickRoom: false,
    rocks: { player: false, enemy: false },
    screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
    stages: { player: {}, enemy: {} },
    enemyStatus: 'none',
  };
}

/**
 * The field a later step starts from: weather, Trick Room, rocks and screens carry over; a side that switched loses its
 * stages, and a switched enemy loses its status. Every part is a fresh object, so editing one step never changes another.
 */
export function carry(prev: PlanFieldJson, switched: { player: boolean; enemy: boolean }): PlanFieldJson {
  return {
    weather: prev.weather,
    trickRoom: prev.trickRoom,
    rocks: { ...prev.rocks },
    screens: { player: { ...prev.screens.player }, enemy: { ...prev.screens.enemy } },
    stages: { player: switched.player ? {} : { ...prev.stages.player }, enemy: switched.enemy ? {} : { ...prev.stages.enemy } },
    enemyStatus: switched.enemy ? 'none' : prev.enemyStatus,
  };
}

/** A stage as written: `+1`, `0`, `−1` (U+2212 for minus). */
export function stageText(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

/** `stat` set to `n` (clamped to -6..+6); a 0 is dropped so `{}` means no boosts. A new object, `stages` is not touched. */
export function withStage(stages: PlanStages, stat: PlanStat, n: number): PlanStages {
  const next: PlanStages = { ...stages };
  const clamped = Math.max(MIN_STAGE, Math.min(MAX_STAGE, Math.trunc(n)));
  if (clamped === 0) delete next[stat];
  else next[stat] = clamped;
  return next;
}

/** A stored stage as shown: clamped to -6..+6, missing is 0. */
export function stageOf(stages: PlanStages, stat: PlanStat): number {
  return Math.max(MIN_STAGE, Math.min(MAX_STAGE, stages[stat] ?? 0));
}

/** `Prinplup Atk +1 · Bonsly Def −1`: his stages first, then theirs, each in stat order; '' when none is set. */
export function stageSummary(field: PlanFieldJson, playerName: string, enemyName: string): string {
  const side = (name: string, stages: PlanStages) =>
    STATS.filter((s) => stageOf(stages, s) !== 0).map((s) => `${name} ${STAT_NAMES[s]} ${stageText(stageOf(stages, s))}`);
  return [...side(playerName, field.stages.player), ...side(enemyName, field.stages.enemy)].join(' · ');
}
