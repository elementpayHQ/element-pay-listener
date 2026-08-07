/**
 * Minimal Soroban SCVal XDR (base64) + StrKey encode for the Stellar listener.
 *
 * getEvents default format returns topic/value as base64 SCVal XDR strings, e.g.:
 *   "AAAADwAAAAVvcmRlcgAAAA=="  → symbol "order"
 *   "AAAADwAAAAdjcmVhdGVkAA==" → symbol "created"
 *
 * Covers the types used by OrderCreated / OrderSettled / OrderRefunded layouts.
 * Not a full XDR implementation.
 */

const VERSION_ACCOUNT = 0x30; // G…
const VERSION_CONTRACT = 0x10; // C…

/** CRC16-XModem (Stellar StrKey checksum). */
function crc16xmodem(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(data) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < data.length; i += 1) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function encodeStrKey(versionByte, payload32) {
  if (!payload32 || payload32.length !== 32) {
    throw new Error(`StrKey payload must be 32 bytes, got ${payload32?.length}`);
  }
  const body = Buffer.concat([Buffer.from([versionByte]), payload32]);
  const crc = crc16xmodem(body);
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc, 0);
  return encodeBase32(Buffer.concat([body, checksum]));
}

class XdrReader {
  constructor(buf) {
    this.buf = buf;
    this.i = 0;
  }

  remaining() {
    return this.buf.length - this.i;
  }

  u32() {
    if (this.i + 4 > this.buf.length) throw new Error('xdr underrun u32');
    const v = this.buf.readUInt32BE(this.i);
    this.i += 4;
    return v;
  }

  i32() {
    if (this.i + 4 > this.buf.length) throw new Error('xdr underrun i32');
    const v = this.buf.readInt32BE(this.i);
    this.i += 4;
    return v;
  }

  i64() {
    if (this.i + 8 > this.buf.length) throw new Error('xdr underrun i64');
    const v = this.buf.readBigInt64BE(this.i);
    this.i += 8;
    return v;
  }

  u64() {
    if (this.i + 8 > this.buf.length) throw new Error('xdr underrun u64');
    const v = this.buf.readBigUInt64BE(this.i);
    this.i += 8;
    return v;
  }

  raw(n) {
    if (this.i + n > this.buf.length) throw new Error(`xdr underrun raw ${n}`);
    const s = this.buf.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }

  /** XDR padding to 4-byte boundary after opaque of length n. */
  pad(n) {
    const pad = (4 - (n % 4)) % 4;
    this.i += pad;
  }

  opaque() {
    const n = this.u32();
    const s = this.raw(n);
    this.pad(n);
    return s;
  }

  /**
   * Decode one SCVal into a JSON-ish shape similar to RPC xdrFormat=json.
   * @returns {{symbol?:string,string?:string,bytes?:Buffer,address?:string,u32?:number,i128?:string,u64?:string,void?:true,map?:Array,vec?:Array}}
   */
  readScVal() {
    const t = this.u32();
    switch (t) {
      case 0: // BOOL
        return { bool: this.u32() !== 0 };
      case 1: // VOID
        return { void: true };
      case 3: // U32
        return { u32: this.u32() };
      case 4: // I32
        return { i32: this.i32() };
      case 5: // U64
        return { u64: this.u64().toString() };
      case 6: // I64
        return { i64: this.i64().toString() };
      case 9: {
        // U128
        const hi = this.u64();
        const lo = this.u64();
        return { u128: ((hi << 64n) + lo).toString() };
      }
      case 10: {
        // I128 — Int128Parts { hi:i64, lo:u64 }
        const hi = this.i64();
        const lo = this.u64();
        let v;
        if (hi < 0n) {
          // two's complement style: (hi << 64) + lo with signed hi
          v = (hi << 64n) + BigInt(lo);
        } else {
          v = (BigInt(hi) << 64n) + BigInt(lo);
        }
        return { i128: v.toString() };
      }
      case 13: {
        // BYTES
        return { bytes: this.opaque() };
      }
      case 14: {
        // STRING
        return { string: this.opaque().toString('utf8') };
      }
      case 15: {
        // SYMBOL
        return { symbol: this.opaque().toString('utf8') };
      }
      case 16: {
        // VEC
        const n = this.u32();
        const vec = [];
        for (let i = 0; i < n; i += 1) vec.push(this.readScVal());
        return { vec };
      }
      case 17: {
        // MAP
        const n = this.u32();
        const map = [];
        for (let i = 0; i < n; i += 1) {
          map.push({ key: this.readScVal(), val: this.readScVal() });
        }
        return { map };
      }
      case 18: {
        // ADDRESS
        const addrType = this.u32();
        if (addrType === 0) {
          // Account: PublicKeyType (0=ed25519) + 32 bytes
          const pkType = this.u32();
          if (pkType !== 0) throw new Error(`unsupported PublicKeyType ${pkType}`);
          const payload = this.raw(32);
          return { address: encodeStrKey(VERSION_ACCOUNT, payload) };
        }
        if (addrType === 1) {
          // Contract: 32-byte hash
          const payload = this.raw(32);
          return { address: encodeStrKey(VERSION_CONTRACT, payload) };
        }
        throw new Error(`unsupported ScAddress type ${addrType}`);
      }
      default:
        throw new Error(`unsupported SCValType ${t}`);
    }
  }
}

/**
 * @param {string} b64 base64 SCVal XDR
 * @returns {object|null}
 */
function decodeScValBase64(b64) {
  if (typeof b64 !== 'string' || !b64.length) return null;
  // avoid non-base64 junk
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64) || b64.length < 4) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return null;
    const r = new XdrReader(buf);
    return r.readScVal();
  } catch {
    return null;
  }
}

/**
 * If value looks like base64 SCVal, decode to JSON object; else return as-is.
 */
function coerceTopicOrValue(raw) {
  if (typeof raw === 'string') {
    const decoded = decodeScValBase64(raw);
    if (decoded) return decoded;
  }
  return raw;
}

module.exports = {
  decodeScValBase64,
  coerceTopicOrValue,
  encodeStrKey,
  XdrReader,
};
