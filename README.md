# Gatewright

A deterministic TypeScript engine for staged code review and regression checks. A review verdict alone cannot mark a change verified. The workflow requires passing checks, evidence for every mandatory criterion, and a passing final gate.

## Try it

Requires Node.js 24 or later.

```sh
npm ci --ignore-scripts
npm run demo
npm test
npm run typecheck
```

The demo runs three title-validation cases against two in-memory implementations. One rejects a blank title with status 400; the other mistakenly returns 201. [The regression checker](src/regression.ts) compares each actual result with its expected value and passes the outcome to the workflow.

| Scenario | Final state |
| --- | --- |
| Review includes evidence and every final case passes | `VERIFIED` |
| Review includes evidence but the blank-title case fails | `REVIEWING` |
| Two reviews say pass without evidence for a required criterion | `CORRECTING` |

## How it works

```text
Plan → Approve → Implement → Check → Review → Final checks → Verified
                   ↑                   │              │
                   └── Correction ←────┘              └── failure → Review
```

- [State machine](src/machine.ts): `transition(snapshot, event, limits)` returns a new snapshot and descriptions of the work to do next. It does not execute those effects. Tests cover plan approval, bounded retries, interruption and resumption, and the verification gate.
- [Review guards](src/guards.ts): Check that the plan preserves mandatory criteria and that a passing review provides evidence for each one. A failed check or blocking finding prevents verification.
- [Structured inputs](src/artifacts.ts): Zod schemas describe plans, implementation reports, and review results. [Fixtures](src/fixtures.ts) keep the examples and tests reproducible.

The demo only evaluates in-process functions against synthetic fixtures. It does not run shell commands, launch external agents, integrate changes, or contact a service.
