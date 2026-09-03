// ============================================================================
// @octabits-io/framework/proposal — the reviewable-outcome contract
// ============================================================================
//
// A workflow outcome expressed as a diff against an entity that already
// exists: what each slot holds now, what is proposed for it, what it cost, and
// which parts a person accepted. Depends on nothing but zod — the review UI
// imports it in a browser, a workflow engine imports it on a server, and both
// see the same contract. It is deliberately not part of any engine: a proposal
// is what a run *produced*, and any engine (octaflow or otherwise) can emit one.
//
// A leaf inside this package — it imports no other module and no other module
// imports it (lint-enforced), so it can be lifted into its own package the day
// a second consumer needs it under its own name.
//
// See ./types for the design rule that keeps it composable with dynamic steps.

export * from './types';
export * from './build';
export * from './schema';
export * from './apply';
