import { z } from 'zod';

// Artifacts exchanged between workflow stages. Every object is strict and every property is
// required (optional values are nullable) to keep the generated JSON Schema explicit.

const str = z.string();
const strList = z.array(z.string());

export const PlanTaskFile = z.strictObject({
  path: str,
  action: z.enum(['create', 'modify', 'delete']),
});

export const PlanTask = z.strictObject({
  id: str,
  title: str,
  description: str,
  detailed_instructions: str,
  files: z.array(PlanTaskFile),
  depends_on: strList,
  test_requirements: strList,
});

export const CriterionVerification = z.strictObject({
  method: z.enum(['test', 'command', 'inspection', 'browser']),
  command: str.nullable(),
  expected: str,
});

export const AcceptanceCriterion = z.strictObject({
  id: str,
  description: str,
  mandatory: z.boolean(),
  verification: CriterionVerification,
});

export const PlanV1 = z.strictObject({
  schema_version: z.literal(1),
  summary: str,
  narrative_markdown: str,
  assumptions: strList,
  architecture_notes: str,
  tasks: z.array(PlanTask),
  acceptance_criteria: z.array(AcceptanceCriterion),
  allowed_paths: strList,
  protected_paths: strList,
  out_of_scope: strList,
  risks: strList,
  regression_commands: strList,
});
export type PlanV1 = z.infer<typeof PlanV1>;
export type PlanTask = z.infer<typeof PlanTask>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const ImplementationReportV1 = z.strictObject({
  summary: str,
  tasks: z.array(z.strictObject({ id: str, status: z.enum(['done', 'partial', 'skipped']), notes: str })),
  commands_run: z.array(z.strictObject({ command: str, outcome: str })),
  deviations: strList,
  open_questions: strList,
  blockers: strList,
});
export type ImplementationReportV1 = z.infer<typeof ImplementationReportV1>;

export const DECISIONS = ['PASS', 'FIX_REQUIRED', 'REPLAN_REQUIRED', 'BLOCKED'] as const;
export const Decision = z.enum(DECISIONS);
export type Decision = z.infer<typeof Decision>;

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

export const FindingCategory = z.enum([
  'correctness',
  'missing',
  'regression',
  'security',
  'quality',
  'scope',
]);

export const Finding = z.strictObject({
  id: str,
  severity: Severity,
  category: FindingCategory,
  title: str,
  detail: str,
  file: str.nullable(),
  line: z.number().int().nullable(),
  criterion_id: str.nullable(),
  blocking: z.boolean(),
  required_fix: str,
});
export type Finding = z.infer<typeof Finding>;

export const CriterionStatus = z.enum(['verified', 'failed', 'not_verifiable']);
export type CriterionStatus = z.infer<typeof CriterionStatus>;

export const VerificationResultV1 = z.strictObject({
  decision: Decision,
  summary: str,
  criteria: z.array(
    z.strictObject({ id: str, status: CriterionStatus, evidence: str, evidence_refs: strList }),
  ),
  tests: z.array(
    z.strictObject({
      command: str,
      exit_code: z.number().int().nullable(),
      passed: z.number().int().nullable(),
      failed: z.number().int().nullable(),
      summary: str,
    }),
  ),
  findings: z.array(Finding),
  correction_plan: z
    .array(z.strictObject({ finding_ids: strList, instructions: str, files: strList }))
    .nullable(),
  replan_reason: str.nullable(),
  blocker: z.strictObject({ reason: str, needs_from_user: str }).nullable(),
  unnecessary_changes: strList,
});
export type VerificationResultV1 = z.infer<typeof VerificationResultV1>;

function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;
  return rest;
}

export const planJsonSchema = toStrictJsonSchema(PlanV1);
export const verificationJsonSchema = toStrictJsonSchema(VerificationResultV1);
export const implementationReportJsonSchema = toStrictJsonSchema(ImplementationReportV1);
