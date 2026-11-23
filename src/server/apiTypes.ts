// The API types shared by the server (`src/server`) and the page (`web/`). Types only.
// The single import point for both: plain re-exports of the HTTP contract (`src/contracts/api.ts`).

export type {
  AiChoiceJson, AiOddsJson, AiOddsLevel, BoxDraftJson, BoxJson, BoxMonJson, DraftMonJson, DraftOptionsJson, ExtractRequestJson, MonRef, NatureStat,
  RationalJson, RunFightJson, RunJson, SaveCandidateJson, ServerEvent, SettingsJson, SetupJson,
  SheetAiEvent, SheetAiJson, SheetAiPairJson, SheetJson, SheetMonJson, SheetMoveJson, SheetPairCaseJson, SheetPairJson, SheetRequestJson,
  TrainerSummaryJson,
  ConfigJson, HealthJson, HostedErrorCode, HostedSettingsJson,
  LineAiChoiceJson, LineDamageJson, LineMoveDamageJson, LineAiOddsJson, LineCarriedJson, LineChoiceJson, LineEndHpJson, LineErrorCode, LineExpandJson, LineExpandRequestJson, LineExpGainJson, LineMonJson,
  LineNextRequestJson, LineNodeJson, LineOrderJson, LineOutcomeJson, LineRationalJson, LineRollJson, LineSideJson, LineStartRequestJson, LineViewJson, LineWorldJson,
  PlanFieldJson, PlanSendOutChoiceJson, PlanStages, PlanStat, PlanStatus, PlanStepFieldJson, PlanStepJson, PlanStepRequestJson, PlanStepStateJson, PlanWeather,
} from '../contracts/api.js';
