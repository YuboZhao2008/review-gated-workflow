import { passGuard } from './guards.ts';
import { samplePlan, sampleVerification } from './fixtures.ts';
import { checkRegressions } from './regression.ts';
import { initialMachine, transition, type MachineEvent, type MachineSnapshot } from './machine.ts';

const limits = {
  maxCorrectionIterations: 1,
  maxReplans: 1,
  requirePlanApproval: true,
};

const readyForReview: MachineEvent[] = [
  { type: 'PREFLIGHT_OK' },
  { type: 'PLAN_OK' },
  { type: 'APPROVE_PLAN' },
  { type: 'IMPL_DONE' },
  { type: 'GATES_DONE' },
];

const plan = samplePlan();
const passed = sampleVerification('PASS');

const titleChecks = [
  { name: 'accept nonempty title', input: 'Pick up groceries', expected: 201 },
  { name: 'reject blank title', input: '  ', expected: 400 },
  { name: 'reject non-string title', input: null, expected: 400 },
];
const validateTitle = (title: unknown): number =>
  typeof title === 'string' && title.trim().length > 0 ? 201 : 400;
const validateTitleWithRegression = (title: unknown): number =>
  typeof title === 'string' ? 201 : 400;

const baselineGate = checkRegressions(titleChecks, validateTitle);
const regressedGate = checkRegressions(titleChecks, validateTitleWithRegression);
if (!baselineGate.green || regressedGate.green) throw new Error('Unexpected regression check result');

function replay(label: string, events: MachineEvent[], expected: MachineSnapshot['state']): void {
  console.log(label);
  let snapshot = initialMachine();
  for (const event of events) {
    const result = transition(snapshot, event, limits);
    if (!result.ok) throw new Error(result.reason);
    console.log(`  ${snapshot.state} + ${event.type} -> ${result.next.state}`);
    snapshot = result.next;
  }
  if (snapshot.state !== expected) throw new Error(`Expected ${expected}, got ${snapshot.state}`);
  console.log(`  Outcome: ${snapshot.state}\n`);
}

const passingReview: MachineEvent = {
  type: 'REVIEW',
  decision: 'PASS',
  guardOk: passGuard(plan, passed, baselineGate.green).ok,
  repeated: false,
};

const corrected: MachineEvent[] = [
  ...readyForReview,
  { type: 'REVIEW', decision: 'FIX_REQUIRED', guardOk: false, repeated: false },
  { type: 'IMPL_DONE' },
  { type: 'GATES_DONE' },
  passingReview,
];

replay(
  'Scenario: corrected change passes final checks',
  [...corrected, { type: 'FINAL_GATES', green: baselineGate.green }],
  'VERIFIED',
);
for (const failure of regressedGate.checks.filter((check) => !check.passed)) {
  console.log(`Regression: ${failure.name}; expected ${failure.expected}, got ${failure.actual}`);
}
replay(
  'Scenario: corrected change fails final checks',
  [...corrected, { type: 'FINAL_GATES', green: regressedGate.green }],
  'REVIEWING',
);

const unsupportedPass = sampleVerification('PASS', {
  criteria: passed.criteria.map((criterion) =>
    criterion.id === 'AC-U1' ? { ...criterion, evidence: '', evidence_refs: [] } : criterion,
  ),
});
const guard = passGuard(plan, unsupportedPass, baselineGate.green);
const contradictoryReview: MachineEvent = {
  type: 'REVIEW',
  decision: 'PASS',
  guardOk: guard.ok,
  repeated: false,
};
console.log(`Rejected PASS: ${guard.problems.join('; ')}`);
replay(
  'Scenario: mandatory evidence is missing on both reviews',
  [...readyForReview, contradictoryReview, contradictoryReview],
  'CORRECTING',
);
