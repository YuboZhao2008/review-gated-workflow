type Scalar = string | number | boolean | null;

export interface RegressionCase<Input, Output extends Scalar> {
  readonly name: string;
  readonly input: Input;
  readonly expected: Output;
}

/** Evaluate declared scalar expectations against a supplied in-process function. */
export function checkRegressions<Input, Output extends Scalar>(
  cases: readonly RegressionCase<Input, Output>[],
  observe: (input: Input) => Output,
) {
  if (cases.length === 0) throw new Error('At least one regression case is required');
  const checks = cases.map(({ name, input, expected }) => {
    const actual = observe(input);
    return { name, expected, actual, passed: Object.is(actual, expected) };
  });
  return { green: checks.every((check) => check.passed), checks };
}
