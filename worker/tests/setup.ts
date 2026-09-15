// Workers add crypto.subtle.timingSafeEqual; Node does not. A test-only stand-in
// with the same contract (throws on unequal lengths).
type Bytes = ArrayBuffer | ArrayBufferView;
const toBytes = (v: Bytes): Uint8Array =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

const subtle = globalThis.crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
if (typeof subtle.timingSafeEqual !== "function") {
  Object.defineProperty(subtle, "timingSafeEqual", {
    configurable: true,
    value: (a: Bytes, b: Bytes): boolean => {
      const x = toBytes(a);
      const y = toBytes(b);
      if (x.byteLength !== y.byteLength) throw new TypeError("Input buffers must have the same byte length");
      let diff = 0;
      for (let i = 0; i < x.byteLength; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
      return diff === 0;
    },
  });
}
