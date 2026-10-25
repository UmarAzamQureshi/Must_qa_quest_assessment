# MUST Company Quest Assessment — Settlement QA Directive

## Objective

Verify that the weekly rewards settlement workflow protects contributor credit balances from duplicate payouts, applies a consistent UTC eligibility window, and keeps payout state independent from notification delivery. Provide a runnable, evidence-based assessment handoff that distinguishes tested mock behavior from production readiness.

## Scope

This JavaScript assessment package covers:

- weekly settlement scheduling and task-window eligibility;
- duplicate detection within a batch, retries, replay, and concurrent execution;
- payout ledger integrity, exact credit totals, and task-state transitions;
- notification exceptions and HTTP 500 responses;
- malformed inputs and item-level processing failures;
- bounded batch processing, deadlock/serialization retries, and resumable cursors; and
- the custom Playwright fixtures, service facade, and in-memory settlement service.

The package is an in-memory mock and automated assessment harness. It does not include a production database, external payment or rewards provider, scheduler deployment, authentication/authorization layer, durable queue, notification provider, or production telemetry.

## Requirements

1. A settlement run must be scheduled for Tuesday at 09:00:00 UTC.
2. Eligible task submission times must fall in the half-open interval from Monday 00:00:00 UTC inclusive through the following Monday 00:00:00 UTC exclusive, after parsing offsets as absolute instants.
3. Each task ID must create no more than one payout. Repeated, replayed, and concurrent attempts must not increase the ledger or credit total.
4. Payout records must retain task, user, batch, settlement time, amount, and paid status for auditability.
5. Notification failure must be surfaced as a notification failure without undoing a committed payout.
6. Invalid schedule values, malformed tasks, invalid reward amounts, and item-processing errors must be reported deterministically and must not create invalid ledger entries.
7. Large batches must use bounded chunks; retryable write failures must roll back provisional state; interrupted batch processing must resume without duplicate payouts.
8. Automated regression tests must be runnable from the project root using `npx playwright test`.

## Actionable Defect Report

### Defect under assessment: duplicate payout risk on retry or replay

**Classification:** High-impact financial-integrity failure mode; primary assessment risk  
**Status:** The current mock's regression tests pass. A defective baseline or production incident was not supplied, so the historical occurrence of this defect is unverified.

#### Reproduction steps for the failure mode

The current regression scenario in `tests/settlement.spec.js` exercises the safe behavior:

1. Seed one valid task in the weekly settlement window.
2. Trigger settlement for the valid Tuesday 09:00 UTC run.
3. Trigger settlement again for the same run after the first attempt has returned.
4. Compare the first and second attempt's payouts, duplicate records, ledger count, and total credits.

The concurrent regression uses a deferred notification to hold the first settlement in progress, then starts a second request with the same batch ID and verifies that the second request conflicts rather than issuing a second payout.

To reproduce the **unsafe failure mode** on a defective implementation, the same scenarios would result in the repeated task being inserted or credited again. No unsafe baseline is available in this workspace to execute or claim as observed.

#### Expected vs. actual behavior

| Aspect | Expected behavior | Verified current mock behavior | Defective behavior to prevent |
|---|---|---|---|
| Retried settlement | First eligible task is paid once; replay returns no new payout and does not increase ledger count or credits | Test verifies first attempt pays once, replay has zero payouts, and ledger remains at one entry | Replay creates a second payout or increases the balance |
| Concurrent same-batch request | Concurrent duplicate is rejected with an explicit conflict while the active settlement completes once | Test verifies `SETTLEMENT_CONFLICT`, one payout, and one ledger entry | Both requests commit the same task or return success with duplicate credits |
| Ledger record | One auditable payout per task ID | Tests assert exact payout metadata, ledger contents, and totals | Multiple ledger entries for the same task ID |

#### Severity rationale

**Critical risk if present in production.** A duplicate payout directly inflates a contributor balance and may enable downstream redemption or require financial reconciliation. The consequence can affect many tasks when retries or queue replays occur at scale. The critical rating is based on the potential user and financial impact, not on a verified production incident.

#### Root-cause analysis

The underlying design hazard is treating each delivery attempt as a new instruction rather than binding payout creation to a stable idempotency identity. In production, an in-memory check alone is insufficient: concurrent workers or process restarts can bypass it, and an application-level “check then insert” can race without a database constraint or transaction.

The current mock protects against this assessment scenario with task-ID checks against the ledger, a settlement-in-progress conflict guard, and batch cursor/fingerprint state for resumable processing. Those controls demonstrate intended behavior inside one process and do not prove durability or cross-process safety.

#### Evidence from test runs

The following evidence is from the verified local Playwright run:

- Command: `npx playwright test`
- Result: **17 passed, 0 failed** (one worker; reported duration 708 ms)
- Relevant test coverage:
  - duplicate task IDs within a batch produce one payout;
  - replay after settlement does not pay the task twice;
  - concurrent identical batches conflict without double-crediting;
  - deadlock retry rollback preserves ledger integrity; and
  - interrupted chunk processing resumes without duplicate payouts.

This is regression evidence for the checked-out mock and test fixtures only. It is not evidence that a production incident occurred or that production systems are protected.

#### Proposed architectural fix for production

1. Define a stable idempotency key for the payout unit, normally a unique task ID (or a carefully defined composite key if the business domain allows a task to be paid across multiple settlement periods).
2. Enforce uniqueness in durable storage with a database unique constraint on that key; do not rely solely on an application-level pre-check.
3. In one database transaction, create the payout ledger entry and transition the task to paid. Make retry behavior return the existing committed result rather than create another credit.
4. Use concurrency-safe transaction isolation or equivalent atomic conditional writes so simultaneous workers cannot both commit.
5. Persist settlement batch/cursor progress with the ledger transaction, and bind a cursor to the settlement schedule and immutable input fingerprint. Define recovery behavior for interrupted batches.
6. Write notification work to a transactional outbox with the payout commit, deliver asynchronously with its own retry policy, and track notification status separately. A notification error must never reverse a committed payout.
7. Add reconciliation and monitoring for duplicate-key conflicts, failed/retried notifications, stuck cursors, payout totals, and ledger/task-state mismatches. Alert thresholds and ownership must be set from real operational baselines.
8. Add integration and failure-injection tests against the chosen database and queue before production release.

### Related risks covered by the suite

- **Cut-off boundary drift:** Tests cover the lower boundary, the first instant after it, next-week exclusion, and offset timestamps normalized to UTC.
- **Notification delivery failure:** Tests cover a thrown exception and an HTTP 500 response while asserting that payout state and ledger totals remain committed.
- **Malformed and failed items:** Tests cover invalid payloads, poison-pill processing errors, and invalid fractional reward amounts while preserving valid item processing.

## Release-Readiness Checklist & Handoff Instructions

### Automated release-blocking checks

The assessment release gate is:

- [ ] Run `npx playwright test` from the project root.
- [ ] Block assessment sign-off if the command exits nonzero, any of the 17 settlement scenarios fail, or expected test files/fixtures are missing.
- [ ] Review the Playwright output and confirm the executed count is 17, with no skipped or unexpectedly filtered settlement cases.
- [ ] Confirm the regression suite covers payout idempotency, UTC boundaries, notification isolation, ledger integrity, concurrency, batch recovery, and transaction retry behavior.

No separate lint, type-check, or build script is declared in the current `package.json`; do not imply those checks ran. Add them as explicit CI gates if required by the production repository.

### Assessment verification recorded

- The complete command `npx playwright test` was run from the project root.
- Outcome: **17 passed, 0 failed**.
- The current suite includes the 17 named scenarios in `tests/settlement.spec.js`.
- The test result verifies the local mock behavior at the time of the run; rerun the command on the submission commit or CI environment before final sign-off.

### Remaining gaps before production release

- In-memory maps and cursors are not durable and do not provide cross-process atomicity.
- No real database transaction, unique constraint, queue delivery, scheduler, payment/rewards provider, or notification service is integrated.
- No authentication, authorization, tenant isolation, or production input-boundary review is in scope.
- No deployment pipeline, production observability, alerting, reconciliation process, load profile, disaster recovery, or operational ownership is verified here.
- Retry and cursor behavior require integration testing against the production persistence and queue technologies.
- Risk frequency, customer impact, and alert thresholds must be validated using real telemetry; this assessment contains no production incident history.

### Reviewer handoff instructions

1. Open the project root and read [intent.md](./intent.md) for prioritization, assumptions, and treatment of uncertainty.
2. Review [tests/settlement.spec.js](./tests/settlement.spec.js) for the 17 executable scenarios.
3. Review [fixtures/settlementFixtures.js](./fixtures/settlementFixtures.js) for deterministic test setup and seeded scenario data.
4. Review [pages/SettlementServiceFacade.js](./pages/SettlementServiceFacade.js) for the test-facing API.
5. Review [src/settlementService.js](./src/settlementService.js) for the in-memory mock implementation and its limits.
6. From the root, run `npx playwright test` and retain the command output (or CI run URL) with the submission. The tests are the source of truth for the current run; do not treat a stale generated report as a substitute for rerunning.
7. Treat the result as assessment readiness only. Complete the listed production gaps and review them with the responsible engineering, finance, and operations owners before any production release.

### Completion criteria

- [x] Intent document ranks at least three risks by user impact, potential frequency, and effort, and justifies the primary risk.
- [x] Documentation distinguishes assumptions and test evidence from unverified incident history.
- [x] Directive documents scope, requirements, defect report, release gates, remaining gaps, and handoff steps.
- [x] All 17 Playwright test cases are present and pass with `npx playwright test`.
- [ ] Production release readiness: **not met by this assessment alone**; close the production gaps above.

## Results/Handoff Appendix

- **GitHub repository:** [Must_qa_quest_assessment](https://github.com/UmarAzamQureshi/Must_qa_quest_assessment)
- **Loom walkthrough:** [Watch the settlement QA walkthrough](https://www.loom.com/share/2de7dc4e1a7c4b8cbc82ac6f1486812c)
- **Playwright run / CI evidence:** The directive records a prior local result of **17 passed, 0 failed**. The [settlement test suite](https://github.com/UmarAzamQureshi/Must_qa_quest_assessment/blob/3dc9c19c53e120e6af0a1bcad89b9e143e41a605/tests/settlement.spec.js) is available for review. No CI run or raw test-output artifact is currently available; rerun `npx playwright test` on the final revision and attach its output or CI link.
- **Submission commit / revision:** [Current published baseline: `3dc9c19c53e120e6af0a1bcad89b9e143e41a605`](https://github.com/UmarAzamQureshi/Must_qa_quest_assessment/commit/3dc9c19c53e120e6af0a1bcad89b9e143e41a605). Replace this with the final submission revision after the completed handoff is published.

> Decision: **READY FOR ASSESSMENT HANDOFF / NOT A PRODUCTION RELEASE.** The checked-out assessment suite passes, but the mock does not provide the durable storage and operational guarantees required for production settlement.
