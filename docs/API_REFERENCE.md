# Element Pay Listener API Reference

## Health Check API

### GET /healthz

Returns the health status of the listener.

**Response:**
```json
{
  "status": "ok|stale",
  "lastBlock": 1640995200000,
  "uptime": 3600
}
```

**Status Codes:**
- `200 OK`: Health check successful
- `503 Service Unavailable`: Listener is stale (no blocks for > 60s)

**Response Fields:**
- `status`: Current health status
  - `"ok"`: Listener is healthy and receiving blocks
  - `"stale"`: No blocks received for > 60 seconds
- `lastBlock`: Timestamp of last block received (Unix timestamp)
- `uptime`: Process uptime in seconds

**Example:**
```bash
curl http://localhost:3000/healthz
```

## Webhook Events

The listener sends signed webhook events to the backend API.

### Authentication

All webhook requests include the following headers:
- `X-EP-Timestamp`: Unix timestamp
- `X-EP-Signature`: HMAC-SHA256 signature
- `X-EP-Client`: Always "listener"
- `Content-Type`: application/json

### Signature Generation

```javascript
const signature = createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
```

### OrderCreated Event

**Endpoint:** `POST /events/order-created`

**Payload:**
```json
{
  "orderId": "12345",
  "requester": "0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6",
  "token": "0xA0b86a33E6441b8c4C8C0C8C0C8C0C8C0C8C0C8C",
  "amount": "1000000000000000000",
  "messageHash": "0x1234567890abcdef...",
  "orderType": 1,
  "transactionHash": "0xabcdef1234567890..."
}
```

**Fields:**
- `orderId`: Unique order identifier
- `requester`: Address of the order requester
- `token`: Token contract address
- `amount`: Order amount (wei)
- `messageHash`: Message hash for verification
- `orderType`: Type of order (integer)
- `transactionHash`: Transaction hash of the event

### OrderSettled Event

**Endpoint:** `POST /events/order-settled`

**Payload:**
```json
{
  "orderId": "12345",
  "transactionHash": "0xabcdef1234567890..."
}
```

**Fields:**
- `orderId`: Unique order identifier
- `transactionHash`: Transaction hash of the settlement

### OrderRefunded Event

**Endpoint:** `POST /events/order-refunded`

**Payload:**
```json
{
  "orderId": "12345",
  "transactionHash": "0xabcdef1234567890..."
}
```

**Fields:**
- `orderId`: Unique order identifier
- `transactionHash`: Transaction hash of the refund

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `LISTENER_CHAIN` | Chain identifier (base, lisk, scroll, arbitrum) | Yes | - |
| `RPC_WS_URL` | WebSocket RPC endpoint URL | Yes | - |
| `CONTRACT_ADDRESS` | Smart contract address to monitor | Yes | - |
| `FASTAPI_BASE_URL` | Backend API base URL | Yes | - |
| `LISTENER_WEBHOOK_SECRET` | Secret for webhook signing | Yes | - |
| `HEALTH_PORT` | Health check server port | No | 3000 |

### Example Configuration

#### Single Listener (.env file)
```bash
# Base chain listener
LISTENER_CHAIN=base
RPC_WS_URL=wss://mainnet.base.org
CONTRACT_ADDRESS=0x4f07419e6bfccf8d256e8ef803cc2653dfbb9558
FASTAPI_BASE_URL=http://localhost:8000
LISTENER_WEBHOOK_SECRET=your-secret-key
HEALTH_PORT=3000
```

#### Multi-Listener (Docker Compose environment variables)
```bash
# .env file for Docker Compose
ENVIRONMENT=prod

# RPC Endpoints
BASE_RPC=wss://mainnet.base.org
LISK_RPC=wss://rpc.lisk.com
SCROLL_RPC=wss://rpc.scroll.io
ARBITRUM_RPC=wss://arb1.arbitrum.io/ws

# Contract Addresses
CONTRACT_ADDRESS_BASE=0x4f07419e6bfccf8d256e8ef803cc2653dfbb9558
CONTRACT_ADDRESS_LISK=0x...
CONTRACT_ADDRESS_SCROLL=0x...
CONTRACT_ADDRESS_ARBITRUM=0x...

# Shared Configuration
FASTAPI_BASE_URL=http://localhost:8000
LISTENER_WEBHOOK_SECRET=your-secret-key
```

**Note**: In multi-listener setups, each listener gets its chain-specific values through Docker Compose environment variables, not from a shared .env file.

## Storage Files

### File Naming Convention

Storage files follow the pattern: `lastBlock_{rpc_domain}.txt`

**Examples:**
- `lastBlock_baseorg.txt` (Base chain - wss://mainnet.base.org)
- `lastBlock_liskcom.txt` (Lisk chain - wss://rpc.lisk.com)
- `lastBlock_scrollio.txt` (Scroll chain - wss://rpc.scroll.io)
- `lastBlock_arbitrum.txt` (Arbitrum chain - wss://arb1.arbitrum.io)

**Note**: Using RPC URL domain ensures unique file names since each chain has a different RPC endpoint.

### File Format

Each file contains a single line with the last seen block number:
```
30480337
```

### File Lifecycle

1. **Creation**: File created when first block is processed
2. **Updates**: File updated with each new block
3. **Expiration**: File automatically deleted if older than 1 hour
4. **Cleanup**: Old files cleaned up on startup

## Error Handling

### Common Error Scenarios

#### WebSocket Connection Errors
```json
{
  "error": "WebSocket connection failed",
  "code": "WEBSOCKET_ERROR",
  "retry": true
}
```

#### Backfill Errors
```json
{
  "error": "from block is greater than latest block",
  "code": "INVALID_BLOCK_RANGE",
  "retry": false
}
```

#### Storage Errors
```json
{
  "error": "Could not save last block",
  "code": "STORAGE_ERROR",
  "retry": true
}
```

### Error Recovery

The listener implements automatic error recovery:

1. **WebSocket disconnections**: Automatic reconnection with exponential backoff
2. **Invalid block ranges**: Graceful skipping with logging
3. **Storage errors**: Automatic file clearing and fresh start
4. **Network errors**: Retry with backoff

## Logging

### Log Levels

- **INFO**: Normal operations (block processing, event handling)
- **WARN**: Recoverable issues (reconnections, skipped backfills)
- **ERROR**: Critical issues (connection failures, processing errors)

### Log Format

```
[timestamp] [level] [message] [context]
```

**Examples:**
```
2024-01-01T12:00:00.000Z INFO 💓 New block: 30480337
2024-01-01T12:00:01.000Z INFO 📥 OrderCreated received: {...}
2024-01-01T12:00:02.000Z WARN ⚠️ WebSocket closed: 1006 - Connection lost
2024-01-01T12:00:03.000Z ERROR ❌ Error during backfill: Invalid block range
```

### Log Context

Logs include relevant context:
- Chain name
- Block numbers
- Event details
- Error codes
- Retry attempts

## Monitoring

### Health Check Monitoring

```bash
# Check listener health
curl -f http://localhost:3000/healthz

# Check multiple listeners
for port in 3000 3001 3002 3003; do
  echo "Port $port: $(curl -s http://localhost:$port/healthz | jq -r '.status')"
done
```

### Log Monitoring

```bash
# Monitor logs in real-time
docker logs -f base-listener

# Filter for specific events
docker logs base-listener | grep "OrderCreated"

# Monitor for errors
docker logs base-listener | grep "ERROR"
```

### Metrics Collection

**Available Metrics:**
- Block processing rate
- Event processing rate
- Error rate
- Uptime
- Last block timestamp

**Future Enhancements:**
- Prometheus metrics endpoint
- Custom metrics dashboard
- Alerting integration

## Testing

### Unit Tests

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage
```

### Integration Tests

```bash
# Test with local blockchain
npm run test:integration

# Test webhook delivery
npm run test:webhooks
```

### Load Testing

```bash
# Test event processing
npm run test:load

# Test backfill performance
npm run test:backfill
```

## Troubleshooting

### Common Issues

#### Listener Not Receiving Events
1. Check WebSocket connection: `docker logs base-listener | grep "WebSocket"`
2. Verify contract address: `docker exec base-listener env | grep CONTRACT`
3. Check RPC endpoint: Test WebSocket connection manually

#### Events Not Being Forwarded
1. Check backend connectivity: `curl -f $FASTAPI_BASE_URL/health`
2. Verify webhook secret: Check signature validation
3. Check event handlers: `docker logs base-listener | grep "OrderCreated"`

#### Storage Issues
1. Check file permissions: `docker exec base-listener ls -la lastBlock_*.txt`
2. Verify disk space: `docker exec base-listener df -h`
3. Check file contents: `docker exec base-listener cat lastBlock_base.txt`

### Debug Mode

```bash
# Enable debug logging
export DEBUG=elementpay:listener
npm start
```

### Performance Profiling

```bash
# Profile memory usage
docker stats base-listener

# Profile CPU usage
docker exec base-listener top

# Profile network usage
docker exec base-listener netstat -i
```

## Security

### Webhook Security

- **HMAC-SHA256**: All webhooks are signed
- **Timestamp validation**: Prevents replay attacks
- **Secret rotation**: Regular secret updates recommended

### Network Security

- **TLS**: Use HTTPS for webhook endpoints
- **Firewall**: Restrict access to health check ports
- **VPN**: Use VPN for production deployments

### Data Security

- **File permissions**: Restrict access to storage files
- **Secret management**: Use environment variables or secrets management
- **Audit logging**: Log all critical operations

## Support

### Getting Help

1. **Documentation**: Check this API reference and architecture docs
2. **Logs**: Review listener logs for error details
3. **Health checks**: Use health endpoints to diagnose issues
4. **Community**: Join the Element Pay community for support

### Reporting Issues

When reporting issues, include:
- Listener version and chain
- Error logs and stack traces
- Configuration (without secrets)
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Docker version, etc.)
