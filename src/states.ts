// Shared states and actions for the workflow engine.

export const RUN_STATES = [
  'PREFLIGHT',
  'PLANNING',
  'PLAN_READY',
  'IMPLEMENTING',
  'CHECKING',
  'REVIEWING',
  'CORRECTING',
  'REPLANNING',
  'FINAL_CHECKS',
  'VERIFIED',
  'PAUSED',
  'WAITING_LIMIT',
  'NEEDS_AUTH',
  'INTERRUPTED',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** States in which an agent or command may be executing. */
export const ACTIVE_RUN_STATES = [
  'PREFLIGHT',
  'PLANNING',
  'PLAN_READY',
  'IMPLEMENTING',
  'CHECKING',
  'REVIEWING',
  'CORRECTING',
  'REPLANNING',
  'FINAL_CHECKS',
] as const satisfies readonly RunState[];

/** Suspended states keep the run "open" (it still blocks a second run) and remember where to resume. */
export const SUSPENDED_RUN_STATES = [
  'PAUSED',
  'WAITING_LIMIT',
  'NEEDS_AUTH',
  'INTERRUPTED',
] as const satisfies readonly RunState[];

/** Runs in these states no longer hold the project's single execution slot. */
export const CLOSED_RUN_STATES = [
  'VERIFIED',
  'CANCELLED',
  'BLOCKED',
  'FAILED',
] as const satisfies readonly RunState[];

export function isClosedRunState(state: RunState): boolean {
  return (CLOSED_RUN_STATES as readonly RunState[]).includes(state);
}

export const STAGE_STATUSES = [
  'DRAFT',
  'READY',
  'RUNNING',
  'VERIFIED',
  'INTEGRATED',
  'NEEDS_ATTENTION',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STEP_KINDS = [
  'preflight',
  'plan',
  'structure_plan',
  'implement',
  'correct',
  'checkpoint',
  'gates',
  'review',
  'replan',
  'final_gates',
  'report',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const RUN_ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'approve-plan', 'integrate'] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];
