import { describe, expect, it } from 'vitest';
import { samplePlan, sampleVerification } from './shared.ts';
import { passGuard, validatePlanAgainstStage, isRepeatedFailure } from './guards.ts';

describe('passGuard', () => {
  it('accepts PASS when every mandatory criterion is verified, nothing blocks and gates are green', () => {
    expect(passGuard(samplePlan(), sampleVerification('PASS'), true)).toEqual({ ok: true, problems: [] });
  });

  it('rejects PASS when gates are red', () => {
    expect(passGuard(samplePlan(), sampleVerification('PASS'), false).problems).toContain(
      'Controller gates are not green',
    );
  });

  it('rejects PASS when a mandatory criterion is not verified', () => {
    const review = sampleVerification('PASS', {
      criteria: [{ id: 'AC-U1', status: 'not_verifiable', evidence: '', evidence_refs: [] }],
    });
    const result = passGuard(samplePlan(), review, true);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['AC-U1 is not_verifiable', 'AC-U2 is missing from the review']);
  });

  it('rejects PASS with blocking findings', () => {
    const findings = sampleVerification('FIX_REQUIRED').findings;
    expect(passGuard(samplePlan(), sampleVerification('PASS', { findings }), true).problems).toContain(
      '1 blocking finding(s) remain',
    );
  });

  it.each(['', '   \n '])(
    'rejects a verified mandatory criterion with blank evidence %j',
    (evidence) => {
      const review = sampleVerification('PASS', {
        criteria: [
          { id: 'AC-U1', status: 'verified', evidence, evidence_refs: [] },
          { id: 'AC-U2', status: 'verified', evidence: 'test passes', evidence_refs: [] },
        ],
      });
      expect(passGuard(samplePlan(), review, true).problems).toEqual([
        'AC-U1 is marked verified without evidence',
      ]);
    },
  );

  it('accepts evidence given only as references', () => {
    const review = sampleVerification('PASS', {
      criteria: [
        { id: 'AC-U1', status: 'verified', evidence: '', evidence_refs: ['test/todos.test.js:12'] },
        { id: 'AC-U2', status: 'verified', evidence: 'ok', evidence_refs: [] },
      ],
    });
    expect(passGuard(samplePlan(), review, true).ok).toBe(true);
  });

  it('ignores optional criteria', () => {
    const plan = samplePlan();
    const optional = plan.acceptance_criteria.map((c) => (c.id === 'AC-U2' ? { ...c, mandatory: false } : c));
    const review = sampleVerification('PASS', {
      criteria: [{ id: 'AC-U1', status: 'verified', evidence: 'ok', evidence_refs: [] }],
    });
    expect(passGuard({ ...plan, acceptance_criteria: optional }, review, true).ok).toBe(true);
  });
});

describe('validatePlanAgainstStage', () => {
  const stage = [
    { code: 'AC-U1', description: 'POST /todos rejects empty titles with 400', mandatory: true },
    { code: 'AC-U2', description: 'GET /todos returns created items', mandatory: true },
  ];

  it('accepts a plan that keeps every user criterion verbatim', () => {
    expect(validatePlanAgainstStage(samplePlan(), stage)).toEqual([]);
  });

  it('reports dropped, reworded or weakened user criteria', () => {
    const plan = samplePlan();
    const changed = {
      ...plan,
      acceptance_criteria: [{ ...plan.acceptance_criteria[0]!, description: 'POST works', mandatory: false }],
    };
    expect(validatePlanAgainstStage(changed, stage)).toEqual([
      'AC-U1 was reworded',
      'AC-U1 must stay mandatory',
      'AC-U2 is missing from the plan',
    ]);
  });
});

describe('isRepeatedFailure', () => {
  it('is false with no previous review', () => {
    expect(isRepeatedFailure([], ['a'], false)).toBe(false);
  });
  it('is true when at least 60% of previous blocking fingerprints persist', () => {
    expect(isRepeatedFailure(['a', 'b', 'c'], ['a', 'b', 'x'], false)).toBe(true);
    expect(isRepeatedFailure(['a', 'b', 'c'], ['a', 'x'], false)).toBe(false);
  });
  it('is true when the correction produced no changes', () => {
    expect(isRepeatedFailure(['a'], ['z'], true)).toBe(true);
  });
});
