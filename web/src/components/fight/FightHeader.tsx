// The open fight's header: the trainer's name, then where, which split, and single or double; and the trainer copy when
// it has several (the only place a copy is picked). The HP a fight starts on is set in the team, not here.

import { useId, type JSX } from 'react';
import type { TrainerSummaryJson } from '../../../../src/server/apiTypes';
import { trainerName } from '../../labels';

export function FightHeader({ titleId, trainer, trainerId, variant, onVariant }: {
  titleId: string; trainer: TrainerSummaryJson | undefined; trainerId: string; variant: number; onVariant(variant: number): void;
}): JSX.Element {
  const variantId = useId();
  const meta = trainer === undefined ? '' : `${trainer.location} · ${trainer.split} · ${trainer.battleType === 'double' ? 'Double' : 'Single'} battle`;
  return (
    <header className="fight-header">
      <div className="fight-title">
        <h2 id={titleId}>{trainer === undefined ? trainerId : trainerName(trainer.name)}</h2>
        {meta !== '' && <p className="fight-meta">{meta}</p>}
      </div>
      <div className="fight-controls">
        {trainer !== undefined && trainer.variants > 1 && (
          <span className="fight-variant">
            <label htmlFor={variantId}>Trainer copy</label>
            <select id={variantId} value={variant} onChange={(event) => onVariant(Number(event.target.value))}>
              {Array.from({ length: trainer.variants }, (_, index) => (
                <option key={index} value={index}>{index === 0 ? 'Copy 1 (default)' : `Copy ${index + 1}`}</option>
              ))}
            </select>
          </span>
        )}
      </div>
    </header>
  );
}
