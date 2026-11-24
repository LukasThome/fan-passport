// Identity binding (section 4.3, layer 2): keyed hash, under a per-issuer secret, of the normalised
// legal name and verified phone. Per-issuer so issuers cannot link fans. Only the commitment goes on-chain.
const crypto = require("crypto");

function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(phone) {
  return "+" + String(phone ?? "").replace(/\D/g, "");
}

function identityKey(name, phone) {
  return `${normalizeName(name)}|${normalizePhone(phone)}`;
}

function identityCommitment(issuerSecret, name, phone) {
  return "0x" + crypto.createHmac("sha256", issuerSecret).update(identityKey(name, phone)).digest("hex");
}

module.exports = { normalizeName, normalizePhone, identityKey, identityCommitment };
