// The plan screen's tree and box components, behind one file.
// The tree's: YourChoice, TheirReply, CritSplit and DamageBand (components/tree/, taking a
// `StepPanel`). The box's: FieldRow, BoxAndTeam, MonToken and the drag contract (web/src/monDrag.ts).
import type { ComponentProps } from 'react';
import { CritSplit } from '../tree/CritSplit';
import { DamageBand } from '../tree/DamageBand';
import { TheirReply } from '../tree/TheirReply';
import { YourChoice } from '../tree/YourChoice';
import { BoxAndTeam } from './BoxAndTeam';
import { FieldRow } from './FieldRow';
import { MonToken } from './MonToken';

export type { BoxAndTeamProps } from './BoxAndTeam';
export type { CritSplitProps } from '../tree/CritSplit';
export type { DamageBandProps } from '../tree/DamageBand';
export type { FieldRowProps } from './FieldRow';
export type { MonTokenProps } from './MonToken';
export type YourChoiceProps = ComponentProps<typeof YourChoice>;
export type TheirReplyProps = ComponentProps<typeof TheirReply>;

export { carriesMon, MON_DRAG_TYPE, MON_MIME, readDraggedMon, writeDraggedMon } from '../../monDrag';
export { CritSplit, DamageBand, TheirReply, YourChoice, FieldRow, BoxAndTeam, MonToken };
