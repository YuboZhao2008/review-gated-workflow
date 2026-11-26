import { describe, expect, it } from 'vitest';
import { RUN_STATES, type RunState } from './shared.ts';
import {
  transition,
  initialMachine,
  allowedActions,
  type MachineEvent,
  type MachineSnapshot,
  type MachineLimits,
  type TransitionResult,
} from './machine.ts';

const limits: MachineLimits = { maxCorrectionIterations: 3, maxReplans: 1, requirePlanApproval: false };

function at(state: RunState, extra: Partial<MachineSnapshot> = {}): MachineSnapshot {
  return { ...initialMachine(), state, ...extra };
}

function ok(result: TransitionResult): Extract<TransitionResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected transition, got rejection: ${result.reason}`);
  return result;
}

const runs = (r: Extract<TransitionResult, { ok: true }>): boolean =>
  r.effects.some((e) => e.type === 'runStep');

describe('happy path transitions', () => {
  it.each<[RunState, MachineEvent, RunState]>([
    ['PREFLIGHT', { type: 'PREFLIGHT_OK' }, 'PLANNING'],
    ['PLANNING', { type: 'PLAN_OK' }, 'PLAN_READY'],
    ['PLAN_READY', { type: 'AUTO' }, 'IMPLEMENTING'],
    ['IMPLEMENTING', { type: 'IMPL_DONE' }, 'CHECKING'],
    ['CORRECTING', { type: 'IMPL_DONE' }, 'CHECKING'],
    ['CHECKING', { type: 'GATES_DONE' }, 'REVIEWING'],
    ['REVIEWING', { type: 'REVIEW', decision: 'PASS', guardOk: true, repeated: false }, 'FINAL_CHECKS'],
    ['FINAL_CHECKS', { type: 'FINAL_GATES', green: true }, 'VERIFIED'],
    ['REPLANNING', { type: 'PLAN_OK' }, 'PLAN_READY'],
  ])('%s + %o -> %s', (from, event, to) => {
    const r = ok(transition(at(from), event, limits));
    expect(r.next.state).toBe(to);
  });

  it('starts the step for every newly entered active state', () => {
    expect(runs(ok(transition(at('PREFLIGHT'), { type: 'PREFLIGHT_OK' }, limits)))).toBe(true);
    expect(runs(ok(transition(at('CHECKING'), { type: 'GATES_DONE' }, limits)))).toBe(true);
  });

  it('auto-advances from PLAN_READY when approval is not required', () => {
    const r = ok(transition(at('PLANNING'), { type: 'PLAN_OK' }, limits));
    expect(r.effects).toContainEqual({ type: 'dispatch', event: { type: 'AUTO' } });
  });

  it('waits at PLAN_READY when approval is required', () => {
    const strict = { ...limits, requirePlanApproval: true };
    const r = ok(transition(at('PLANNING'), { type: 'PLAN_OK' }, strict));
    expect(r.effects.some((e) => e.type === 'dispatch')).toBe(false);
    expect(transition(at('PLAN_READY'), { type: 'AUTO' }, strict).ok).toBe(false);
    expect(ok(transition(at('PLAN_READY'), { type: 'APPROVE_PLAN' }, strict)).next.state).toBe(
      'IMPLEMENTING',
    );
  });

  it('finalizes and stops on VERIFIED', () => {
    const r = ok(transition(at('FINAL_CHECKS'), { type: 'FINAL_GATES', green: true }, limits));
    expect(r.effects).toContainEqual({ type: 'finalize', outcome: 'VERIFIED' });
    expect(runs(r)).toBe(false);
  });
});

describe('preflight failures', () => {
  it('goes to NEEDS_AUTH on auth problems', () => {
    const r = ok(
      transition(at('PREFLIGHT'), { type: 'PREFLIGHT_FAILED', auth: true, reason: 'login' }, limits),
    );
    expect(r.next).toMatchObject({ state: 'NEEDS_AUTH', resumeState: 'PREFLIGHT' });
  });
  it('fails on other preflight problems', () => {
    const r = ok(
      transition(at('PREFLIGHT'), { type: 'PREFLIGHT_FAILED', auth: false, reason: 'model missing' }, limits),
    );
    expect(r.next).toMatchObject({ state: 'FAILED', blockReason: 'model missing' });
  });
});

describe('review decisions', () => {
  it('re-asks once when PASS contradicts the evidence, then treats it as FIX_REQUIRED', () => {
    const event: MachineEvent = { type: 'REVIEW', decision: 'PASS', guardOk: false, repeated: false };
    const first = ok(transition(at('REVIEWING'), event, limits));
    expect(first.next).toMatchObject({ state: 'REVIEWING', contradictionRetries: 1 });
    expect(first.effects).toContainEqual({ type: 'runStep', state: 'REVIEWING', variant: 'contradiction' });
    const second = ok(transition(first.next, event, limits));
    expect(second.next.state).toBe('CORRECTING');
  });

  it('enters CORRECTING and counts the iteration on FIX_REQUIRED', () => {
    const r = ok(
      transition(
        at('REVIEWING', { iteration: 0 }),
        { type: 'REVIEW', decision: 'FIX_REQUIRED', guardOk: false, repeated: false },
        limits,
      ),
    );
    expect(r.next).toMatchObject({ state: 'CORRECTING', iteration: 1 });
  });

  it('blocks when the correction cap is reached', () => {
    const r = ok(
      transition(
        at('REVIEWING', { iteration: 3 }),
        { type: 'REVIEW', decision: 'FIX_REQUIRED', guardOk: false, repeated: false },
        limits,
      ),
    );
    expect(r.next).toMatchObject({ state: 'BLOCKED', blockReason: 'max_correction_iterations' });
  });

  it('escalates on the first repeated failure and blocks on the second', () => {
    const fix: MachineEvent = { type: 'REVIEW', decision: 'FIX_REQUIRED', guardOk: false, repeated: true };
    const escalation = ok(transition(at('REVIEWING', { iteration: 1 }), fix, limits));
    expect(escalation.next).toMatchObject({ state: 'REVIEWING', escalationPending: true });
    expect(escalation.effects).toContainEqual({ type: 'runStep', state: 'REVIEWING', variant: 'escalation' });

    const afterEscalation = ok(transition(escalation.next, { ...fix, repeated: false }, limits));
    expect(afterEscalation.next).toMatchObject({ state: 'CORRECTING', escalated: true, freshSession: true });

    const again = ok(transition(at('REVIEWING', { iteration: 2, escalated: true }), fix, limits));
    expect(again.next).toMatchObject({ state: 'BLOCKED', blockReason: 'repeated_failure' });
  });

  it('replans within the cap and blocks beyond it', () => {
    const replan: MachineEvent = {
      type: 'REVIEW',
      decision: 'REPLAN_REQUIRED',
      guardOk: false,
      repeated: false,
    };
    const r = ok(transition(at('REVIEWING'), replan, limits));
    expect(r.next).toMatchObject({ state: 'REPLANNING', replanCount: 1 });
    const capped = ok(transition(at('REVIEWING', { replanCount: 1 }), replan, limits));
    expect(capped.next).toMatchObject({ state: 'BLOCKED', blockReason: 'max_replans' });
  });

  it('blocks when the reviewer says BLOCKED', () => {
    const r = ok(
      transition(
        at('REVIEWING'),
        { type: 'REVIEW', decision: 'BLOCKED', guardOk: false, repeated: false },
        limits,
      ),
    );
    expect(r.next).toMatchObject({
      state: 'BLOCKED',
      blockReason: 'reviewer_blocked',
      resumeState: 'REVIEWING',
    });
    expect(r.effects).toContainEqual({ type: 'finalize', outcome: 'BLOCKED' });
  });

  it('returns to REVIEWING and advances the iteration when final gates fail', () => {
    const r = ok(
      transition(at('FINAL_CHECKS', { iteration: 2 }), { type: 'FINAL_GATES', green: false }, limits),
    );
    expect(r.next).toMatchObject({ state: 'REVIEWING', iteration: 3 });
  });
});

describe('work identity and pending auth checks', () => {
  it('advances workId for new work even when a graceful pause defers it', () => {
    const paused = ok(
      transition(
        at('REVIEWING', { workId: 4, pauseRequested: true }),
        { type: 'REVIEW', decision: 'PASS', guardOk: false, repeated: false },
        limits,
      ),
    );
    expect(paused.next).toMatchObject({ state: 'PAUSED', resumeState: 'REVIEWING', workId: 5 });
    const resumed = ok(transition(paused.next, { type: 'RESUME' }, limits));
    expect(resumed.next.workId).toBe(5);
  });

  it('keeps workId for internal retries and resumes', () => {
    expect(
      ok(
        transition(
          at('IMPLEMENTING', { workId: 3 }),
          { type: 'STEP_FAILED', exhausted: false, reason: 'x' },
          limits,
        ),
      ).next.workId,
    ).toBe(3);
    expect(
      ok(transition(at('PAUSED', { workId: 3, resumeState: 'IMPLEMENTING' }), { type: 'RESUME' }, limits))
        .next.workId,
    ).toBe(3);
  });

  it('treats a user Retry as new work', () => {
    const r = ok(
      transition(at('BLOCKED', { workId: 7, resumeState: 'REVIEWING' }), { type: 'RETRY' }, limits),
    );
    expect(r.next).toMatchObject({ state: 'REVIEWING', workId: 8 });
  });

  it('keeps an auth check pending until AUTH_OK, across resume and retries', () => {
    const waiting = ok(transition(at('IMPLEMENTING'), { type: 'AUTH_FAILED' }, limits));
    expect(waiting.next.authCheckPending).toBe(true);
    const resumed = ok(transition(waiting.next, { type: 'RESUME' }, limits));
    expect(resumed.next.authCheckPending).toBe(true);
    const retried = ok(
      transition(resumed.next, { type: 'STEP_FAILED', exhausted: false, reason: 'x' }, limits),
    );
    expect(retried.next.authCheckPending).toBe(true);
    expect(ok(transition(retried.next, { type: 'AUTH_OK' }, limits)).next.authCheckPending).toBe(false);
  });

  it('clears the pending check after a successful preflight', () => {
    const r = ok(transition(at('PREFLIGHT', { authCheckPending: true }), { type: 'PREFLIGHT_OK' }, limits));
    expect(r.next.authCheckPending).toBe(false);
  });
});

describe('deferred retries and reasoned pauses', () => {
  it('stays in the state and schedules the step for later', () => {
    const r = ok(transition(at('IMPLEMENTING'), { type: 'STEP_DEFERRED', at: 999 }, limits));
    expect(r.next.state).toBe('IMPLEMENTING');
    expect(r.effects).toEqual([{ type: 'scheduleStep', state: 'IMPLEMENTING', at: 999 }]);
  });

  it('records why a run was paused by the engine', () => {
    const r = ok(transition(at('REVIEWING'), { type: 'PAUSE', mode: 'now', reason: 'network' }, limits));
    expect(r.next).toMatchObject({ state: 'PAUSED', resumeState: 'REVIEWING', blockReason: 'network' });
    const resumed = ok(transition(r.next, { type: 'RESUME' }, limits));
    expect(resumed.next.blockReason).toBeNull();
  });
});

describe('controls and failures', () => {
  it('pauses immediately and kills the active step with mode "now"', () => {
    const r = ok(transition(at('IMPLEMENTING'), { type: 'PAUSE', mode: 'now' }, limits));
    expect(r.next).toMatchObject({ state: 'PAUSED', resumeState: 'IMPLEMENTING' });
    expect(r.effects).toContainEqual({ type: 'killActive' });
  });

  it('pauses after the current step with mode "graceful"', () => {
    const requested = ok(transition(at('IMPLEMENTING'), { type: 'PAUSE', mode: 'graceful' }, limits));
    expect(requested.next).toMatchObject({ state: 'IMPLEMENTING', pauseRequested: true });
    const after = ok(transition(requested.next, { type: 'IMPL_DONE' }, limits));
    expect(after.next).toMatchObject({ state: 'PAUSED', resumeState: 'CHECKING', pauseRequested: false });
    expect(runs(after)).toBe(false);
  });

  it.each<RunState>(['PAUSED', 'INTERRUPTED', 'WAITING_LIMIT', 'NEEDS_AUTH'])('resumes from %s', (state) => {
    const r = ok(transition(at(state, { resumeState: 'CORRECTING' }), { type: 'RESUME' }, limits));
    expect(r.next).toMatchObject({ state: 'CORRECTING', resumeState: null });
    expect(r.effects).toContainEqual({ type: 'runStep', state: 'CORRECTING', variant: 'resume' });
  });

  it('waits for a usage limit and schedules the resume', () => {
    const r = ok(transition(at('REVIEWING'), { type: 'LIMIT_HIT', resumeAt: 1234 }, limits));
    expect(r.next).toMatchObject({ state: 'WAITING_LIMIT', resumeState: 'REVIEWING', resumeAt: 1234 });
    expect(r.effects).toContainEqual({ type: 'scheduleResume', at: 1234 });
  });

  it('goes to NEEDS_AUTH on auth failure', () => {
    expect(ok(transition(at('PLANNING'), { type: 'AUTH_FAILED' }, limits)).next).toMatchObject({
      state: 'NEEDS_AUTH',
      resumeState: 'PLANNING',
    });
  });

  it.each<RunState>(['PLANNING', 'PAUSED', 'WAITING_LIMIT', 'BLOCKED'])('cancels from %s', (state) => {
    const r = ok(transition(at(state), { type: 'CANCEL' }, limits));
    expect(r.next.state).toBe('CANCELLED');
    expect(r.effects).toContainEqual({ type: 'killActive' });
  });

  it('retries a failed step in place until attempts are exhausted', () => {
    const retry = ok(
      transition(at('IMPLEMENTING'), { type: 'STEP_FAILED', exhausted: false, reason: 'crash' }, limits),
    );
    expect(retry.next.state).toBe('IMPLEMENTING');
    expect(retry.effects).toContainEqual({ type: 'runStep', state: 'IMPLEMENTING', variant: 'retry' });
    const failed = ok(
      transition(at('IMPLEMENTING'), { type: 'STEP_FAILED', exhausted: true, reason: 'crash' }, limits),
    );
    expect(failed.next).toMatchObject({ state: 'FAILED', resumeState: 'IMPLEMENTING', blockReason: 'crash' });
  });

  it('lets the user retry BLOCKED and FAILED runs at the recorded state', () => {
    expect(
      ok(transition(at('FAILED', { resumeState: 'CHECKING' }), { type: 'RETRY' }, limits)).next.state,
    ).toBe('CHECKING');
    expect(
      ok(transition(at('BLOCKED', { resumeState: 'REVIEWING' }), { type: 'RETRY' }, limits)).next.state,
    ).toBe('REVIEWING');
  });

  it('marks active runs interrupted during recovery', () => {
    expect(ok(transition(at('CORRECTING'), { type: 'INTERRUPT' }, limits)).next).toMatchObject({
      state: 'INTERRUPTED',
      resumeState: 'CORRECTING',
    });
  });

  it('blocks on an engine-level cap such as wall clock', () => {
    expect(
      ok(transition(at('IMPLEMENTING'), { type: 'BLOCK', reason: 'max_wall_clock' }, limits)).next,
    ).toMatchObject({
      state: 'BLOCKED',
      blockReason: 'max_wall_clock',
    });
  });

  it('rejects events that do not apply to the current state', () => {
    expect(transition(at('PLANNING'), { type: 'IMPL_DONE' }, limits).ok).toBe(false);
    expect(transition(at('VERIFIED'), { type: 'RESUME' }, limits).ok).toBe(false);
    expect(transition(at('CANCELLED'), { type: 'RETRY' }, limits).ok).toBe(false);
    expect(transition(at('VERIFIED'), { type: 'CANCEL' }, limits).ok).toBe(false);
  });
});

describe('allowed actions', () => {
  it('reflects what the machine accepts', () => {
    expect(allowedActions(at('IMPLEMENTING'), limits)).toEqual(['pause', 'cancel']);
    expect(allowedActions(at('PAUSED', { resumeState: 'IMPLEMENTING' }), limits)).toEqual([
      'resume',
      'cancel',
    ]);
    expect(allowedActions(at('FAILED', { resumeState: 'IMPLEMENTING' }), limits)).toEqual([
      'cancel',
      'retry',
    ]);
    expect(allowedActions(at('VERIFIED'), limits)).toEqual(['integrate']);
    expect(allowedActions(at('PLAN_READY'), { ...limits, requirePlanApproval: true })).toContain(
      'approve-plan',
    );
  });
});

// ------------------------------------------------------------------ property: the only road to VERIFIED

const SAMPLE_EVENTS: MachineEvent[] = [
  { type: 'PREFLIGHT_OK' },
  { type: 'PREFLIGHT_FAILED', auth: false, reason: 'x' },
  { type: 'PREFLIGHT_FAILED', auth: true, reason: 'x' },
  { type: 'PLAN_OK' },
  { type: 'AUTO' },
  { type: 'APPROVE_PLAN' },
  { type: 'IMPL_DONE' },
  { type: 'GATES_DONE' },
  ...(['PASS', 'FIX_REQUIRED', 'REPLAN_REQUIRED', 'BLOCKED'] as const).flatMap((decision) =>
    [true, false].flatMap((guardOk) =>
      [true, false].map((repeated) => ({ type: 'REVIEW', decision, guardOk, repeated }) as MachineEvent),
    ),
  ),
  { type: 'FINAL_GATES', green: true },
  { type: 'FINAL_GATES', green: false },
  { type: 'PAUSE', mode: 'now' },
  { type: 'PAUSE', mode: 'graceful' },
  { type: 'RESUME' },
  { type: 'CANCEL' },
  { type: 'RETRY' },
  { type: 'LIMIT_HIT', resumeAt: 1 },
  { type: 'AUTH_FAILED' },
  { type: 'STEP_FAILED', exhausted: false, reason: 'x' },
  { type: 'STEP_FAILED', exhausted: true, reason: 'x' },
  { type: 'INTERRUPT' },
  { type: 'AUTH_OK' },
  { type: 'BLOCK', reason: 'x' },
  { type: 'STEP_DEFERRED', at: 1 },
  { type: 'PAUSE', mode: 'now', reason: 'network' },
];

function* contexts(): Generator<MachineSnapshot> {
  for (const state of RUN_STATES)
    for (const resumeState of [null, ...RUN_STATES])
      for (const iteration of [0, 3])
        for (const flags of [
          {},
          { escalated: true },
          { escalationPending: true },
          { pauseRequested: true },
          { contradictionRetries: 1 },
        ])
          yield at(state, { resumeState, iteration, replanCount: iteration === 3 ? 1 : 0, ...flags });
}

describe('property: VERIFIED is reachable only through green final gates', () => {
  it('holds for every state, context and event', () => {
    let checked = 0;
    for (const lim of [limits, { ...limits, requirePlanApproval: true }])
      for (const ctx of contexts())
        for (const event of SAMPLE_EVENTS) {
          const r = transition(ctx, event, lim);
          checked++;
          if (!r.ok) continue;
          const reachesVerified = r.next.state === 'VERIFIED' || r.next.resumeState === 'VERIFIED';
          if (reachesVerified) {
            expect({ from: ctx.state, event }).toEqual({
              from: 'FINAL_CHECKS',
              event: { type: 'FINAL_GATES', green: true },
            });
          }
          for (const effect of r.effects)
            if (effect.type === 'runStep') expect(effect.state).not.toBe('VERIFIED');
        }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('never leaves a closed run except through RETRY on BLOCKED/FAILED or CANCEL', () => {
    for (const ctx of contexts()) {
      if (!['VERIFIED', 'CANCELLED', 'BLOCKED', 'FAILED'].includes(ctx.state)) continue;
      for (const event of SAMPLE_EVENTS) {
        const r = transition(ctx, event, limits);
        if (!r.ok || r.next.state === ctx.state) continue;
        const allowed =
          (event.type === 'RETRY' && ['BLOCKED', 'FAILED'].includes(ctx.state)) ||
          (event.type === 'CANCEL' && ['BLOCKED', 'FAILED'].includes(ctx.state));
        expect({ state: ctx.state, event: event.type, allowed }).toEqual({
          state: ctx.state,
          event: event.type,
          allowed: true,
        });
      }
    }
  });
});
