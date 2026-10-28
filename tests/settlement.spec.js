const { test, expect } = require('../fixtures/settlementFixtures');
const { WEEKLY_REWARD_CREDITS, isWithinSettlementWindow } = require('../src/settlementService');

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test.describe('Rewards settlement dashboard', () => {
  test('happy path pays every valid task in the Monday-to-Monday window', async ({
    settlementDashboard,
    happyPathBatch,
    settlementRunAt,
  }) => {
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts).toHaveLength(happyPathBatch.length);
    expect(result.totalCredits).toBe(happyPathBatch.length * WEEKLY_REWARD_CREDITS);
    expect(result.totalCredits).toBe(30);
    expect(settlementDashboard.getCreditLedgerCount()).toBe(happyPathBatch.length);
    expect(settlementDashboard.getTotalCredits()).toBe(30);
    expect(settlementDashboard.getTaskState('happy-001').status).toBe('paid');
    expect(result.batchId).toBe(`settlement-${settlementRunAt}`);
    expect(result.settledAt).toBe(settlementRunAt);
    expect(result.payouts.every((payout) => (
      payout.credits === 10
      && payout.batchId === result.batchId
      && payout.settledAt === settlementRunAt
    ))).toBe(true);
    expect(settlementDashboard.getCreditLedger()).toEqual(
      happyPathBatch.map(({ taskId, userId, submittedAt }) => ({
        taskId,
        userId,
        submittedAt,
        settlementRunAt,
        batchId: result.batchId,
        settledAt: settlementRunAt,
        credits: WEEKLY_REWARD_CREDITS,
        status: 'paid',
      })),
    );
    expect(settlementDashboard.getTaskStates().map(({ status }) => status)).toEqual([
      'paid',
      'paid',
      'paid',
    ]);

    const taskSnapshot = settlementDashboard.getTaskState('happy-001');
    const ledgerSnapshot = settlementDashboard.getCreditLedger();
    taskSnapshot.status = 'corrupted';
    ledgerSnapshot[0].credits = 999;
    expect(settlementDashboard.getTaskState('happy-001').status).toBe('paid');
    expect(settlementDashboard.getCreditLedger()[0].credits).toBe(10);
  });

  test('lower cut-off includes a task submitted exactly at Monday 00:00:00 UTC', async ({
    settlementDashboard,
    cutOffBoundaryBatch,
    settlementRunAt,
  }) => {
    expect(cutOffBoundaryBatch[0].submittedAt).toBe('2024-01-08T00:00:00.000Z');

    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts.map(({ taskId }) => taskId)).toContain('lower-boundary');
    expect(settlementDashboard.getTaskState('lower-boundary').status).toBe('paid');
  });

  test('upper cut-off includes the instant after Monday 00:00 UTC and excludes the next Monday', async ({
    settlementDashboard,
    cutOffBoundaryBatch,
    settlementRunAt,
  }) => {
    expect(cutOffBoundaryBatch[1].submittedAt).toBe('2024-01-08T00:00:00.001Z');
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts.map(({ taskId }) => taskId)).toContain('upper-boundary');
    expect(result.payouts.map(({ taskId }) => taskId)).not.toContain('next-week');
    expect(settlementDashboard.getTaskState('next-week').status).toBe('rejected');
  });

  test('timezone offsets are converted to UTC before applying the weekly window', async ({
    settlementDashboard,
    settlementRunAt,
    timezoneBatch,
  }) => {
    const withinUtcWindow = '2024-01-07T19:00:00-05:00'; // Monday 00:00 UTC
    const beforeUtcWindow = '2024-01-07T18:59:59.999-05:00';

    expect(timezoneBatch).toHaveLength(2);
    expect(isWithinSettlementWindow(withinUtcWindow, settlementRunAt)).toBe(true);
    expect(isWithinSettlementWindow(beforeUtcWindow, settlementRunAt)).toBe(false);
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts.map(({ taskId }) => taskId)).toEqual(['timezone-valid']);
    expect(settlementDashboard.getTaskState('timezone-invalid').status).toBe('rejected');
  });

  test('duplicate task IDs in one seeded batch result in only one credit payout', async ({
    settlementDashboard,
    duplicateBatch,
    settlementRunAt,
  }) => {
    expect(duplicateBatch).toHaveLength(2);
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(settlementDashboard.getCreditLedgerCount()).toBe(1);
    expect(settlementDashboard.getTotalCredits()).toBe(WEEKLY_REWARD_CREDITS);
    expect(result.totalCredits).toBe(10);
    expect(result.payouts[0]).toEqual({
      taskId: 'duplicate-001',
      userId: 'user-1',
      submittedAt: '2024-01-08T10:00:00.000Z',
      settlementRunAt: settlementRunAt,
      batchId: `settlement-${settlementRunAt}`,
      settledAt: settlementRunAt,
      credits: 10,
      status: 'paid',
    });
    expect(result.duplicates).toEqual([{ taskId: 'duplicate-001' }]);
    expect(settlementDashboard.getCreditLedger()).toEqual(result.payouts);
    expect(settlementDashboard.getTaskStates().map(({ status }) => status)).toEqual([
      'paid',
      'duplicate',
    ]);
  });

  test('retrying a settlement after a simulated network retry does not pay a task twice', async ({
    settlementDashboard,
    settlementRunAt,
    retryBatch,
  }) => {
    const firstAttempt = await settlementDashboard.triggerSettlement(settlementRunAt);
    const retriedAttempt = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(firstAttempt.payouts).toHaveLength(1);
    expect(retriedAttempt.payouts).toHaveLength(0);
    expect(retriedAttempt.duplicates).toHaveLength(1);
    expect(settlementDashboard.getCreditLedgerCount()).toBe(1);
    expect(settlementDashboard.getTotalCredits()).toBe(WEEKLY_REWARD_CREDITS);
    expect(firstAttempt.totalCredits).toBe(10);
    expect(retriedAttempt.totalCredits).toBe(0);
    expect(settlementDashboard.getCreditLedger()).toEqual(firstAttempt.payouts);
    expect(settlementDashboard.getTaskState(retryBatch[0].taskId).status).toBe('paid');
  });

  test('faulty reference: replay creates a duplicate payout (regression assertion fails)', async ({
    retryBatch,
  }) => {
    test.fail(true, 'This intentionally faulty reference has no idempotency guard');

    const faultyLedger = [];
    const faultySettle = async (task) => {
      const payout = {
        taskId: task.taskId,
        credits: WEEKLY_REWARD_CREDITS,
        status: 'paid',
      };
      faultyLedger.push(payout);
      return payout;
    };

    await faultySettle(retryBatch[0]);
    await faultySettle(retryBatch[0]);

    expect(faultyLedger.filter(({ taskId }) => taskId === retryBatch[0].taskId)).toHaveLength(1);
  });

  test('notification failure does not reverse the successful credit payout', async ({
    settlementService,
    settlementDashboard,
    settlementRunAt,
    notificationFailureBatch,
  }) => {
    settlementService.notificationHandler = async () => {
      throw new Error('notification transport unavailable');
    };
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toEqual({
      taskId: 'notification-failure',
      status: 'failed',
      error: 'notification transport unavailable',
    });
    expect(settlementDashboard.getTaskState('notification-failure').status).toBe('paid');
    expect(settlementDashboard.getCreditLedgerCount()).toBe(1);
    expect(settlementDashboard.getTotalCredits()).toBe(WEEKLY_REWARD_CREDITS);
    expect(result.payouts[0]).toMatchObject({
      taskId: notificationFailureBatch[0].taskId,
      batchId: result.batchId,
      settledAt: settlementRunAt,
      credits: 10,
      status: 'paid',
    });
    expect(settlementDashboard.getCreditLedger()).toEqual(result.payouts);
  });

  test('admin malformed payloads are rejected without interrupting valid tasks', async ({
    settlementDashboard,
    settlementRunAt,
    malformedBatch,
  }) => {
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(malformedBatch).toHaveLength(3);
    expect(result.payouts).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected).toEqual([
      { taskId: null, reason: 'missing taskId or submittedAt', code: 'INVALID_TASK' },
      {
        taskId: null,
        reason: 'missing taskId or submittedAt',
        code: 'INVALID_TASK',
      },
    ]);
    expect(settlementDashboard.getTotalCredits()).toBe(WEEKLY_REWARD_CREDITS);
    expect(result.totalCredits).toBe(10);
    expect(result.payouts[0].credits).toBe(WEEKLY_REWARD_CREDITS);
  });

  test('Test Case 13: invalid settlement schedule returns an exact error with no partial credits', async ({
    settlementDashboard,
    invalidScheduleBatch,
  }) => {
    await expect(
      settlementDashboard.triggerSettlement('2024-01-09T08:59:00.000Z'),
    ).rejects.toMatchObject({
      name: 'RangeError',
      code: 'INVALID_SETTLEMENT_SCHEDULE',
      message: 'settlement runs weekly on Tuesday at 09:00 UTC',
    });
    expect(settlementDashboard.getCreditLedgerCount()).toBe(0);
    expect(settlementDashboard.getTotalCredits()).toBe(0);
    expect(settlementDashboard.getTaskState(invalidScheduleBatch[0].taskId).status).toBe('pending');
  });

  test('Test Case 9: concurrent identical batches return a conflict without double-crediting', async ({
    settlementService,
    settlementDashboard,
    settlementRunAt,
    concurrentBatch,
  }) => {
    const notificationIntercepted = createDeferred();
    const releaseNotification = createDeferred();
    settlementService.notificationHandler = async () => {
      notificationIntercepted.resolve();
      await releaseNotification.promise;
      return { delivered: true };
    };

    const firstAttempt = settlementDashboard.triggerSettlement(settlementRunAt, { batchId: 'race-batch' });
    await notificationIntercepted.promise;
    await expect(
      settlementDashboard.triggerSettlement(settlementRunAt, { batchId: 'race-batch' }),
    ).rejects.toMatchObject({
      name: 'RangeError',
      code: 'SETTLEMENT_CONFLICT',
      message: 'A settlement batch is already in progress',
    });
    releaseNotification.resolve();
    const result = await firstAttempt;

    expect(concurrentBatch).toHaveLength(1);
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].credits).toBe(10);
    expect(settlementDashboard.getCreditLedgerCount()).toBe(1);
    expect(settlementDashboard.getTotalCredits()).toBe(10);
    expect(settlementDashboard.getCreditLedger()).toEqual(result.payouts);
  });

  test('Test Case 10: large batches are processed in bounded chunks with exact ledger totals', async ({
    settlementDashboard,
    settlementRunAt,
    largeBatch,
  }) => {
    const taskCount = largeBatch.length;

    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts).toHaveLength(taskCount);
    expect(result.totalCredits).toBe(taskCount * WEEKLY_REWARD_CREDITS);
    expect(result.processing).toEqual({
      taskCount,
      chunkCount: Math.ceil(taskCount / 500),
      maxChunkSize: 500,
    });
    expect(settlementDashboard.getCreditLedgerCount()).toBe(taskCount);
    expect(settlementDashboard.getTotalCredits()).toBe(100_010);
    expect(settlementDashboard.getCreditLedgerEntry('large-10000').credits).toBe(10);
  });

  test('Test Case 11: previously PAID tasks are rejected without another ledger entry', async ({
    settlementDashboard,
    settlementRunAt,
    previouslyPaidBatch,
  }) => {
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts).toHaveLength(0);
    expect(result.rejected).toEqual([{
      taskId: 'already-paid-task',
      reason: 'task is already paid',
      code: 'TASK_ALREADY_PAID',
    }]);
    expect(settlementDashboard.getTaskState(previouslyPaidBatch[0].taskId).status).toBe('PAID');
    expect(settlementDashboard.getCreditLedgerCount()).toBe(0);
    expect(settlementDashboard.getTotalCredits()).toBe(0);
  });

  test('Test Case 12: HTTP 500 notification outage does not roll back committed credits', async ({
    settlementService,
    settlementDashboard,
    settlementRunAt,
    http500NotificationBatch,
  }) => {
    settlementService.notificationHandler = async () => ({ status: 500, body: 'notification outage' });

    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.notifications).toEqual([{
      taskId: 'http-500-notification',
      status: 'failed',
      error: 'notification service returned HTTP 500',
    }]);
    expect(result.payouts).toHaveLength(1);
    expect(result.totalCredits).toBe(10);
    expect(settlementDashboard.getTaskState('http-500-notification').status).toBe('paid');
    expect(settlementDashboard.getCreditLedgerCount()).toBe(1);
    expect(settlementDashboard.getTotalCredits()).toBe(10);
    expect(result.payouts[0]).toMatchObject({
      taskId: http500NotificationBatch[0].taskId,
      batchId: result.batchId,
      settledAt: settlementRunAt,
      credits: 10,
      status: 'paid',
    });
    expect(settlementDashboard.getCreditLedger()).toEqual(result.payouts);
  });

  test('Test Case 14: poison-pill item errors are isolated from valid task payouts', async ({
    settlementService,
    settlementDashboard,
    settlementRunAt,
    poisonPillBatch,
  }) => {
    settlementService.taskSettlementHook = async (task) => {
      if (task.taskId === 'poison-pill') {
        throw new Error('simulated database constraint failure');
      }
    };
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts.map(({ taskId }) => taskId)).toEqual([
      'valid-before-poison',
      'valid-after-poison',
    ]);
    expect(result.rejected).toContainEqual({
      taskId: 'poison-pill',
      reason: 'task processing failed',
      code: 'ITEM_PROCESSING_FAILED',
      message: 'simulated database constraint failure',
    });
    expect(result.itemErrors).toEqual([{
      taskId: 'poison-pill',
      code: 'ITEM_PROCESSING_FAILED',
      message: 'simulated database constraint failure',
    }]);
    expect(settlementDashboard.getTaskState('poison-pill')).toMatchObject({
      status: 'rejected',
      errorCode: 'ITEM_PROCESSING_FAILED',
    });
    expect(settlementDashboard.getCreditLedgerEntry('poison-pill')).toBeNull();
    expect(settlementDashboard.getCreditLedgerCount()).toBe(2);
    expect(result.totalCredits).toBe(20);
    expect(settlementDashboard.getTotalCreditsBigInt()).toBe(20n);
    expect(poisonPillBatch).toHaveLength(3);
    expect(settlementDashboard.getCreditLedger().map((entry) => ({
      taskId: entry.taskId,
      batchId: entry.batchId,
      settledAt: entry.settledAt,
      credits: entry.credits,
      status: entry.status,
    }))).toEqual([
      {
        taskId: 'valid-before-poison',
        batchId: result.batchId,
        settledAt: settlementRunAt,
        credits: 10,
        status: 'paid',
      },
      {
        taskId: 'valid-after-poison',
        batchId: result.batchId,
        settledAt: settlementRunAt,
        credits: 10,
        status: 'paid',
      },
    ]);
    expect(settlementDashboard.getTaskStates().map(({ taskId, status }) => [taskId, status]))
      .toEqual([
        ['valid-before-poison', 'paid'],
        ['poison-pill', 'rejected'],
        ['valid-after-poison', 'paid'],
      ]);
  });

  test('Test Case 15: fractional reward amounts are rejected and integer totals remain exact', async ({
    settlementDashboard,
    settlementRunAt,
    fractionalRewardsBatch,
  }) => {
    const result = await settlementDashboard.triggerSettlement(settlementRunAt);

    expect(result.payouts.map(({ taskId, credits }) => [taskId, credits])).toEqual([
      ['integer-reward-10', 10],
      ['integer-reward-20', 20],
    ]);
    expect(result.rejected).toEqual([
      {
        taskId: 'fractional-reward-0-1',
        reason: 'rewardCredits must be a positive safe integer',
        code: 'INVALID_REWARD_AMOUNT',
      },
      {
        taskId: 'fractional-reward-0-2',
        reason: 'rewardCredits must be a positive safe integer',
        code: 'INVALID_REWARD_AMOUNT',
      },
    ]);
    expect(result.totalCredits).toBe(30);
    expect(settlementDashboard.getTotalCredits()).toBe(30);
    expect(settlementDashboard.getTotalCreditsBigInt()).toBe(30n);
    expect(settlementDashboard.getCreditLedger().every(
      ({ credits }) => Number.isSafeInteger(credits) && credits > 0,
    )).toBe(true);
    expect(settlementDashboard.getCreditLedgerEntry('fractional-reward-0-1')).toBeNull();
    expect(settlementDashboard.getCreditLedgerEntry('fractional-reward-0-2')).toBeNull();
    expect(fractionalRewardsBatch).toHaveLength(4);
    expect(settlementDashboard.getCreditLedger().map(({ taskId, batchId, settledAt, credits }) => ({
      taskId,
      batchId,
      settledAt,
      credits,
    }))).toEqual([
      {
        taskId: 'integer-reward-10',
        batchId: result.batchId,
        settledAt: settlementRunAt,
        credits: 10,
      },
      {
        taskId: 'integer-reward-20',
        batchId: result.batchId,
        settledAt: settlementRunAt,
        credits: 20,
      },
    ]);
  });

  test('Test Case 16: deadlock retries roll back provisional writes and preserve ledger integrity', async ({
    settlementService,
    settlementDashboard,
    settlementRunAt,
    deadlockRetriesBatch,
  }) => {
    const writeAttempts = new Map();
    settlementService.payoutWriteHook = async ({ task, attempt }) => {
      const attempts = (writeAttempts.get(task.taskId) || 0) + 1;
      writeAttempts.set(task.taskId, attempts);
      if (task.taskId === 'deadlock-retry-task' && attempt < 3) {
        const error = new Error('simulated serialization failure');
        error.code = '40001';
        throw error;
      }
      if (task.taskId === 'permanent-write-failure') {
        const error = new Error('simulated ledger constraint violation');
        error.code = '23514';
        throw error;
      }
    };
    const result = await settlementDashboard.triggerSettlement(settlementRunAt, {
      batchId: 'deadlock-retry-batch',
    });

    expect(writeAttempts.get('deadlock-retry-task')).toBe(3);
    expect(writeAttempts.get('permanent-write-failure')).toBe(1);
    expect(result.payouts.map(({ taskId }) => taskId)).toEqual([
      'valid-before-deadlock',
      'deadlock-retry-task',
      'valid-after-failure',
    ]);
    expect(result.rejected).toContainEqual({
      taskId: 'permanent-write-failure',
      reason: 'task processing failed',
      code: 'ITEM_PROCESSING_FAILED',
      message: 'simulated ledger constraint violation',
    });
    expect(settlementDashboard.getCreditLedgerEntry('permanent-write-failure')).toBeNull();
    expect(settlementDashboard.getCreditLedgerCount()).toBe(3);
    expect(settlementDashboard.getTotalCredits()).toBe(30);
    expect(settlementDashboard.getTotalCreditsBigInt()).toBe(30n);
    expect(deadlockRetriesBatch).toHaveLength(4);
    expect(settlementDashboard.getTaskStates().map(({ taskId, status }) => [taskId, status]))
      .toEqual([
        ['valid-before-deadlock', 'paid'],
        ['deadlock-retry-task', 'paid'],
        ['permanent-write-failure', 'rejected'],
        ['valid-after-failure', 'paid'],
      ]);
  });

  test('Test Case 17: interrupted chunk processing resumes from its cursor without duplicate payouts', async ({
    smallChunkSettlementService,
    smallChunkSettlementDashboard,
    settlementRunAt,
    resumableBatch,
    cursorFingerprintMutation,
  }) => {
    const taskCount = resumableBatch.length;
    let interruptionInjected = false;
    smallChunkSettlementService.chunkProcessingHook = async ({ chunkNumber }) => {
      if (chunkNumber === 3 && !interruptionInjected) {
        interruptionInjected = true;
        throw new Error('simulated interruption in chunk 3');
      }
    };
    await expect(
      smallChunkSettlementDashboard.triggerSettlement(settlementRunAt, {
        batchId: 'resumable-large-batch',
      }),
    ).rejects.toThrow('simulated interruption in chunk 3');
    expect(smallChunkSettlementDashboard.getCreditLedgerCount()).toBe(20);
    expect(smallChunkSettlementDashboard.getTotalCredits()).toBe(200);
    expect(smallChunkSettlementDashboard.getSettlementCursor('resumable-large-batch')).toMatchObject({
      nextIndex: 20,
      status: 'in_progress',
      chunksCommitted: 2,
    });

    const resumed = await smallChunkSettlementDashboard.triggerSettlement(settlementRunAt, {
      batchId: 'resumable-large-batch',
    });

    expect(resumed.payouts).toHaveLength(30);
    expect(resumed.payouts.map(({ taskId }) => taskId)).toEqual(
      Array.from({ length: 30 }, (_, index) => `resume-${index + 20}`),
    );
    expect(resumed.duplicates).toHaveLength(0);
    expect(smallChunkSettlementDashboard.getCreditLedgerCount()).toBe(taskCount);
    expect(smallChunkSettlementDashboard.getTotalCredits()).toBe(500);
    expect(smallChunkSettlementDashboard.getTotalCreditsBigInt()).toBe(500n);
    expect(smallChunkSettlementDashboard.getSettlementCursor('resumable-large-batch')).toMatchObject({
      nextIndex: taskCount,
      status: 'completed',
      chunksCommitted: 5,
    });
    expect(new Set(smallChunkSettlementDashboard.getCreditLedger().map(({ taskId }) => taskId)).size)
      .toBe(taskCount);
    expect(resumed.payouts.map(({ taskId, batchId, settledAt, credits, status }) => ({
      taskId,
      batchId,
      settledAt,
      credits,
      status,
    }))).toEqual(Array.from({ length: 30 }, (_, index) => ({
      taskId: `resume-${index + 20}`,
      batchId: 'resumable-large-batch',
      settledAt: settlementRunAt,
      credits: 10,
      status: 'paid',
    })));
    expect(smallChunkSettlementDashboard.getTaskStates().map(({ status }) => status))
      .toEqual(Array(taskCount).fill('paid'));
    expect(smallChunkSettlementDashboard.getCreditLedger().map(({
      taskId,
      batchId,
      settledAt,
      credits,
      status,
    }) => ({
      taskId,
      batchId,
      settledAt,
      credits,
      status,
    }))).toEqual(Array.from({ length: taskCount }, (_, index) => ({
      taskId: `resume-${index}`,
      batchId: 'resumable-large-batch',
      settledAt: settlementRunAt,
      credits: 10,
      status: 'paid',
    })));

    cursorFingerprintMutation();
    await expect(
      smallChunkSettlementDashboard.triggerSettlement(settlementRunAt, {
        batchId: 'resumable-large-batch',
      }),
    ).rejects.toMatchObject({
      name: 'RangeError',
      code: 'SETTLEMENT_CURSOR_MISMATCH',
    });
    expect(smallChunkSettlementDashboard.getCreditLedgerCount()).toBe(taskCount);
  });
});
