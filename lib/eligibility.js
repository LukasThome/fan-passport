// Issuer verification rules (technical white paper, section 4.1 step 3 and section 4.3).
// Initial parameters, subject to pilot data.
const { identityKey, normalizePhone } = require("./identity");

const DEFAULTS = { minValue: 15, holdDays: 14, maxIdentitiesPerPhone: 2 };
const truthy = (v) => ["true", "yes", "1", "y"].includes(String(v ?? "").trim().toLowerCase());

function hasContact(row) {
  return Boolean(row.name && row.email && row.phone);
}

/** Shared identity rules: one record per identity, <= N identities per phone. */
function applyIdentityRules(candidates, rejected, opts) {
  const seenIdentity = new Set();
  const identitiesByPhone = new Map();
  const eligible = [];
  for (const row of candidates) {
    const id = identityKey(row.name, row.phone);
    if (seenIdentity.has(id)) {
      rejected.push({ row, reason: "duplicate identity" });
      continue;
    }
    const phone = normalizePhone(row.phone);
    const ids = identitiesByPhone.get(phone) ?? new Set();
    if (ids.size >= opts.maxIdentitiesPerPhone) {
      rejected.push({ row, reason: `more than ${opts.maxIdentitiesPerPhone} identities on this phone` });
      continue;
    }
    seenIdentity.add(id);
    ids.add(id);
    identitiesByPhone.set(phone, ids);
    eligible.push(row);
  }
  return eligible;
}

function evaluateMerch(rows, options = {}) {
  const opts = { ...DEFAULTS, now: new Date(), ...options };
  const rejected = [];
  const candidates = [];
  const holdMs = opts.holdDays * 24 * 3600 * 1000;
  for (const row of rows) {
    let reason = null;
    if (!hasContact(row)) reason = "missing name, email or phone";
    else if (!truthy(row.paid)) reason = "order not paid";
    else if (truthy(row.refunded)) reason = "order refunded";
    else if (!(Number(row.value) >= opts.minValue)) reason = `below minimum value ($${opts.minValue})`;
    else if (!(opts.now - new Date(row.created_at) >= holdMs)) reason = `inside ${opts.holdDays}-day hold`;
    if (reason) rejected.push({ row, reason });
    else candidates.push(row);
  }
  return { eligible: applyIdentityRules(candidates, rejected, opts), rejected };
}

function evaluateAttendance(rows, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rejected = [];
  const candidates = [];
  for (const row of rows) {
    if (!hasContact(row)) rejected.push({ row, reason: "missing name, email or phone" });
    else if (!truthy(row.checked_in)) rejected.push({ row, reason: "not checked in" });
    else candidates.push(row);
  }
  return { eligible: applyIdentityRules(candidates, rejected, opts), rejected };
}

module.exports = { evaluateMerch, evaluateAttendance, DEFAULTS };
