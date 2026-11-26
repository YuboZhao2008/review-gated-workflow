import {
  ACTIVE_RUN_STATES,
  SUSPENDED_RUN_STATES,
  type Decision,
  type RunAction,
  type RunState,
} from './shared.ts';

// Pure workflow state machine. Returns effect descriptions without executing them.
// Invariant (tested as a property): the only edge into VERIFIED is FINAL_CHECKS + FINAL_GATES{green:true}.

export interface MachineSnapshot {
  readonly state: RunState;
  readonly resumeState: RunState | null;
  readonly iteration: number;
  readonly replanCount: number;
  readonly contradictionRetries: number;
  readonly escalationPending: boolean;
  readonly escalated: boolean;
  readonly freshSession: boolean;
  readonly pauseRequested: boolean;
  readonly blockReason: string | null;
  readonly resumeAt: number | null;
  /**
   * Identity of the current logical unit of work. Advances whenever a state is entered for new work — even when a
   * graceful pause defers it — and on a user Retry; stays the same for internal retries and resumes.
   */
  readonly workId: number;
  /** Set by an auth failure; cleared only by a successful agent revalidation. */
  readonly authCheckPending: boolean;
  /** Variant of new work that a graceful pause deferred before it started (e.g. a contradiction review). */
  readonly resumeVariant: StepVariant | null;
  /** Kind of the current logical work (e.g. a contradiction review); survives interrupts and restarts. */
  readonly workVariant: WorkVariant;
}

export type WorkVariant = 'normal' | 'contradiction' | 'escalation';

export interface MachineLimits {
  readonly maxCorrectionIterations: number;
  readonly maxReplans: number;
  readonly requirePlanApproval: boolean;
}

export type MachineEvent =
  | { type: 'PREFLIGHT_OK' }
  | { type: 'PREFLIGHT_FAILED'; auth: boolean; reason: string }
  | { type: 'PLAN_OK' }
  | { type: 'AUTO' }
  | { type: 'APPROVE_PLAN' }
  | { type: 'IMPL_DONE' }
  | { type: 'GATES_DONE' }
  | { type: 'REVIEW'; decision: Decision; guardOk: boolean; repeated: boolean }
  | { type: 'FINAL_GATES'; green: boolean }
  | { type: 'PAUSE'; mode: 'now' | 'graceful'; reason?: string }
  | { type: 'RESUME' }
  | { type: 'CANCEL' }
  | { type: 'RETRY' }
  | { type: 'LIMIT_HIT'; resumeAt: number }
  | { type: 'AUTH_FAILED' }
  /** Agent sign-in was revalidated successfully; clears authCheckPending. */
  | { type: 'AUTH_OK' }
  | { type: 'STEP_FAILED'; exhausted: boolean; reason: string }
  | { type: 'INTERRUPT' }
  | { type: 'BLOCK'; reason: string }
  /** Transient failure (e.g. network): run the same step again later without leaving the state. */
  | { type: 'STEP_DEFERRED'; at: number };

export type StepVariant = 'normal' | 'retry' | 'resume' | 'contradiction' | 'escalation';
export type FinalOutcome = 'VERIFIED' | 'BLOCKED' | 'FAILED' | 'CANCELLED';

export type MachineEffect =
  | { type: 'runStep'; state: RunState; variant: StepVariant }
  | { type: 'dispatch'; event: MachineEvent }
  | { type: 'killActive' }
  | { type: 'scheduleResume'; at: number }
  | { type: 'scheduleStep'; state: RunState; at: number }
  | { type: 'finalize'; outcome: FinalOutcome };

export type TransitionResult =
  { ok: true; next: MachineSnapshot; effects: MachineEffect[] } | { ok: false; reason: string };

export function initialMachine(): MachineSnapshot {
  return {
    state: 'PREFLIGHT',
    resumeState: null,
    iteration: 0,
    replanCount: 0,
    contradictionRetries: 0,
    escalationPending: false,
    escalated: false,
    freshSession: false,
    pauseRequested: false,
    blockReason: null,
    resumeAt: null,
    workId: 1,
    authCheckPending: false,
    resumeVariant: null,
    workVariant: 'normal',
  };
}

const ACTIVE = new Set<RunState>(ACTIVE_RUN_STATES);
const SUSPENDED = new Set<RunState>(SUSPENDED_RUN_STATES);
export const isActive = (s: RunState): boolean => ACTIVE.has(s);
export const isSuspended = (s: RunState): boolean => SUSPENDED.has(s);

type Result = Extract<TransitionResult, { ok: true }>;
const reject = (reason: string): TransitionResult => ({ ok: false, reason });

/** Enters an active state, honouring a pending graceful pause. */
function enter(
  s: MachineSnapshot,
  target: RunState,
  limits: MachineLimits,
  variant: StepVariant = 'normal',
  patch: Partial<MachineSnapshot> = {},
): Result {
  const newWork = variant !== 'resume' && variant !== 'retry';
  const workVariant: WorkVariant = !newWork
    ? s.workVariant
    : variant === 'contradiction' || variant === 'escalation'
      ? variant
      : 'normal';
  const base: MachineSnapshot = {
    ...s,
    ...patch,
    workVariant,
    workId: patch.workId ?? (newWork ? s.workId + 1 : s.workId),
    state: target,
    resumeState: null,
    resumeAt: null,
    blockReason: null,
    resumeVariant: null,
  };
  if (s.pauseRequested) {
    // Remember what kind of work was deferred so Resume runs it as that work, not as a replay.
    return {
      ok: true,
      next: { ...base, state: 'PAUSED', resumeState: target, pauseRequested: false, resumeVariant: variant },
      effects: [],
    };
  }
  if (target === 'PLAN_READY') {
    const effects: MachineEffect[] = limits.requirePlanApproval
      ? []
      : [{ type: 'dispatch', event: { type: 'AUTO' } }];
    return { ok: true, next: base, effects };
  }
  return { ok: true, next: base, effects: [{ type: 'runStep', state: target, variant }] };
}

function close(
  s: MachineSnapshot,
  state: 'BLOCKED' | 'FAILED',
  reason: string,
  resumeState: RunState,
): Result {
  return {
    ok: true,
    next: { ...s, state, resumeState, blockReason: reason, pauseRequested: false, resumeAt: null },
    effects: [{ type: 'finalize', outcome: state }],
  };
}

function suspend(s: MachineSnapshot, state: RunState, patch: Partial<MachineSnapshot> = {}): Result {
  return {
    ok: true,
    // The interrupted work had already started, so it resumes as itself.
    next: { ...s, ...patch, state, resumeState: s.state, pauseRequested: false, resumeVariant: null },
    effects: [],
  };
}

function onReview(
  s: MachineSnapshot,
  e: Extract<MachineEvent, { type: 'REVIEW' }>,
  limits: MachineLimits,
): Result {
  if (e.decision === 'BLOCKED') return close(s, 'BLOCKED', 'reviewer_blocked', 'REVIEWING');
  if (e.decision === 'PASS' && e.guardOk) {
    return enter(s, 'FINAL_CHECKS', limits, 'normal', { contradictionRetries: 0, escalationPending: false });
  }
  if (e.decision === 'PASS' && s.contradictionRetries < 1) {
    return enter(s, 'REVIEWING', limits, 'contradiction', {
      contradictionRetries: s.contradictionRetries + 1,
    });
  }
  if (e.decision === 'REPLAN_REQUIRED') {
    if (s.replanCount >= limits.maxReplans) return close(s, 'BLOCKED', 'max_replans', 'REVIEWING');
    return enter(s, 'REPLANNING', limits, 'normal', {
      replanCount: s.replanCount + 1,
      escalated: false,
      escalationPending: false,
      contradictionRetries: 0,
    });
  }
  // FIX_REQUIRED, or a PASS that contradicted the evidence twice.
  if (s.escalationPending) {
    if (s.iteration >= limits.maxCorrectionIterations)
      return close(s, 'BLOCKED', 'max_correction_iterations', 'REVIEWING');
    return enter(s, 'CORRECTING', limits, 'normal', {
      iteration: s.iteration + 1,
      escalated: true,
      escalationPending: false,
      freshSession: true,
      contradictionRetries: 0,
    });
  }
  if (e.repeated) {
    if (s.escalated) return close(s, 'BLOCKED', 'repeated_failure', 'REVIEWING');
    return enter(s, 'REVIEWING', limits, 'escalation', { escalationPending: true, contradictionRetries: 0 });
  }
  if (s.iteration >= limits.maxCorrectionIterations)
    return close(s, 'BLOCKED', 'max_correction_iterations', 'REVIEWING');
  return enter(s, 'CORRECTING', limits, 'normal', {
    iteration: s.iteration + 1,
    freshSession: false,
    contradictionRetries: 0,
  });
}

function onActive(s: MachineSnapshot, e: MachineEvent, limits: MachineLimits): TransitionResult {
  switch (e.type) {
    case 'PAUSE':
      if (e.mode === 'graceful' && s.state !== 'PLAN_READY') {
        return { ok: true, next: { ...s, pauseRequested: true }, effects: [] };
      }
      return {
        ...suspend(s, 'PAUSED', { blockReason: e.reason ?? null }),
        effects: s.state === 'PLAN_READY' ? [] : [{ type: 'killActive' }],
      };
    case 'STEP_DEFERRED':
      return { ok: true, next: s, effects: [{ type: 'scheduleStep', state: s.state, at: e.at }] };
    case 'LIMIT_HIT':
      return {
        ...suspend(s, 'WAITING_LIMIT', { resumeAt: e.resumeAt }),
        effects: [{ type: 'scheduleResume', at: e.resumeAt }],
      };
    case 'AUTH_FAILED':
      return suspend(s, 'NEEDS_AUTH', { authCheckPending: true });
    case 'AUTH_OK':
      return { ok: true, next: { ...s, authCheckPending: false }, effects: [] };
    case 'INTERRUPT':
      return suspend(s, 'INTERRUPTED');
    case 'STEP_FAILED':
      if (e.exhausted) return close(s, 'FAILED', e.reason, s.state);
      return { ok: true, next: s, effects: [{ type: 'runStep', state: s.state, variant: 'retry' }] };
    case 'BLOCK':
      return close(s, 'BLOCKED', e.reason, s.state);
    default:
      return onStateEvent(s, e, limits);
  }
}

function onStateEvent(s: MachineSnapshot, e: MachineEvent, limits: MachineLimits): TransitionResult {
  switch (s.state) {
    case 'PREFLIGHT':
      if (e.type === 'PREFLIGHT_OK')
        return enter(s, 'PLANNING', limits, 'normal', { authCheckPending: false });
      if (e.type === 'PREFLIGHT_FAILED') {
        return e.auth
          ? suspend(s, 'NEEDS_AUTH', { authCheckPending: true })
          : close(s, 'FAILED', e.reason, 'PREFLIGHT');
      }
      break;
    case 'PLANNING':
    case 'REPLANNING':
      if (e.type === 'PLAN_OK') return enter(s, 'PLAN_READY', limits);
      break;
    case 'PLAN_READY':
      if (
        (e.type === 'APPROVE_PLAN' && limits.requirePlanApproval) ||
        (e.type === 'AUTO' && !limits.requirePlanApproval)
      ) {
        return enter(s, 'IMPLEMENTING', limits);
      }
      break;
    case 'IMPLEMENTING':
    case 'CORRECTING':
      if (e.type === 'IMPL_DONE') return enter(s, 'CHECKING', limits, 'normal', { freshSession: false });
      break;
    case 'CHECKING':
      if (e.type === 'GATES_DONE')
        return enter(s, 'REVIEWING', limits, 'normal', { contradictionRetries: 0 });
      break;
    case 'REVIEWING':
      if (e.type === 'REVIEW') return onReview(s, e, limits);
      break;
    case 'FINAL_CHECKS':
      if (e.type === 'FINAL_GATES') {
        if (e.green) {
          return {
            ok: true,
            next: { ...s, state: 'VERIFIED', resumeState: null, pauseRequested: false, blockReason: null },
            effects: [{ type: 'finalize', outcome: 'VERIFIED' }],
          };
        }
        // §5.2: failing final gates start a new review iteration carrying the failing evidence.
        return enter(s, 'REVIEWING', limits, 'normal', {
          contradictionRetries: 0,
          iteration: s.iteration + 1,
        });
      }
      break;
    default:
      break;
  }
  return reject(`${e.type} is not valid in ${s.state}`);
}

const cancel = (s: MachineSnapshot): TransitionResult => ({
  ok: true,
  next: { ...s, state: 'CANCELLED', resumeState: null, pauseRequested: false, resumeAt: null },
  effects: [{ type: 'killActive' }, { type: 'finalize', outcome: 'CANCELLED' }],
});

export function transition(s: MachineSnapshot, e: MachineEvent, limits: MachineLimits): TransitionResult {
  const result = transitionRaw(s, e, limits);
  // An active run is not waiting to resume anything; never carry a stale resume target.
  if (result.ok && isActive(result.next.state) && result.next.resumeState !== null) {
    return { ...result, next: { ...result.next, resumeState: null } };
  }
  return result;
}

function transitionRaw(s: MachineSnapshot, e: MachineEvent, limits: MachineLimits): TransitionResult {
  if (isActive(s.state)) {
    if (e.type === 'CANCEL') return cancel(s);
    return onActive(s, e, limits);
  }
  if (isSuspended(s.state)) {
    if (e.type === 'CANCEL') return cancel(s);
    if (e.type === 'RESUME') {
      if (!s.resumeState || !isActive(s.resumeState)) return reject(`Nothing to resume from ${s.state}`);
      // Deferred-but-unstarted work runs as its original variant in the workId it was given.
      // Leaving NEEDS_AUTH always revalidates, whatever the stored flag says.
      const authCheckPending = s.state === 'NEEDS_AUTH' ? true : s.authCheckPending;
      return enter(
        { ...s, pauseRequested: false, authCheckPending },
        s.resumeState,
        limits,
        s.resumeVariant ?? 'resume',
        {
          workId: s.workId,
        },
      );
    }
    return reject(`${e.type} is not valid in ${s.state}`);
  }
  if (s.state === 'BLOCKED' || s.state === 'FAILED') {
    if (e.type === 'CANCEL') return cancel(s);
    if (e.type === 'RETRY') {
      if (!s.resumeState || !isActive(s.resumeState)) return reject(`Nothing to retry from ${s.state}`);
      // A user Retry is new work: re-run the step instead of replaying a completed one.
      return enter({ ...s, pauseRequested: false }, s.resumeState, limits, 'retry', {
        contradictionRetries: 0,
        workId: s.workId + 1,
      });
    }
  }
  return reject(`${e.type} is not valid in ${s.state}`);
}

/** Controls the dashboard may offer; mirrors what `transition` accepts. */
export function allowedActions(s: MachineSnapshot, limits: MachineLimits): RunAction[] {
  if (isActive(s.state)) {
    const approve: RunAction[] =
      s.state === 'PLAN_READY' && limits.requirePlanApproval ? ['approve-plan'] : [];
    return [...approve, 'pause', 'cancel'];
  }
  if (isSuspended(s.state)) {
    const resume: RunAction[] = s.resumeState && isActive(s.resumeState) ? ['resume'] : [];
    return [...resume, 'cancel'];
  }
  if (s.state === 'BLOCKED' || s.state === 'FAILED') {
    return s.resumeState && isActive(s.resumeState) ? ['cancel', 'retry'] : ['cancel'];
  }
  if (s.state === 'VERIFIED') return ['integrate'];
  return [];
}
