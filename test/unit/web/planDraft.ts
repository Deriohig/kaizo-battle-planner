// A stand-in for FightView's draft (`useDraft`) in the plan screen's tests that render PlanView alone: the team and its
// entries as given, every change a mock. FightView's own tests use the real draft.

import { vi } from 'vitest';
import type { DraftMonJson, MonRef } from '../../../src/server/apiTypes';
import type { UseDraft } from '../../../web/src/useDraft';

export function stubDraft(team: MonRef[], mons: DraftMonJson[] = team.map((ref) => ({ ref }))): UseDraft {
  return {
    team, mons, options: null, optionsProblem: null, retryOptions: vi.fn(),
    add: vi.fn(), remove: vi.fn(), move: vi.fn(), place: vi.fn(), moveTo: vi.fn(),
    edit: vi.fn(() => null), reset: vi.fn(), resetAll: vi.fn(), toCap: vi.fn(), toFull: vi.fn(), replaced: null,
  };
}
