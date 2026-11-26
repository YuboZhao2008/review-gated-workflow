import type { PlanV1, VerificationResultV1, Decision } from './artifacts.ts';

// Synthetic artifacts shared by the demo and tests.

export function samplePlan(overrides: Partial<PlanV1> = {}): PlanV1 {
  return {
    schema_version: 1,
    summary: 'Implement the in-memory todo HTTP service.',
    narrative_markdown: '## Plan\n1. Add the service.\n2. Add tests.',
    assumptions: ['Node built-in test runner is acceptable.'],
    architecture_notes: 'Single module exporting a request handler.',
    tasks: [
      {
        id: 'T1',
        title: 'Implement todo routes',
        description: 'GET and POST /todos',
        detailed_instructions: 'Create src/server.js exporting createServer().',
        files: [{ path: 'src/server.js', action: 'create' }],
        depends_on: [],
        test_requirements: ['POST validates title'],
      },
    ],
    acceptance_criteria: [
      {
        id: 'AC-U1',
        description: 'POST /todos rejects empty titles with 400',
        mandatory: true,
        verification: { method: 'test', command: 'npm test', expected: 'validation test passes' },
      },
      {
        id: 'AC-U2',
        description: 'GET /todos returns created items',
        mandatory: true,
        verification: { method: 'test', command: 'npm test', expected: 'listing test passes' },
      },
    ],
    allowed_paths: ['src/**', 'test/**', 'package.json'],
    protected_paths: ['.github/**'],
    out_of_scope: ['Persistence'],
    risks: [],
    regression_commands: ['npm test'],
    ...overrides,
  };
}

export function sampleVerification(
  decision: Decision,
  overrides: Partial<VerificationResultV1> = {},
): VerificationResultV1 {
  const failing = decision !== 'PASS';
  return {
    decision,
    summary: failing ? 'Validation is missing.' : 'All criteria verified.',
    criteria: [
      {
        id: 'AC-U1',
        status: failing ? 'failed' : 'verified',
        evidence: 'npm test output',
        evidence_refs: [],
      },
      { id: 'AC-U2', status: 'verified', evidence: 'npm test output', evidence_refs: [] },
    ],
    tests: [
      {
        command: 'npm test',
        exit_code: failing ? 1 : 0,
        passed: failing ? 1 : 2,
        failed: failing ? 1 : 0,
        summary: '',
      },
    ],
    findings: failing
      ? [
          {
            id: 'F1',
            severity: 'high',
            category: 'correctness',
            title: 'POST accepts empty title',
            detail: 'No validation on title.',
            file: 'src/server.js',
            line: 12,
            criterion_id: 'AC-U1',
            blocking: true,
            required_fix: 'Return 400 when title is not a non-empty string.',
          },
        ]
      : [],
    correction_plan: failing
      ? [{ finding_ids: ['F1'], instructions: 'Add title validation.', files: ['src/server.js'] }]
      : null,
    replan_reason: decision === 'REPLAN_REQUIRED' ? 'Architecture cannot satisfy AC-U1.' : null,
    blocker: decision === 'BLOCKED' ? { reason: 'Missing dependency', needs_from_user: 'Install it' } : null,
    unnecessary_changes: [],
    ...overrides,
  };
}
