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
    this.lastSeenBlock = null; // Keep track of last seen block in memory
  }

  /**
   * Initialize the backfill manager by loading the last seen block
   * @returns {number|null} The last seen block number
   */
  initialize() {
    this.lastSeenBlock = this.blockStorage.loadLastSeenBlock();
    return this.lastSeenBlock;
  }

  /**
   * Handle a new block and perform backfill if needed
   * @param {number} currentBlock - The current block number
   * @param {Object} eventHandlers - Object containing event handler functions
   */
  async handleNewBlock(currentBlock, eventHandlers) {
    // Check if we need to backfill using in-memory lastSeenBlock
    if (this.lastSeenBlock && currentBlock > this.lastSeenBlock) {
      const fromBlock = this.lastSeenBlock + 1;
      const toBlock = currentBlock;
      
      // Only backfill if there's actually a gap (more than 1 block difference)
      if (this.blockStorage.isValidBlockRange(fromBlock, toBlock) && fromBlock < toBlock) {
        await this.performBackfill(fromBlock, toBlock, eventHandlers);
      }
      // No backfill needed for consecutive blocks - this is normal operation
    }
    
    // Update in-memory lastSeenBlock and save to storage
    this.lastSeenBlock = currentBlock;
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
   * Get the current last seen block from memory
   * @returns {number|null} The last seen block number
   */
  getLastSeenBlock() {
    return this.lastSeenBlock;
  }

  /**
   * Manually clear the storage (useful for testing/reset)
   */
  clearStorage() {
    this.blockStorage.clearStorage();
  }
}

module.exports = BackfillManager;
