/**
 * 知乎照妖镜 — MD5 内容哈希
 * 用途：二审缓存的内容寻址键（非安全用途，仅判断内容是否变化）。
 * Web Crypto 不支持 MD5，故自带实现（RFC 1321，Uint8Array 版，UTF-8 正确处理中文）。
 * 依赖：constants.js（先加载，提供命名空间）。
 */
(() => {
'use strict';
const ZD = globalThis.ZhihuDetector;

/**
 * @param {string|Uint8Array} input
 * @returns {string} 32 位小写十六进制 MD5
 */
function md5(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;

  // 填充：0x80 + 零 + 64 位小端长度（bit）
  const bitLenLo = bytes.length * 8 >>> 0;
  const bitLenHi = Math.floor(bytes.length / 0x20000000) >>> 0; // bytes*8 / 2^32
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, bitLenLo, true);
  dv.setUint32(paddedLen - 4, bitLenHi, true);

  // 常量
  const S = new Uint8Array([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]);
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  let a0 = 0x67452301;
  let b0 = 0xEFCDAB89;
  let c0 = 0x98BADCFE;
  let d0 = 0x10325476;

  const words = new Uint32Array(buf.buffer);
  for (let off = 0; off < paddedLen / 64; off++) {
    const M = words.subarray(off * 16, off * 16 + 16);
    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (B & C) | (~B & D); g = j; }
      else if (j < 32) { f = (D & B) | (~D & C); g = (5 * j + 1) & 15; }
      else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) & 15; }
      else { f = C ^ (B | ~D); g = (7 * j) & 15; }
      const tmp = D;
      D = C;
      C = B;
      const x = (A + f + K[j] + M[g]) >>> 0;
      B = (B + ((x << S[j]) | (x >>> (32 - S[j])))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}

ZD.md5 = md5;
})();
