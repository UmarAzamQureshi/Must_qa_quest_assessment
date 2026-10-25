class SettlementServiceFacade {
  constructor(settlementService) {
    if (!settlementService) {
      throw new TypeError('settlementService is required');
    }
    this.settlementService = settlementService;
  }

  async triggerSettlement(settlementRunAt, options) {
    return this.settlementService.triggerSettlement(settlementRunAt, options);
  }

  getTaskState(taskId) {
    return this.settlementService.getTaskState(taskId);
  }

  getTaskStates() {
    return this.settlementService.getTaskStates();
  }

  getCreditLedgerCount() {
    return this.settlementService.getLedgerCount();
  }

  getCreditLedger() {
    return this.settlementService.getLedger();
  }

  getCreditLedgerEntry(taskId) {
    return this.getCreditLedger().find((entry) => entry.taskId === taskId) || null;
  }

  getTotalCredits() {
    return this.settlementService.getTotalCredits();
  }

  getTotalCreditsBigInt() {
    return this.settlementService.getTotalCreditsBigInt();
  }

  getSettlementCursor(batchId) {
    return this.settlementService.getCursorState(batchId);
  }
}

module.exports = { SettlementServiceFacade };
