const { createHash } = require('node:crypto');

const WEEKLY_REWARD_CREDITS = 10;
const SETTLEMENT_DAY_UTC = 2;
const SETTLEMENT_HOUR_UTC = 9;
const SETTLEMENT_MINUTE_UTC = 0;
const DEFAULT_CHUNK_SIZE = 500;

function settlementError(code, message, ErrorType = Error) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function stableStringify(value) {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintTaskInputs(taskInputs, tasks) {
  const currentTaskInputs = tasks.map(({
    taskId,
    userId,
    submittedAt,
    rewardCredits,
  }) => ({ taskId, userId, submittedAt, rewardCredits }));
  return createHash('sha256')
    .update(stableStringify({ taskInputs, currentTaskInputs }))
    .digest('hex');
}

function parseDate(value) {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMondayStartUtc(value) {
  const date = parseDate(value);
  if (!date) {
    return null;
  }

  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday;
}

function isWithinSettlementWindow(submittedAt, settlementRunAt) {
  const taskDate = parseDate(submittedAt);
  const runDate = parseDate(settlementRunAt);
  const windowStart = getMondayStartUtc(runDate);
  if (!taskDate || !runDate || !windowStart) {
    return false;
  }

  const windowEnd = new Date(windowStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);
  return taskDate.getTime() >= windowStart.getTime() && taskDate.getTime() < windowEnd.getTime();
}

function isScheduledSettlementTime(value) {
  const date = parseDate(value);
  return Boolean(
    date
    && date.getUTCDay() === SETTLEMENT_DAY_UTC
    && date.getUTCHours() === SETTLEMENT_HOUR_UTC
    && date.getUTCMinutes() === SETTLEMENT_MINUTE_UTC
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0,
  );
}

class SettlementService {
  constructor({
    notificationHandler = async () => ({ delivered: true }),
    chunkSize = DEFAULT_CHUNK_SIZE,
    taskSettlementHook = async () => {},
    payoutWriteHook = async () => {},
    chunkProcessingHook = async () => {},
    maxTransactionRetries = 3,
  } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new TypeError('chunkSize must be a positive integer');
    }
    if (!Number.isInteger(maxTransactionRetries) || maxTransactionRetries < 0) {
      throw new TypeError('maxTransactionRetries must be a non-negative integer');
    }
    this.notificationHandler = notificationHandler;
    this.chunkSize = chunkSize;
    this.taskSettlementHook = taskSettlementHook;
    this.payoutWriteHook = payoutWriteHook;
    this.chunkProcessingHook = chunkProcessingHook;
    this.maxTransactionRetries = maxTransactionRetries;
    this.tasks = [];
    this.taskInputs = [];
    this.ledger = new Map();
    this.cursors = new Map();
    this.settlementInProgress = false;
  }

  seedTasks(tasks) {
    if (!Array.isArray(tasks)) {
      throw new TypeError('tasks must be an array');
    }

    for (const task of tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new TypeError('each seeded task must be an object');
      }
      const taskInput = structuredClone(task);
      this.taskInputs.push(taskInput);
      this.tasks.push({ ...structuredClone(taskInput), status: task.status || 'pending' });
    }
  }

  async triggerSettlement(settlementRunAt, { batchId } = {}) {
    if (this.settlementInProgress) {
      throw settlementError(
        'SETTLEMENT_CONFLICT',
        'A settlement batch is already in progress',
        RangeError,
      );
    }

    const runDate = parseDate(settlementRunAt);
    if (!runDate) {
      throw settlementError(
        'INVALID_SETTLEMENT_TIMESTAMP',
        'settlementRunAt must be a valid date',
        TypeError,
      );
    }
    if (!isScheduledSettlementTime(runDate)) {
      throw settlementError(
        'INVALID_SETTLEMENT_SCHEDULE',
        'settlement runs weekly on Tuesday at 09:00 UTC',
        RangeError,
      );
    }
    const resolvedBatchId = batchId === undefined
      ? `settlement-${runDate.toISOString()}`
      : batchId;
    if (typeof resolvedBatchId !== 'string' || !resolvedBatchId.trim()) {
      throw settlementError('INVALID_BATCH_ID', 'batchId must be a non-empty string', TypeError);
    }

    this.settlementInProgress = true;
    const payouts = [];
    const rejected = [];
    const duplicates = [];
    const notifications = [];
    const itemErrors = [];
    const seenTaskIds = new Set();
    const ledgerCredits = this.getTotalCreditsBigInt();
    let batchCredits = 0n;
    let chunkCount = 0;
    let maxChunkSize = 0;

    try {
      const taskCount = this.tasks.length;
      const taskFingerprint = fingerprintTaskInputs(this.taskInputs, this.tasks);
      let cursor = this.cursors.get(resolvedBatchId);
      if (cursor && (
        cursor.settledAt !== runDate.toISOString()
        || cursor.taskCount !== taskCount
        || cursor.taskFingerprint !== taskFingerprint
      )) {
        throw settlementError(
          'SETTLEMENT_CURSOR_MISMATCH',
          'batchId is already associated with a different settlement or task input set',
          RangeError,
        );
      }
      if (!cursor) {
        cursor = {
          batchId: resolvedBatchId,
          settledAt: runDate.toISOString(),
          taskCount,
          taskFingerprint,
          nextIndex: 0,
          status: 'in_progress',
          chunksCommitted: 0,
        };
        this.cursors.set(resolvedBatchId, cursor);
      }
      if (cursor.status === 'completed') {
        for (const task of this.tasks) {
          if (task.taskId && this.ledger.has(task.taskId)) {
            duplicates.push({ taskId: task.taskId });
          }
        }
      }

      for (let offset = cursor.nextIndex; offset < taskCount; offset += this.chunkSize) {
        const end = Math.min(offset + this.chunkSize, taskCount);
        chunkCount += 1;
        maxChunkSize = Math.max(maxChunkSize, end - offset);
        await this.chunkProcessingHook({
          batchId: resolvedBatchId,
          chunkNumber: Math.floor(offset / this.chunkSize) + 1,
          startIndex: offset,
          endIndex: end,
        });

        for (let index = offset; index < end; index += 1) {
          const task = this.tasks[index];
          try {
            if (typeof task.taskId !== 'string' || !task.taskId.trim() || !task.submittedAt) {
              const result = {
                taskId: task.taskId || null,
                reason: 'missing taskId or submittedAt',
                code: 'INVALID_TASK',
              };
              rejected.push(result);
              this.tasks[index] = { ...task, status: 'rejected', rejectionReason: result.reason };
              continue;
            }

            if (seenTaskIds.has(task.taskId)) {
              duplicates.push({ taskId: task.taskId });
              this.tasks[index] = { ...task, status: 'duplicate' };
              continue;
            }
            if (this.ledger.has(task.taskId)) {
              duplicates.push({ taskId: task.taskId });
              seenTaskIds.add(task.taskId);
              continue;
            }
            if (String(task.status).toLowerCase() === 'paid') {
              const reason = 'task is already paid';
              rejected.push({ taskId: task.taskId, reason, code: 'TASK_ALREADY_PAID' });
              continue;
            }
            seenTaskIds.add(task.taskId);

            if (!isWithinSettlementWindow(task.submittedAt, runDate)) {
              const reason = 'task is outside the settlement window';
              rejected.push({ taskId: task.taskId, reason, code: 'OUTSIDE_SETTLEMENT_WINDOW' });
              this.tasks[index] = { ...task, status: 'rejected', rejectionReason: reason };
              continue;
            }

            await this.taskSettlementHook(task);
            const credits = task.rewardCredits === undefined
              ? WEEKLY_REWARD_CREDITS
              : task.rewardCredits;
            if (!Number.isSafeInteger(credits) || credits <= 0) {
              const reason = 'rewardCredits must be a positive safe integer';
              rejected.push({
                taskId: task.taskId,
                reason,
                code: 'INVALID_REWARD_AMOUNT',
              });
              this.tasks[index] = {
                ...task,
                status: 'rejected',
                rejectionReason: reason,
                errorCode: 'INVALID_REWARD_AMOUNT',
              };
              continue;
            }
            const creditAmount = BigInt(credits);
            if (ledgerCredits + batchCredits + creditAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
              const reason = 'total credits would exceed the safe integer range';
              rejected.push({
                taskId: task.taskId,
                reason,
                code: 'TOTAL_CREDITS_OVERFLOW',
              });
              this.tasks[index] = {
                ...task,
                status: 'rejected',
                rejectionReason: reason,
                errorCode: 'TOTAL_CREDITS_OVERFLOW',
              };
              continue;
            }

            const submittedAt = parseDate(task.submittedAt);
            const payout = {
              taskId: task.taskId,
              userId: task.userId || 'unknown-user',
              submittedAt: submittedAt.toISOString(),
              settlementRunAt: runDate.toISOString(),
              batchId: resolvedBatchId,
              settledAt: runDate.toISOString(),
              credits,
              status: 'paid',
            };

            let committed = false;
            for (let attempt = 1; attempt <= this.maxTransactionRetries + 1; attempt += 1) {
              const previousTask = this.tasks[index];
              try {
                this.ledger.set(task.taskId, structuredClone(payout));
                batchCredits += creditAmount;
                this.tasks[index] = { ...task, status: 'paid', credits };
                await this.payoutWriteHook({
                  task,
                  payout,
                  attempt,
                  batchId: resolvedBatchId,
                });
                payouts.push(structuredClone(payout));
                committed = true;
                break;
              } catch (error) {
                this.ledger.delete(task.taskId);
                batchCredits -= creditAmount;
                this.tasks[index] = previousTask;
                const transient = error && (
                  error.transient === true
                  || ['40P01', '40001', 'DEADLOCK_DETECTED', 'SERIALIZATION_FAILURE']
                    .includes(error.code)
                );
                if (!transient || attempt > this.maxTransactionRetries) {
                  throw error;
                }
              }
            }
            if (!committed) {
              throw settlementError(
                'TRANSACTION_RETRY_EXHAUSTED',
                'payout transaction retry limit was exhausted',
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const itemError = {
              taskId: task.taskId || null,
              code: 'ITEM_PROCESSING_FAILED',
              message,
            };
            itemErrors.push(itemError);
            rejected.push({
              taskId: task.taskId || null,
              reason: 'task processing failed',
              code: itemError.code,
              message,
            });
            this.tasks[index] = {
              ...task,
              status: 'rejected',
              rejectionReason: 'task processing failed',
              errorCode: itemError.code,
            };
          }
        }
        cursor.nextIndex = end;
        cursor.chunksCommitted += 1;
        cursor.status = 'in_progress';
      }
      cursor.status = 'completed';

      for (const payout of payouts) {
        try {
          const result = await this.notificationHandler(payout);
          if (result && Number(result.status) >= 500) {
            notifications.push({
              taskId: payout.taskId,
              status: 'failed',
              error: `notification service returned HTTP ${result.status}`,
            });
          } else {
            notifications.push({ taskId: payout.taskId, status: 'sent', result });
          }
        } catch (error) {
          notifications.push({
            taskId: payout.taskId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        batchId: resolvedBatchId,
        settledAt: runDate.toISOString(),
        payouts,
        rejected,
        duplicates,
        itemErrors,
        notifications,
        processing: { taskCount, chunkCount, maxChunkSize },
        cursor: { ...cursor },
        totalCredits: Number(batchCredits),
        ledger: this.getLedger(),
      };
    } finally {
      this.settlementInProgress = false;
    }
  }

  getTaskState(taskId) {
    const task = this.tasks.find((item) => item.taskId === taskId);
    return task ? structuredClone(task) : null;
  }

  getTaskStates() {
    return structuredClone(this.tasks);
  }

  getLedger() {
    return structuredClone(Array.from(this.ledger.values()));
  }

  getLedgerCount() {
    return this.ledger.size;
  }

  getCursorState(batchId) {
    const cursor = this.cursors.get(batchId);
    return cursor ? structuredClone(cursor) : null;
  }

  getTotalCredits() {
    const total = this.getTotalCreditsBigInt();
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('total credits exceed the safe integer range');
    }
    return Number(total);
  }

  getTotalCreditsBigInt() {
    return this.getLedger().reduce(
      (total, payout) => total + BigInt(payout.credits),
      0n,
    );
  }
}

module.exports = {
  SettlementService,
  WEEKLY_REWARD_CREDITS,
  getMondayStartUtc,
  isScheduledSettlementTime,
  isWithinSettlementWindow,
};
