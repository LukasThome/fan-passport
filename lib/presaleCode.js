// Single-use, credential-bound presale code (technical white paper, footnote 1):
// HMAC-SHA256 over the credential ID, keyed by a per-drop key that HKDF derives from the issuer
// master key with salt = dropId. The code is the first 5 bytes, base32-encoded, 8 characters.
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function uint256(n) {
  return Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex");
}

function deriveDropKey(masterKey, dropId) {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, uint256(dropId), Buffer.from("FanPassport presale code v1"), 32));
}

function presaleCode(masterKey, dropId, credentialId) {
  const mac = crypto.createHmac("sha256", deriveDropKey(masterKey, dropId)).update(uint256(credentialId)).digest();
  return base32(mac.subarray(0, 5));
}

module.exports = { base32, deriveDropKey, presaleCode };
