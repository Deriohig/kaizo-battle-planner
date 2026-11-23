// The opcodes that read a side's party (trainer_ai.c). The AI's party is Garchomp (slot 0, active), Gyarados and
// Roserade; the player's is Luxray alone.

import { describe } from 'vitest';
import { MON_CONDITION_BURN, MON_CONDITION_PARALYSIS, SPECIES_EGG, SPECIES_NONE } from '../../../src/ai/constants.js';
import { AI, aiParty, ATK, ATK_PARTNER, branches, DEF, DEF_PARTNER, loads, viewWith } from './opsHarness.js';

const GARCHOMP = 0;
const GYARADOS = 1;
const ROSERADE = 2;
const BURN = MON_CONDITION_BURN;
const gyaradosActive = () => viewWith((v) => { v.selectedPartySlot[AI] = GYARADOS; });

describe('CountAlivePartyBattlers', () => {
  // Members other than the active slot (selectedPartySlot), with HP, neither SPECIES_NONE nor an egg (trainer_ai.c:1142–1155).
  loads([
    [`CountAlivePartyBattlers ${ATK}`, 2],
    [`CountAlivePartyBattlers ${DEF}`, 0],
    [`CountAlivePartyBattlers ${ATK}`, 1, { v: aiParty({ [GYARADOS]: { species: SPECIES_EGG } }) }],
    [`CountAlivePartyBattlers ${ATK}`, 1, { v: aiParty({ [ROSERADE]: { species: SPECIES_NONE } }) }],
    [`CountAlivePartyBattlers ${ATK}`, 1, { v: aiParty({ [GYARADOS]: { hp: 0 } }) }],
    [`CountAlivePartyBattlers ${ATK}`, 2, { v: gyaradosActive() }],
    [`CountAlivePartyBattlers ${ATK}`, 1, { v: aiParty({ [GARCHOMP]: { hp: 0 } }, gyaradosActive()) }],
    // The partner slots' parties are empty in singles (battle_system.c:131), and calcTemp is zeroed first (:1132).
    [`CountAlivePartyBattlers ${ATK_PARTNER}`, 0, { calcTemp: 9 }],
    [`CountAlivePartyBattlers ${DEF_PARTNER}`, 0, { calcTemp: 9 }],
  ]);
});

describe('party branches', () => {
  const roseradeBurned = () => aiParty({ [ROSERADE]: { status: BURN } });
  branches([
    // The first live bench member with a status bit of the mask (trainer_ai.c:1367–1378): not the active slot.
    [`IfPartyMemberStatus ${ATK}, ${BURN}, Taken`, false],
    [`IfPartyMemberStatus ${ATK}, ${BURN}, Taken`, true, { v: roseradeBurned() }],
    [`IfPartyMemberStatus ${ATK}, ${MON_CONDITION_PARALYSIS}, Taken`, false, { v: roseradeBurned() }],
    [`IfPartyMemberStatus ${ATK}, ${BURN}, Taken`, false, { v: aiParty({ [GARCHOMP]: { status: BURN } }) }],
    [`IfPartyMemberStatus ${ATK}, ${BURN}, Taken`, false, { v: aiParty({ [ROSERADE]: { status: BURN, hp: 0 } }) }],
    // The first live bench member with no status bit of the mask (trainer_ai.c:1400–1411).
    [`IfPartyMemberNotStatus ${ATK}, ${BURN}, Taken`, true],
    [`IfPartyMemberNotStatus ${ATK}, ${BURN}, Taken`, false, { v: aiParty({ [GYARADOS]: { status: BURN }, [ROSERADE]: { status: BURN } }) }],
    [`IfPartyMemberNotStatus ${DEF}, ${BURN}, Taken`, false], // the player's only member is active
    // A non-active member with HP != max HP (trainer_ai.c:1979–1983), fainted ones included.
    [`IfAnyPartyMemberIsWounded ${ATK}, Taken`, false],
    [`IfAnyPartyMemberIsWounded ${ATK}, Taken`, true, { v: aiParty({ [GYARADOS]: { hp: 100 } }) }],
    [`IfAnyPartyMemberIsWounded ${ATK}, Taken`, true, { v: aiParty({ [ROSERADE]: { hp: 0 } }) }],
    [`IfAnyPartyMemberIsWounded ${ATK}, Taken`, false, { v: aiParty({ [GARCHOMP]: { hp: 1 } }) }],
    // A non-active member with a move's PP below its max (trainer_ai.c:1996–2011), fainted ones included.
    [`IfAnyPartyMemberUsedPP ${ATK}, Taken`, false],
    [`IfAnyPartyMemberUsedPP ${ATK}, Taken`, true, { v: aiParty({ [ROSERADE]: { pp: [10, 10, 15, 14] } }) }],
    [`IfAnyPartyMemberUsedPP ${ATK}, Taken`, false, { v: aiParty({ [GARCHOMP]: { pp: [1, 10, 15, 15] } }) }],
    [`IfAnyPartyMemberUsedPP ${ATK}, Taken`, true, { v: aiParty({ [GYARADOS]: { hp: 0, pp: [15, 15, 0, 10] } }) }],
  ]);
});
