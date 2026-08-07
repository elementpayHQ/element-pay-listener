# Stellar Soroban listener

Polls order-contract events and POSTs HMAC-signed payloads to the same
FastAPI `/events/*` endpoints as the EVM listeners.

```bash
# from element-pay-listener root (uses existing axios/dotenv/express)
export STELLAR_NETWORK=testnet
export STELLAR_ORDER_CONTRACT_ID=CCWG74PM5EFLF7BIO5LZK32VXKD5ONHA7SCRCR4UTVHA4OL5V4NARUK4
export FASTAPI_BASE_URL=https://your-api/api/v1
export LISTENER_WEBHOOK_SECRET=...
export STELLAR_HEALTH_PORT=8089   # separate from EVM HEALTH_PORT=3000
node stellar/stellarListener.js
```

`scvalXdr.js` decodes default Soroban `getEvents` base64 SCVal topic XDR
(order/created symbols, BytesN order ids, G/C addresses).
