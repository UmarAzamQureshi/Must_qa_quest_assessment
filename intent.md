# MUST Company Quest Assessment — Settlement Test Intent

## Problem context

The rewards settlement service processes contributor tasks into weekly credit payouts. Under the assessment assumptions, a settlement runs every Tuesday at 09:00 UTC, covers tasks submitted from Monday 00:00 UTC inclusive to the following Monday 00:00 UTC exclusive, and awards a positive whole-number credit amount per eligible task (10 credits by default).

Settlement correctness affects contributor balances, financial reconciliation, and confidence in the rewards program. The main quality risks are duplicate credits during retries, inconsistent eligibility around time-zone boundaries, and failures in notification delivery being confused with failures in payout processing.

This repository is an in-memory JavaScript assessment harness. Its tests validate expected behavior in the mock service; they do not establish that a production payment system has experienced any particular incident or that the mock's guarantees hold across processes, durable storage, or external providers.

## Ranked potential failure problems

The rankings below are risk assessments for prioritizing test and design work, not measurements of production incidents. Frequency estimates are qualitative and should be updated with operational data when such data becomes available.

| Rank | Failure problem | User impact | Potential frequency | Relative remediation effort | Priority rationale |
|---|---|---|---|---|---|
| 1 | **Duplicate Payouts & Retry Idempotency** — a replay, client retry, queue redelivery, or concurrent request credits the same task more than once | **Critical.** Incorrect balances directly affect contributor compensation, create financial exposure, and require reconciliation or recovery | **Medium to high potential.** Retries and redeliveries are normal distributed-system behavior; actual incidence is unknown | **Medium to high.** Requires a stable idempotency identity, atomic ledger writes, and concurrency-safe persistence in production | Highest priority because one repeated task can create an unauthorized credit, and retries can multiply the effect at scale |
| 2 | **Cut-off Boundary Drifts** — timestamps near the Monday boundary are evaluated using local time, inconsistent parsing, or the wrong inclusive/exclusive rule | **High.** Eligible work may be missed or ineligible work paid, causing unfairness and audit discrepancies | **Medium potential.** Risk is concentrated around weekly boundaries and clients using different offsets; measured rate is unknown | **Low to medium.** Explicit UTC normalization, a defined half-open interval, and boundary tests address the logic; production data contracts may add effort | Affects fairness and settlement correctness but is bounded to tasks near the window edges |
| 3 | **Notification Delivery Failures** — notification errors are treated as payout failures, or a committed payout is reversed because a notice was not delivered | **Medium to high.** Contributors may receive incorrect status information or lose visibility into a successful payout | **Medium potential.** Delivery failures are expected in distributed integrations; actual frequency is unknown | **Medium.** Separate payout state from notification state; production-grade retries and durable delivery may require an outbox and monitoring | Important for trust and operational support, but notification delivery should not determine whether a credit was committed |

### Ranking terms

- **User impact** describes the plausible consequence if the failure occurs, not a claim that it has occurred.
- **Potential frequency** is a qualitative estimate based on the workflow's exposure to retries, time-zone variation, and external service failures. No production telemetry was supplied.
- **Relative remediation effort** estimates implementation and verification complexity. Production storage, payment-provider, and deployment details are not present in this assessment package.

## Primary risk selected: Duplicate Payouts & Retry Idempotency

We selected duplicate payout prevention as the primary high-impact risk because it protects the integrity of the contributor credit ledger. A repeated credit is not merely a display defect: it changes a financial-like balance, can trigger downstream redemption or accounting consequences, and may be difficult to reverse cleanly after settlement. The impact can scale with both the number of retried tasks and the number of replayed batches.

Retries are a normal consequence of uncertain network outcomes. A client may time out after the service has committed a payout and retry because it cannot tell whether the first request succeeded. A queue may redeliver a message after a worker has completed the work but before acknowledging it. Two workers may also race to process the same item. Without a durable idempotency boundary, each delivery can appear to be a new instruction.

For those reasons, this risk takes precedence over cut-off drift and notification delivery:

1. A duplicate credit can create direct balance inflation, while a boundary error is generally limited to tasks near a weekly cut-off.
2. Retry and redelivery paths are intrinsic to distributed systems, so protection must be designed into the commit boundary rather than relying on callers to avoid retries.
3. Notification delivery is a separate side effect and should not control the authoritative ledger result.
4. Correctness can be expressed and regression-tested precisely: settle once, replay, and verify that ledger count and total credits do not increase.

The current assessment tests exercise duplicate IDs in one batch, replay after settlement, and concurrent requests. The mock service uses an in-memory ledger and cursor; these tests demonstrate the intended behavior of this harness only. Production idempotency must be enforced by durable, concurrency-safe storage.

## Operational uncertainty and evidence discipline

No incident report, production trace, database record, customer complaint, or pre-fix build was supplied as evidence. Accordingly, this document does **not** claim that a duplicate payout, boundary error, or notification rollback occurred in production or that a specific historical defect was observed.

We handle that uncertainty by:

- describing the three issues as potential failure modes and ranking their plausible impact;
- separating assessment assumptions from verified implementation behavior;
- using deterministic regression tests to verify the expected behavior of the current mock;
- reporting test-run results as evidence of the current test suite, not evidence of production history;
- identifying production controls and operational telemetry that remain necessary before any real settlement release; and
- revisiting qualitative frequency and effort estimates when real traffic, retry, notification, and reconciliation data become available.

## Assessment assumptions

- Scheduled settlement occurs Tuesday at 09:00:00 UTC.
- The settlement window is `[Monday 00:00:00 UTC, following Monday 00:00:00 UTC)`.
- The default award is 10 credits per valid task; configured reward amounts must be positive safe integers.
- Task IDs identify payout units and must not be credited more than once.
- Retried, replayed, or concurrent requests must not create duplicate ledger entries.
- Notification delivery is downstream of payout commit and must not roll back committed credits.
- Malformed inputs and item-level processing errors should be reported without preventing unrelated valid tasks from being processed.
- The mock service and its in-memory state are assessment artifacts, not production payment infrastructure.

## Intended outcome

The assessment should show that settlement is idempotent in the harness, evaluates task timestamps as UTC instants, preserves the ledger when notifications fail, isolates malformed or failed items, and reports accurate balances under batching and recovery scenarios. Production readiness additionally requires durable transactional guarantees, integration-level verification, operational observability, and release controls described in [directive.md](./directive.md).
