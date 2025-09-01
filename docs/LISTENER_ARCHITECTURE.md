# Element Pay Listener Architecture

## Overview

The Element Pay Listener is a blockchain event listener that monitors smart contract events across multiple chains. It features automatic backfill capabilities, persistent storage, and robust error handling.

## Architecture

### Core Components

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   listener.js   │    │ backfillManager  │    │  blockStorage   │
│                 │    │      .js         │    │      .js        │
│ • WebSocket     │◄──►│                  │◄──►│                 │
│ • Event Handlers│    │ • Backfill Logic │    │ • File Storage  │
│ • Health Check  │    │ • Range Validation│    │ • Auto Cleanup  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### 1. **listener.js** - Main Listener
- **Responsibility**: WebSocket connections, event processing, health monitoring
- **Key Features**:
  - WebSocket provider management
  - Event handler registration
  - Reconnection logic with exponential backoff
  - Health check endpoint
  - Idempotency checks

### 2. **backfillManager.js** - Backfill Logic
- **Responsibility**: Handling missed events during disconnections/restarts
- **Key Features**:
  - Block range validation
  - Event querying and processing
  - Error handling for backfill operations
  - Chain-specific logging

### 3. **blockStorage.js** - Persistent Storage
- **Responsibility**: File-based storage of last seen block numbers
- **Key Features**:
  - Chain-specific file storage
  - Automatic cleanup of old files
  - Time-based file expiration (1 hour)
  - Error recovery and self-healing

## Event Flow

### Normal Operation
```
1. WebSocket receives new block
2. BackfillManager checks for missed events
3. If gap exists, queries historical events
4. Processes events through handlers
5. Updates persistent storage
6. Continues monitoring
```

### After Restart/Disconnection
```
1. Load lastSeenBlock from file
2. New block arrives
3. Calculate gap (currentBlock - lastSeenBlock)
4. Backfill missed events
5. Update storage with current block
6. Resume normal operation
```

## Supported Events

- **OrderCreated**: New payment order created
- **OrderSettled**: Payment order completed
- **OrderRefunded**: Payment order refunded

## Multi-Chain Support

Each listener instance is configured for a specific chain:
- **base-listener**: Base chain
- **lisk-listener**: Lisk chain  
- **scroll-listener**: Scroll chain
- **arbitrum-listener**: Arbitrum chain

Each maintains its own:
- Storage file (`lastBlock_{chain}.txt`)
- WebSocket connection
- Event processing
- Backfill state

## Error Handling

### Automatic Recovery
- **WebSocket disconnections**: Automatic reconnection with backoff
- **Invalid block ranges**: Graceful skipping with logging
- **Corrupted storage**: Automatic file clearing and fresh start
- **Old storage files**: Automatic cleanup on startup

### Error Scenarios Handled
- `from block is greater than latest block`
- WebSocket connection failures
- Invalid JSON in storage files
- File system errors
- Network timeouts

## Configuration

### Environment Variables
```bash
LISTENER_CHAIN=base                    # Chain identifier
RPC_WS_URL=wss://...                  # WebSocket RPC endpoint
CONTRACT_ADDRESS=0x...                # Smart contract address
FASTAPI_BASE_URL=http://...           # Backend API URL
LISTENER_WEBHOOK_SECRET=...           # Webhook signing secret
HEALTH_PORT=3000                      # Health check port
```

### Docker Compose Integration
```yaml
base-listener:
  <<: *listener-base
  container_name: base-listener
  environment:
    LISTENER_CHAIN: base
    RPC_WS_URL: ${BASE_RPC}
    CONTRACT_ADDRESS: ${CONTRACT_ADDRESS_BASE}
    FASTAPI_BASE_URL: ${FASTAPI_BASE_URL}
```

## Storage Management

### File Structure
```
/
├── lastBlock_baseorg.txt     # Base chain last block (RPC domain)
├── lastBlock_liskcom.txt     # Lisk chain last block (RPC domain)
├── lastBlock_scrollio.txt    # Scroll chain last block (RPC domain)
└── lastBlock_arbitrum.txt    # Arbitrum chain last block (RPC domain)
```

**Note**: Files are named using the RPC URL domain to ensure uniqueness across different chains.

### Automatic Cleanup
- **Time-based**: Files older than 1 hour are automatically cleared
- **Startup cleanup**: All old files are cleaned on listener startup
- **Error recovery**: Corrupted files are automatically cleared
- **No manual intervention**: Fully automated maintenance

## Monitoring

### Health Check Endpoint
```bash
GET /healthz
```

Response:
```json
{
  "status": "ok|stale",
  "lastBlock": 1640995200000,
  "uptime": 3600
}
```

### Logging
- **Block processing**: `💓 New block: {number}`
- **Backfill operations**: `🔍 Backfilling events from block {from} to {to}`
- **Event processing**: `📥 OrderCreated received: {args}`
- **Storage operations**: `💾 Saved last seen block for {chain}: {number}`
- **Error handling**: `❌ Error during backfill: {message}`

## Best Practices

### Production Deployment
1. **Use environment-specific configurations**
2. **Monitor health check endpoints**
3. **Set up log aggregation**
4. **Configure alerting for stale status**
5. **Regular backup of storage files** (optional)

### Development
1. **Use separate storage files for testing**
2. **Clear storage files between test runs**
3. **Monitor logs for backfill operations**
4. **Test reconnection scenarios**

## Troubleshooting

### Common Issues

#### "from block is greater than latest block"
- **Cause**: Invalid block range during backfill
- **Solution**: Automatic bounds checking prevents this error
- **Prevention**: Built-in validation in BackfillManager

#### Missing Events After Restart
- **Cause**: Storage file was too old (> 1 hour)
- **Solution**: Events older than 1 hour are not backfilled by design
- **Prevention**: Ensure regular restarts or implement custom backfill logic

#### WebSocket Connection Issues
- **Cause**: Network problems or RPC endpoint issues
- **Solution**: Automatic reconnection with exponential backoff
- **Monitoring**: Check health endpoint for stale status

### Debug Commands
```bash
# Check storage files
ls -la lastBlock_*.txt

# Monitor logs
docker logs base-listener -f

# Check health
curl http://localhost:3000/healthz
```

## Performance Considerations

### Memory Usage
- **Event deduplication**: Uses Sets for O(1) lookup
- **Storage**: Minimal file I/O operations
- **WebSocket**: Efficient event streaming

### Network Usage
- **Backfill**: Only queries when gaps exist
- **Validation**: Prevents unnecessary queries
- **Batching**: Processes multiple events efficiently

## Security

### Webhook Signing
- **HMAC-SHA256**: All webhook requests are signed
- **Timestamp validation**: Prevents replay attacks
- **Secret management**: Environment variable based

### Input Validation
- **Block numbers**: Validated before queries
- **Event data**: Sanitized before processing
- **File operations**: Error handling for all I/O

## Future Enhancements

### Potential Improvements
1. **Database storage**: Replace file storage with database
2. **Metrics collection**: Add Prometheus metrics
3. **Event filtering**: Configurable event filtering
4. **Batch processing**: Process multiple events in batches
5. **Circuit breaker**: Add circuit breaker for external API calls

### Scalability
- **Horizontal scaling**: Multiple instances per chain
- **Load balancing**: Distribute events across instances
- **Event partitioning**: Partition events by order ID or other criteria
