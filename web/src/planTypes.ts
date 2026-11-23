/**
 * The plan's wire and field shapes: the server's contract (`src/contracts/api.ts`, through `src/server/apiTypes.ts`), the one
 * place they are written. The field lane's `planField.ts` keeps a structurally identical `PlanFieldJson`.
 */
import type { PlanStepJson } from '../../src/server/apiTypes.js';

export type {
  PlanFieldJson, PlanSendOutChoiceJson, PlanStages, PlanStat, PlanStatus, PlanStepFieldJson, PlanStepJson, PlanStepRequestJson,
  PlanStepStateJson, PlanWeather,
} from '../../src/server/apiTypes.js';

/** Their send-out odds on a step answer (`PlanStepJson.sendOut`). */
export type PlanSendOutJson = NonNullable<PlanStepJson['sendOut']>;
/** The stat stages the battle start gives the two actives (`PlanStepJson.startStages`). */
export type PlanStartStages = NonNullable<PlanStepJson['startStages']>;
