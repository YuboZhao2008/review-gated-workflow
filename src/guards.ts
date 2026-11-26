import type { PlanV1, VerificationResultV1 } from './shared.ts';

export interface GuardResult {
  readonly ok: boolean;
  readonly problems: string[];
}

/**
 * PASS is accepted only with independent agreement: controller gates green, every mandatory
 * plan criterion marked verified by the reviewer, and no blocking findings.
 */
function hasEvidence(c: { evidence: string; evidence_refs: readonly string[] }): boolean {
  return c.evidence.trim().length > 0 || c.evidence_refs.some((ref) => ref.trim().length > 0);
}

export function passGuard(plan: PlanV1, review: VerificationResultV1, gatesGreen: boolean): GuardResult {
  const problems: string[] = [];
  if (!gatesGreen) problems.push('Controller gates are not green');
  const byId = new Map(review.criteria.map((c) => [c.id, c]));
  for (const criterion of plan.acceptance_criteria) {
    if (!criterion.mandatory) continue;
    const reviewed = byId.get(criterion.id);
    if (reviewed === undefined) problems.push(`${criterion.id} is missing from the review`);
    else if (reviewed.status !== 'verified') problems.push(`${criterion.id} is ${reviewed.status}`);
    else if (!hasEvidence(reviewed)) problems.push(`${criterion.id} is marked verified without evidence`);
  }
  const blocking = review.findings.filter((f) => f.blocking).length;
  if (blocking > 0) problems.push(`${blocking} blocking finding(s) remain`);
  return { ok: problems.length === 0, problems };
}

export interface StageCriterion {
  readonly code: string;
  readonly description: string;
  readonly mandatory: boolean;
}

const normaliseText = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** The planner may add derived criteria but must keep every user criterion verbatim and as strict. */
export function validatePlanAgainstStage(plan: PlanV1, stageCriteria: readonly StageCriterion[]): string[] {
  const problems: string[] = [];
  const byId = new Map(plan.acceptance_criteria.map((c) => [c.id, c]));
  for (const user of stageCriteria) {
    const planned = byId.get(user.code);
    if (!planned) {
      problems.push(`${user.code} is missing from the plan`);
      continue;
    }
    if (normaliseText(planned.description) !== normaliseText(user.description))
      problems.push(`${user.code} was reworded`);
    if (user.mandatory && !planned.mandatory) problems.push(`${user.code} must stay mandatory`);
  }
  return problems;
}

const REPEAT_THRESHOLD = 0.6;

/** ≥60% of the previous blocking fingerprints persist, or the correction changed nothing. */
export function isRepeatedFailure(
  previousBlocking: readonly string[],
  currentBlocking: readonly string[],
  correctionWasEmpty: boolean,
): boolean {
  if (previousBlocking.length === 0) return false;
  if (correctionWasEmpty) return true;
  const current = new Set(currentBlocking);
  const persisting = previousBlocking.filter((f) => current.has(f)).length;
  return persisting / previousBlocking.length >= REPEAT_THRESHOLD;
}
