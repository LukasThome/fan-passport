// TOTP (RFC 6238) / HOTP (RFC 4226), HMAC-SHA1.
// Ported from LukasThome/security-mini-blockchain (autenticacao.py) for the claim flow's OTP step.
const crypto = require("crypto");

function generateSecret() {
  return crypto.randomBytes(20); // 160 bits
}

function hotp(secret, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 10 ** digits).padStart(digits, "0");
}

function totp(secret, { time = Date.now() / 1000, step = 30, digits = 6 } = {}) {
  return hotp(secret, Math.floor(time / step), digits);
}

/** Accepts the current step and +/- `window` steps. Constant-time comparison. */
function verifyTotp(secret, code, { time = Date.now() / 1000, step = 30, digits = 6, window = 1 } = {}) {
  const clean = String(code ?? "").trim();
  if (!/^\d+$/.test(clean) || clean.length !== digits) return false;
  const t = Math.floor(time / step);
  let ok = false;
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, t + d, digits));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) ok = true;
  }
  return ok;
}

module.exports = { generateSecret, hotp, totp, verifyTotp };
