import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RUN_STATES,
  SUSPENDED_RUN_STATES,
  RUN_STATES,
  type RunState,
  samplePlan,
  sampleVerification,
} from './shared.ts';
import {
  initialMachine,
  transition,
  allowedActions,
  type MachineEvent,
  type MachineSnapshot,
} from './machine.ts';
import { passGuard } from './guards.ts';

const limits = { maxCorrectionIterations: 3, maxReplans: 1, requirePlanApproval: false };
const at = (state: RunState, patch: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
  ...initialMachine(),
  state,
  ...patch,
});

it('accepts plan approval only with the configured approval gate, and auto only without it', () => {
  for (const requirePlanApproval of [false, true]) {
    const config = { ...limits, requirePlanApproval };
    expect(transition(at('PLAN_READY'), { type: 'APPROVE_PLAN' }, config).ok).toBe(requirePlanApproval);
    expect(transition(at('PLAN_READY'), { type: 'AUTO' }, config).ok).toBe(!requirePlanApproval);
  }
});
function move(s: MachineSnapshot, e: MachineEvent, approval = false) {
  const r = transition(s, e, { ...limits, requirePlanApproval: approval });
  if (!r.ok) throw new Error(r.reason);
  return r;
}

// Exercise common transitions from every active state, not just one representative.
describe.each(ACTIVE_RUN_STATES)('common transitions from %s', (state) => {
  it('pauses now, cancels, interrupts, waits for limits, and requires auth revalidation', () => {
    const s = at(state);
    const paused = move(s, { type: 'PAUSE', mode: 'now' });
    expect(paused.next).toMatchObject({ state: 'PAUSED', resumeState: state });
    expect(paused.effects).toEqual(state === 'PLAN_READY' ? [] : [{ type: 'killActive' }]);
    expect(move(s, { type: 'CANCEL' }).effects).toEqual([
      { type: 'killActive' },
      { type: 'finalize', outcome: 'CANCELLED' },
    ]);
    expect(move(s, { type: 'INTERRUPT' }).next).toMatchObject({ state: 'INTERRUPTED', resumeState: state });
    const limited = move(s, { type: 'LIMIT_HIT', resumeAt: 123 });
    expect(limited.next).toMatchObject({ state: 'WAITING_LIMIT', resumeState: state, resumeAt: 123 });
    expect(limited.effects).toEqual([{ type: 'scheduleResume', at: 123 }]);
    expect(move(s, { type: 'AUTH_FAILED' }).next).toMatchObject({
      state: 'NEEDS_AUTH',
      resumeState: state,
      authCheckPending: true,
    });
  });

  it('distinguishes graceful pause, retriable failure, exhausted failure, and hard cap', () => {
    const s = at(state);
    expect(move(s, { type: 'PAUSE', mode: 'graceful' }).next).toMatchObject(
      state === 'PLAN_READY' ? { state: 'PAUSED', resumeState: state } : { state, pauseRequested: true },
    );
    expect(move(s, { type: 'STEP_FAILED', exhausted: false, reason: 'crash' }).effects).toEqual([
      { type: 'runStep', state, variant: 'retry' },
    ]);
    expect(move(s, { type: 'STEP_FAILED', exhausted: true, reason: 'crash' }).next).toMatchObject({
      state: 'FAILED',
      resumeState: state,
      blockReason: 'crash',
    });
    expect(move(s, { type: 'BLOCK', reason: 'wall_clock' }).next).toMatchObject({
      state: 'BLOCKED',
      resumeState: state,
      blockReason: 'wall_clock',
    });
  });
});

describe.each([...SUSPENDED_RUN_STATES, 'BLOCKED', 'FAILED'] as const)(
  'resume/retry guard from %s',
  (state) => {
    it('accepts only active resume targets and keeps pending work identity', () => {
      const type = state === 'BLOCKED' || state === 'FAILED' ? 'RETRY' : 'RESUME';
      for (const target of [null, ...RUN_STATES]) {
        const s = at(state, { resumeState: target, workId: 12, workVariant: 'escalation' });
        const r = transition(s, { type }, limits);
        const valid = target !== null && (ACTIVE_RUN_STATES as readonly string[]).includes(target);
        expect(r.ok).toBe(valid);
        if (r.ok) {
          expect(r.next.state).toBe(target);
          expect(r.next.workId).toBe(type === 'RETRY' ? 13 : 12);
          expect(r.next.workVariant).toBe('escalation');
          if (state === 'NEEDS_AUTH') expect(r.next.authCheckPending).toBe(true);
        }
        expect(allowedActions(s, limits)).toContain('cancel');
        expect(allowedActions(s, limits).includes(type === 'RETRY' ? 'retry' : 'resume')).toBe(valid);
      }
    });
  },
);

it('blocks escalation at the correction cap and never converts a cap into a PASS', () => {
  const s = at('REVIEWING', { escalationPending: true, iteration: 3 });
  const result = move(s, { type: 'REVIEW', decision: 'FIX_REQUIRED', guardOk: false, repeated: false });
  expect(result.next).toMatchObject({ state: 'BLOCKED', blockReason: 'max_correction_iterations' });
});

it('dashboard machine controls exactly match legal transitions for every state and guard', () => {
  const commands = {
    pause: { type: 'PAUSE', mode: 'now' },
    cancel: { type: 'CANCEL' },
    resume: { type: 'RESUME' },
    retry: { type: 'RETRY' },
  } as const;
  for (const state of RUN_STATES)
    for (const resumeState of [null, 'REVIEWING', 'VERIFIED'] as const) {
      const s = at(state, { resumeState });
      for (const [action, event] of Object.entries(commands))
        expect(allowedActions(s, limits).includes(action as keyof typeof commands)).toBe(
          transition(s, event, limits).ok,
        );
    }
});

it('successful gates alone and authoritative decisions without evidence cannot verify a reachable run', () => {
  for (const green of [false, true])
    for (const decision of ['PASS', 'FIX_REQUIRED', 'REPLAN_REQUIRED', 'BLOCKED'] as const)
      for (const evidence of [false, true]) {
        let s = initialMachine();
        for (const e of [
          { type: 'PREFLIGHT_OK' },
          { type: 'PLAN_OK' },
          { type: 'AUTO' },
          { type: 'IMPL_DONE' },
          { type: 'GATES_DONE' },
        ] as const)
          s = move(s, e).next;
        const review = sampleVerification(decision);
        if (!evidence)
          review.criteria = review.criteria.map((c) => ({ ...c, evidence: '', evidence_refs: [] }));
        const guard = passGuard(samplePlan(), review, green);
        s = move(s, { type: 'REVIEW', decision, guardOk: guard.ok, repeated: false }).next;
        const final = transition(s, { type: 'FINAL_GATES', green: true }, limits);
        expect(final.ok && final.next.state === 'VERIFIED').toBe(green && decision === 'PASS' && evidence);
      }
});
