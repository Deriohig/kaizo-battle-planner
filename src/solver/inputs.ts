// How a fight's battle is built, shared by the search and the checker. The team is kept in canonical (request) order;
// the engine sees the lead first and the rest in canonical order, so carries and pre-statuses are re-indexed both ways.
// CarryState convention (the toy and the real engine agree): `pp` lists the limited-PP moves only, in move order.
// The engine always gets an explicit carry. Without one it would start from the save's HP, PP and status, so a
// heal ("heal here", healBefore) is the healed carry, never "no carry".

export * from '../integration/fight.js';
