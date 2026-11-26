import { describe, expect, it, vi } from 'vitest';
import { checkRegressions } from './regression.ts';

const cases = [
  { name: 'blank rejected', input: '', expected: 400 },
  { name: 'title accepted', input: 'buy milk', expected: 201 },
];

describe('checkRegressions', () => {
  it('passes when all observations equal their expectations', () => {
    const observe = vi.fn((title: string) => (title ? 201 : 400));
    expect(checkRegressions(cases, observe)).toMatchObject({
      green: true,
      checks: [{ passed: true }, { passed: true }],
    });
    expect(observe.mock.calls).toEqual([[''], ['buy milk']]);
  });

  it('fails when an observation deviates and retains both values', () => {
    expect(checkRegressions(cases, () => 201)).toEqual({
      green: false,
      checks: [
        { name: 'blank rejected', expected: 400, actual: 201, passed: false },
        { name: 'title accepted', expected: 201, actual: 201, passed: true },
      ],
    });
  });

  it('does not certify an empty case list', () => {
    expect(() => checkRegressions([], () => 201)).toThrow('At least one regression case is required');
  });
});
