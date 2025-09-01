const fs = require('fs');
const path = require('path');

/**
 * BlockStorage - Handles persistent storage of last seen block numbers
 * Provides chain-specific file storage with automatic cleanup
 */
class BlockStorage {
  constructor(chainName = 'unknown') {
    this.chainName = chainName;
    // Uses RPC URL for unique file naming
    const rpcUrl = process.env.RPC_WS_URL || 'unknown';
    const fileSuffix = this._extractFileSuffix(rpcUrl);
    this.storageFile = path.join(__dirname, `lastBlock_${fileSuffix}.txt`);
    this.maxFileAge = 3600000; // 1 hour in milliseconds
  }

  /**
   * Extract a safe file suffix from RPC URL
   * @param {string} rpcUrl - The RPC URL
   * @returns {string} Safe file suffix
   */
  _extractFileSuffix(rpcUrl) {
    try {
      // Handle null/undefined/empty values(Shouldn't happen but just in case)
      if (!rpcUrl || typeof rpcUrl !== 'string') {
        return 'unknown';
      }
      
      // Handle different URL formats
      let domain = 'unknown';
      
      if (rpcUrl.includes('://')) {
        // Full URL: wss://mainnet.base.org or https://rpc.lisk.com
        const urlParts = rpcUrl.split('/');
        domain = urlParts[2] || 'unknown';
      } else if (rpcUrl.includes('.')) {
        // Domain only: mainnet.base.org
        domain = rpcUrl;
      } else {
        // Fallback: use the whole string
        domain = rpcUrl;
      }
      
      // Clean domain: remove all non-alphanumeric characters
      const cleanDomain = domain.replace(/[^a-zA-Z0-9]/g, '');
      
      // Ensure we have at least 3 characters, take last 8 max
      if (cleanDomain.length === 0) {
        return 'unknown';
      } else if (cleanDomain.length <= 8) {
        return cleanDomain;
      } else {
        return cleanDomain.slice(-8);
      }
    } catch (error) {
      console.warn(`⚠️ Error parsing RPC URL "${rpcUrl}":`, error.message);
      return 'unknown';
    }
  }

  /**
   * Load the last seen block number from persistent storage
   * Automatically clears old files to prevent stale data
   * @returns {number|null} The last seen block number or null if not found/invalid
   */
  loadLastSeenBlock() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const stats = fs.statSync(this.storageFile);
        const fileAge = Date.now() - stats.mtime.getTime();
        
        // If file is older than maxFileAge, automatically clear it
        if (fileAge > this.maxFileAge) {
          console.log(`🔄 Last block file for ${this.chainName} is too old (${Math.round(fileAge / 1000 / 60)} minutes), automatically clearing`);
          this.clearStorage();
          return null;
        }
        
        const content = fs.readFileSync(this.storageFile, 'utf8').trim();
        const blockNumber = parseInt(content);
        if (!isNaN(blockNumber)) {
          console.log(`📁 Loaded last seen block for ${this.chainName}: ${blockNumber}`);
          return blockNumber;
        } else {
          // Invalid content in file, clear it
          console.log(`🔄 Invalid content in block file for ${this.chainName}, automatically clearing`);
          this.clearStorage();
        }
      }
    } catch (err) {
      console.warn(`⚠️ Could not load last block file for ${this.chainName}:`, err.message);
      // If there's an error reading the file, try to clear it
      this.clearStorage();
    }
    return null;
  }

  /**
   * Save the current block number to persistent storage
   * @param {number} blockNumber - The block number to save
   */
  saveLastSeenBlock(blockNumber) {
    try {
      fs.writeFileSync(this.storageFile, blockNumber.toString());
      console.log(`Saved last seen block for ${this.chainName}: ${blockNumber}`);
    } catch (err) {
      console.error(`Could not save last block for ${this.chainName}:`, err.message);
    }
  }

  /**
   * Check if a block range is valid for backfilling
   * @param {number} fromBlock - Starting block number
   * @param {number} toBlock - Ending block number
   * @returns {boolean} True if the range is valid
   */
  isValidBlockRange(fromBlock, toBlock) {
    return fromBlock <= toBlock && fromBlock > 0 && toBlock > 0;
  }

  /**
   * Get the storage file path (useful for debugging)
   * @returns {string} The full path to the storage file
   */
  getStoragePath() {
    return this.storageFile;
  }

  /**
   * Manually clear the storage file (useful for testing/reset)
   */
  clearStorage() {
    try {
      if (fs.existsSync(this.storageFile)) {
        fs.unlinkSync(this.storageFile);
        console.log(`Cleared storage file for ${this.chainName}`);
      }
    } catch (err) {
      console.error(`Could not clear storage file for ${this.chainName}:`, err.message);
    }
  }

  /**
   * Clean up old storage files for all chains (startup maintenance)
   * This is a class method that can be called to clean up stale files
   */
  static cleanupOldFiles() {
    try {
      const files = fs.readdirSync(__dirname);
      const blockFiles = files.filter(file => file.startsWith('lastBlock_') && file.endsWith('.txt'));
      
      let cleanedCount = 0;
      blockFiles.forEach(file => {
        const filePath = path.join(__dirname, file);
        const stats = fs.statSync(filePath);
        const fileAge = Date.now() - stats.mtime.getTime();
        
        if (fileAge > 3600000) { // 1 hour
          fs.unlinkSync(filePath);
          const fileSuffix = file.replace('lastBlock_', '').replace('.txt', '');
          console.log(`🧹 Cleaned up old storage file ${fileSuffix} (${Math.round(fileAge / 1000 / 60)} minutes old)`);
          cleanedCount++;
        }
      });
      
      if (cleanedCount > 0) {
        console.log(`🧹 Cleanup complete: removed ${cleanedCount} old storage files`);
      }
    } catch (err) {
      console.warn('⚠️ Could not perform storage cleanup:', err.message);
    }
  }
}

module.exports = BlockStorage;
