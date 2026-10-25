const { test: base, expect } = require('@playwright/test');
const { SettlementServiceFacade } = require('../pages/SettlementServiceFacade');
const { SettlementService } = require('../src/settlementService');

const SETTLEMENT_RUN_AT = '2024-01-09T09:00:00.000Z';

function task(taskId, submittedAt, extra = {}) {
  return { taskId, userId: 'user-1', submittedAt, ...extra };
}

const batches = {
  happyPath: [
    task('happy-001', '2024-01-08T08:00:00.000Z'),
    task('happy-002', '2024-01-08T12:00:00.000Z'),
    task('happy-003', '2024-01-08T23:59:59.999Z'),
  ],
  cutOffBoundaries: [
    task('lower-boundary', '2024-01-08T00:00:00.000Z'),
    task('upper-boundary', '2024-01-08T00:00:00.001Z'),
    task('next-week', '2024-01-15T00:00:00.000Z'),
  ],
  timezone: [
    task('timezone-valid', '2024-01-07T19:00:00-05:00'),
    task('timezone-invalid', '2024-01-07T18:59:59.999-05:00'),
  ],
  duplicates: [
    task('duplicate-001', '2024-01-08T10:00:00.000Z'),
    task('duplicate-001', '2024-01-08T10:00:00.000Z'),
  ],
  retry: [task('retry-task', '2024-01-08T09:00:00.000Z')],
  notificationFailure: [task('notification-failure', '2024-01-08T09:00:00.000Z')],
  malformed: [
    {},
    task('valid-admin-task', '2024-01-08T11:00:00.000Z', { userId: 'user-2' }),
    { userId: 'missing-task-id', submittedAt: '2024-01-08T12:00:00.000Z' },
  ],
  invalidSchedule: [task('not-paid-on-invalid-run', '2024-01-08T09:00:00.000Z')],
  concurrent: [task('race-task', '2024-01-08T09:00:00.000Z')],
  large: Array.from({ length: 10_001 }, (_, index) => (
    task(`large-${index}`, '2024-01-08T12:00:00.000Z', { userId: `user-${index % 100}` })
  )),
  previouslyPaid: [
    task('already-paid-task', '2024-01-08T09:00:00.000Z', {
      status: 'PAID',
      credits: 10,
    }),
  ],
  http500Notification: [task('http-500-notification', '2024-01-08T09:00:00.000Z')],
  poisonPill: [
    task('valid-before-poison', '2024-01-08T09:00:00.000Z'),
    task('poison-pill', '2024-01-08T10:00:00.000Z'),
    task('valid-after-poison', '2024-01-08T11:00:00.000Z'),
  ],
  fractionalRewards: [
    task('integer-reward-10', '2024-01-08T09:00:00.000Z', { rewardCredits: 10 }),
    task('fractional-reward-0-1', '2024-01-08T10:00:00.000Z', { rewardCredits: 0.1 }),
    task('integer-reward-20', '2024-01-08T11:00:00.000Z', { rewardCredits: 20 }),
    task('fractional-reward-0-2', '2024-01-08T12:00:00.000Z', { rewardCredits: 0.2 }),
  ],
  deadlockRetries: [
    task('valid-before-deadlock', '2024-01-08T09:00:00.000Z'),
    task('deadlock-retry-task', '2024-01-08T10:00:00.000Z'),
    task('permanent-write-failure', '2024-01-08T11:00:00.000Z'),
    task('valid-after-failure', '2024-01-08T12:00:00.000Z'),
  ],
  resumable: Array.from({ length: 50 }, (_, index) => (
    task(`resume-${index}`, '2024-01-08T12:00:00.000Z')
  )),
};

function seededBatch(batchName) {
  return async ({ settlementService }, use) => {
    const seededTasks = structuredClone(batches[batchName]);
    settlementService.seedTasks(seededTasks);
    await use(seededTasks);
  };
}

async function seededSmallChunkBatch({ smallChunkSettlementService }, use) {
  const seededTasks = structuredClone(batches.resumable);
  smallChunkSettlementService.seedTasks(seededTasks);
  await use(seededTasks);
}

const test = base.extend({
  settlementService: async ({}, use) => {
    await use(new SettlementService());
  },
  smallChunkSettlementService: async ({}, use) => {
    await use(new SettlementService({ chunkSize: 10 }));
  },
  settlementDashboard: async ({ settlementService }, use) => {
    await use(new SettlementServiceFacade(settlementService));
  },
  smallChunkSettlementDashboard: async ({ smallChunkSettlementService }, use) => {
    await use(new SettlementServiceFacade(smallChunkSettlementService));
  },
  settlementRunAt: async ({}, use) => {
    await use(SETTLEMENT_RUN_AT);
  },
  happyPathBatch: seededBatch('happyPath'),
  cutOffBoundaryBatch: seededBatch('cutOffBoundaries'),
  timezoneBatch: seededBatch('timezone'),
  duplicateBatch: seededBatch('duplicates'),
  retryBatch: seededBatch('retry'),
  notificationFailureBatch: seededBatch('notificationFailure'),
  malformedBatch: seededBatch('malformed'),
  invalidScheduleBatch: seededBatch('invalidSchedule'),
  concurrentBatch: seededBatch('concurrent'),
  largeBatch: seededBatch('large'),
  previouslyPaidBatch: seededBatch('previouslyPaid'),
  http500NotificationBatch: seededBatch('http500Notification'),
  poisonPillBatch: seededBatch('poisonPill'),
  fractionalRewardsBatch: seededBatch('fractionalRewards'),
  deadlockRetriesBatch: seededBatch('deadlockRetries'),
  resumableBatch: seededSmallChunkBatch,
  cursorFingerprintMutation: async ({ smallChunkSettlementService }, use) => {
    await use(() => {
      smallChunkSettlementService.tasks[0].taskId = 'resume-changed-after-completion';
    });
  },
});

module.exports = { test, expect, SETTLEMENT_RUN_AT };
