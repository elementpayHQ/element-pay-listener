# Element Pay Listener

A production-ready blockchain event listener for Element Pay smart contracts across multiple chains.

## 🚀 Features

- **Multi-chain support**: Base, Lisk, Scroll, Arbitrum
- **Automatic backfill**: Never miss events during disconnections
- **Persistent storage**: Survives restarts and reconnections
- **Self-healing**: Automatic error recovery and cleanup
- **Health monitoring**: Built-in health check endpoint
- **Event deduplication**: Prevents duplicate event processing
- **Webhook signing**: Secure event delivery with HMAC-SHA256

## 📋 Quick Start

### 1. Installation
```bash
git clone <repository-url>
cd element-pay-listener
npm install
```

### 2. Configuration
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Run Locally
```bash
npm start
```

### 4. Docker Deployment
```bash
docker build -t elementpay/epay-listeners:latest .
docker run -d --env-file .env -p 3000:3000 elementpay/epay-listeners:latest
```

## 🏗️ Architecture

The listener uses a modular architecture with three main components:

- **`listener.js`**: Main WebSocket listener and event processor
- **`backfillManager.js`**: Handles missed events during disconnections
- **`blockStorage.js`**: Persistent storage with automatic cleanup

## 📚 Documentation

- **[Architecture Guide](docs/LISTENER_ARCHITECTURE.md)**: Detailed system architecture and design

- **[API Reference](docs/API_REFERENCE.md)**: Complete API documentation

## 🔧 Configuration

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
```bash
LISTENER_CHAIN=base
RPC_WS_URL=wss://mainnet.base.org
CONTRACT_ADDRESS=0x4f07419e6bfccf8d256e8ef803cc2653dfbb9558
FASTAPI_BASE_URL=http://localhost:8000
LISTENER_WEBHOOK_SECRET=your-secret-key
HEALTH_PORT=3000
```

## 🏥 Health Check

Monitor listener health:
```bash
curl http://localhost:3000/healthz
```

Response:
```json
{
  "status": "ok",
  "lastBlock": 1640995200000,
  "uptime": 3600
}
```

## 🐳 Multi-Listener Deployment

Deploy multiple listeners using Docker Compose:

```yaml
version: '3.9'
services:
  # Base listener definition (shared image & config)
  listener-base: &listener-base
    image: elementpay/epay-listeners:latest
    restart: always
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:${HEALTH_PORT:-3000}/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3

  base-listener:
    <<: *listener-base
    container_name: base-listener
    environment:
      LISTENER_CHAIN: base
      RPC_WS_URL: ${BASE_RPC}
      CONTRACT_ADDRESS: ${CONTRACT_ADDRESS_BASE}
      FASTAPI_BASE_URL: ${FASTAPI_BASE_URL}
      LISTENER_WEBHOOK_SECRET: ${LISTENER_WEBHOOK_SECRET}
      HEALTH_PORT: 3000

  lisk-listener:
    <<: *listener-base
    container_name: lisk-listener
    environment:
      LISTENER_CHAIN: lisk
      RPC_WS_URL: ${LISK_RPC}
      CONTRACT_ADDRESS: ${CONTRACT_ADDRESS_LISK}
      FASTAPI_BASE_URL: ${FASTAPI_BASE_URL}
      LISTENER_WEBHOOK_SECRET: ${LISTENER_WEBHOOK_SECRET}
      HEALTH_PORT: 3001
```

## 📊 Monitoring

### Health Monitoring
```bash
# Check all listeners
for port in 3000 3001 3002 3003; do
  echo "Port $port: $(curl -s http://localhost:$port/healthz | jq -r '.status')"
done
```

### Log Monitoring
```bash
# Monitor logs
docker logs -f base-listener

# Filter for specific events
docker logs base-listener | grep "OrderCreated"
```

## 🔒 Security

- **Webhook signing**: All events are signed with HMAC-SHA256
- **Timestamp validation**: Prevents replay attacks
- **Secure storage**: File-based storage with automatic cleanup
- **Network security**: Configurable port binding and access control

## 🚨 Troubleshooting

### Common Issues

1. **"from block is greater than latest block"**: Fixed with automatic bounds checking
2. **Missing events after restart**: Automatic backfill handles recent restarts
3. **WebSocket connection issues**: Automatic reconnection with exponential backoff

### Debug Commands
```bash
# Check storage files
ls -la lastBlock_*.txt

# Monitor logs
docker logs base-listener -f

# Check health
curl http://localhost:3000/healthz
```

## 📈 Performance

- **Memory efficient**: Uses Sets for O(1) event deduplication
- **Network optimized**: Only queries when gaps exist
- **Storage optimized**: Minimal file I/O with automatic cleanup
- **Scalable**: Supports horizontal scaling across multiple instances

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

- **Documentation**: Check the [docs](docs/) folder
- **Issues**: Report issues on GitHub
- **Community**: Join the Element Pay community

---

**Built with ❤️ for the Element Pay Backend Team**