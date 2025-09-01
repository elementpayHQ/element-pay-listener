const BlockStorage = require('./blockStorage');

/**
 * BackfillManager - Handles backfilling of missed events
 * Provides clean separation of backfill logic from the main listener
 */
class BackfillManager {
  constructor(contract, chainName) {
    this.contract = contract;
    this.blockStorage = new BlockStorage(chainName);
    this.chainName = chainName;
  }

  /**
   * Initialize the backfill manager by loading the last seen block
   * @returns {number|null} The last seen block number
   */
  initialize() {
    return this.blockStorage.loadLastSeenBlock();
  }

  /**
   * Handle a new block and perform backfill if needed
   * @param {number} currentBlock - The current block number
   * @param {Object} eventHandlers - Object containing event handler functions
   */
  async handleNewBlock(currentBlock, eventHandlers) {
    const lastSeenBlock = this.blockStorage.loadLastSeenBlock();
    
    // Check if we need to backfill
    if (lastSeenBlock && currentBlock > lastSeenBlock) {
      const fromBlock = lastSeenBlock + 1;
      const toBlock = currentBlock;
      
      // Validate block range - must have at least 1 block difference
      if (this.blockStorage.isValidBlockRange(fromBlock, toBlock) && fromBlock < toBlock) {
        await this.performBackfill(fromBlock, toBlock, eventHandlers);
      } else {
        console.log(`⚠️ Skipping backfill: invalid block range (from: ${fromBlock}, to: ${toBlock}) for ${this.chainName}`);
      }
    }
    
    // Update and save the current block
    this.blockStorage.saveLastSeenBlock(currentBlock);
  }

  /**
   * Perform the actual backfill operation
   * @param {number} fromBlock - Starting block number
   * @param {number} toBlock - Ending block number
   * @param {Object} eventHandlers - Object containing event handler functions
   */
  async performBackfill(fromBlock, toBlock, eventHandlers) {
    console.log(`🔍 Backfilling events from block ${fromBlock} to ${toBlock} for ${this.chainName}`);
    
    try {
      // Backfill OrderCreated events
      if (eventHandlers.handleOrderCreated) {
        const createdEvents = await this.contract.queryFilter("OrderCreated", fromBlock, toBlock);
        console.log(`Found ${createdEvents.length} OrderCreated events during backfill`);
        createdEvents.forEach(event => eventHandlers.handleOrderCreated(event));
      }

      // Backfill OrderSettled events
      if (eventHandlers.handleOrderSettled) {
        const settledEvents = await this.contract.queryFilter("OrderSettled", fromBlock, toBlock);
        console.log(`Found ${settledEvents.length} OrderSettled events during backfill`);
        settledEvents.forEach(event => eventHandlers.handleOrderSettled(event));
      }

      // Backfill OrderRefunded events
      if (eventHandlers.handleOrderRefunded) {
        const refundedEvents = await this.contract.queryFilter("OrderRefunded", fromBlock, toBlock);
        console.log(`Found ${refundedEvents.length} OrderRefunded events during backfill`);
        refundedEvents.forEach(event => eventHandlers.handleOrderRefunded(event));
      }
    } catch (err) {
      console.error(`Error during backfill for ${this.chainName}:`, err.message);
    }
  }

  /**
   * Get the current last seen block from storage
   * @returns {number|null} The last seen block number
   */
  getLastSeenBlock() {
    return this.blockStorage.loadLastSeenBlock();
  }

  /**
   * Manually clear the storage (useful for testing/reset)
   */
  clearStorage() {
    this.blockStorage.clearStorage();
  }
}

module.exports = BackfillManager;
