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
8. Automated regression tests must be runnable from the project root using `npm test`.

## Assumptions: account and admin changes

- The task's `userId` and `rewardCredits` are treated as the values captured with the submitted task. Account reassignment or reward-setting changes during a settlement run are out of scope; they do not retroactively alter an in-flight batch.
- The fixture data and settlement rules remain fixed for one batch. The mock rejects changed batch input on cursor resume rather than applying a new account assignment or reward setting partway through.
- The service does not model an admin console or production account-management policy. These are explicit test assumptions, not verified product behavior.

## Actionable Defect Report

### Defect under assessment: duplicate payout risk on retry or replay

**Classification:** High-impact financial-integrity failure mode; primary assessment risk  
**Status:** The current mock passes the replay regression. A test-local faulty reference intentionally omits idempotency and fails the same one-payout assertion. This reference demonstrates the failure mode; it is not a historical build, production implementation, or evidence of an actual incident.

#### Reproduction steps for the failure mode

The current regression scenario in `tests/settlement.spec.js` exercises the safe behavior:

1. Seed one valid task in the weekly settlement window.
2. Trigger settlement for the valid Tuesday 09:00 UTC run.
3. Trigger settlement again for the same run after the first attempt has returned.
4. Compare the first and second attempt's payouts, duplicate records, ledger count, and total credits. The current mock returns no new payout on replay.

The concurrent regression uses a deferred notification to hold the first settlement in progress, then starts a second request with the same batch ID and verifies that the second request conflicts rather than issuing a second payout.

To demonstrate the **unsafe failure mode**, run the test titled `faulty reference: replay creates a duplicate payout (regression assertion fails)`. Its synthetic reference appends a payout on every call without checking task identity. The test expects one payout, so it is reported as an expected failure. The adjacent retry regression runs against `SettlementService` and is expected to pass, showing the corrected behavior. This is a deliberately bounded reference model, not a claim that the real service historically contained this defect.

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

#### Regression evidence

- **Faulty reference:** two settlement attempts append two ledger entries for one task; the one-entry regression assertion fails as intended and is marked as an expected failure by Playwright.
- - **Corrected mock:** the retry regression in `tests/settlement.spec.js` asserts one ledger entry and 10 total credits after replay; rerun the suite on the final revision to confirm the current result.
- The suite therefore contains 17 corrected-behavior checks plus one expected-failure demonstration of the unguarded reference model. The expected failure is not a failing product test.
- Relevant additional coverage:
  - duplicate task IDs within a batch produce one payout;
  - replay after settlement does not pay the task twice;
  - concurrent identical batches conflict without double-crediting;
  - deadlock retry rollback preserves ledger integrity; and
  - interrupted chunk processing resumes without duplicate payouts.

Run `npm test` from the project root. Confirm the faulty-reference case is listed as an expected failure and the corrected replay case passes. Record the actual terminal summary in the handoff; do not describe the synthetic baseline as a historical reproduction. This is evidence for the checked-out mock and test fixtures only, not evidence that a production incident occurred or that production systems are protected.

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

- [ ] Run `npm test` from the project root.
- [ ] Block assessment sign-off if the command exits nonzero, any of the 17 corrected-behavior checks fail, the faulty-reference case is not reported as an expected failure, or required test files/fixtures are missing.
- [ ] Review Playwright output and confirm all 18 cases execute: 17 passing corrected-behavior checks and one expected-failure demonstration.
- [ ] Confirm the regression suite covers payout idempotency, UTC boundaries, notification isolation, ledger integrity, concurrency, batch recovery, and transaction retry behavior.

No separate lint, type-check, or build script is declared in the current `package.json`; do not imply those checks ran. Add them as explicit CI gates if required by the production repository.

### Assessment verification recorded

- The current suite includes 17 corrected-behavior checks and one test-local faulty-reference demonstration in `tests/settlement.spec.js`.
- The faulty-reference test is intentionally marked as an expected failure; it must not be mistaken for a regression in the corrected mock.
- Run `npm test` on the final submission revision and record its actual result here or attach the raw output/CI link before sign-off.

### Remaining gaps before production release

- In-memory maps and cursors are not durable and do not provide cross-process atomicity.
- No real database transaction, unique constraint, queue delivery, scheduler, payment/rewards provider, or notification service is integrated.
- No authentication, authorization, tenant isolation, or production input-boundary review is in scope.
- No deployment pipeline, production observability, alerting, reconciliation process, load profile, disaster recovery, or operational ownership is verified here.
- Retry and cursor behavior require integration testing against the production persistence and queue technologies.
- Risk frequency, customer impact, and alert thresholds must be validated using real telemetry; this assessment contains no production incident history.

### Reviewer handoff instructions

1. Open the project root and read [intent.md](./intent.md) for prioritization, assumptions, and treatment of uncertainty.
2. Review [tests/settlement.spec.js](./tests/settlement.spec.js) for the 17 behavior scenarios and the faulty-reference expected-failure proof.
3. Review [fixtures/settlementFixtures.js](./fixtures/settlementFixtures.js) for deterministic test setup and seeded scenario data.
4. Review [pages/SettlementServiceFacade.js](./pages/SettlementServiceFacade.js) for the test-facing API.
5. Review [src/settlementService.js](./src/settlementService.js) for the in-memory mock implementation and its limits.
6. From the root, run `npm test` and retain the command output (or CI run URL) with the submission. Confirm 17 behavior checks pass and the faulty reference is marked as an expected failure. The tests are the source of truth for the current run; do not treat a stale generated report as a substitute for rerunning.
7. Treat the result as assessment readiness only. Complete the listed production gaps and review them with the responsible engineering, finance, and operations owners before any production release.

### Completion criteria

- [x] Intent document ranks at least three risks by user impact, potential frequency, and effort, and justifies the primary risk.
- [x] Documentation distinguishes assumptions and test evidence from unverified incident history.
- [x] Directive documents scope, requirements, defect report, release gates, remaining gaps, and handoff steps.
- [ ] The corrected behavior checks pass and the faulty reference produces the expected failing assertion under `npm test`.
- [ ] Production release readiness: **not met by this assessment alone**; close the production gaps above.

## Results/Handoff Appendix

- **GitHub repository:** [Must_qa_quest_assessment](https://github.com/UmarAzamQureshi/Must_qa_quest_assessment)
- **Loom walkthrough:** [Watch the settlement QA walkthrough](https://www.loom.com/share/2de7dc4e1a7c4b8cbc82ac6f1486812c)
- **Playwright run / CI evidence:** The [settlement test suite](https://github.com/UmarAzamQureshi/Must_qa_quest_assessment/blob/3dc9c19c53e120e6af0a1bcad89b9e143e41a605/tests/settlement.spec.js) includes the faulty-reference expected failure and corrected replay check. No CI run or raw output for this revision is attached yet; run `npm test` on the final revision and add its actual output or CI link.
- **Submission commit / revision:** [Current published baseline: `3dc9c19c53e120e6af0a1bcad89b9e143e41a605`](https://github.com/UmarAzamQureshi/Must_qa_quest_assessment/commit/3dc9c19c53e120e6af0a1bcad89b9e143e41a605). Replace this with the final submission revision after the completed handoff is published.

> Decision: **ASSESSMENT HANDOFF PENDING FINAL TEST EVIDENCE / NOT A PRODUCTION RELEASE.** The mock is not production-ready; run the documented suite on the final revision and attach the actual output before treating the assessment handoff as complete.
