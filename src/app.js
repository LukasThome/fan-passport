// HTTP layer for the demo: issuer portal + relayer, claim flow, fan code reveal, two doors, mock seller.
// MVP simplification: every off-chain actor (issuers, doors, relayer, seller) runs in this one process
// with its own key. Each door still decides only from the signed QR and the shared chain state.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { parseCsv } = require("../lib/csv");
const { evaluateMerch, evaluateAttendance } = require("../lib/eligibility");
const { identityCommitment } = require("../lib/identity");
const { presaleCode } = require("../lib/presaleCode");
const { generateSecret, totp, verifyTotp } = require("../lib/totp");
const { attestationTypes, holderProofTypes, domainFor, bindMessage, codeRequestMessage } = require("../lib/eip712");

const PROOF_TTL = 60;
const MAX_CLOCK_SKEW = 30;
const ROOT = path.join(__dirname, "..");

function createApp(system) {
  const { ethers, provider, contracts, issuers, doors, drop, relayer, chainId } = system;
  const { registry, credential, gate } = contracts;
  const interfaces = [gate.interface, credential.interface, registry.interface];

  // ------------------------------------------------------------ off-chain state
  const claims = new Map(); // token -> { issuerId, row, otpSecret, used, tokenId }
  const outbox = []; // mocked e-mail + SMS deliveries
  const issued = []; // { tokenId, issuerId, name, email, phone, holder, txHash }
  const sellerCodes = new Map(); // code -> { issuerId, dropId, used, buyerName }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(ROOT, "public")));
  app.get("/vendor/ethers.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/ethers/dist/ethers.umd.min.js")));
  app.get("/vendor/qrcode.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/qrcode-generator/dist/qrcode.js")));

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(500).json({ error: decodeError(err) || err.shortMessage || err.message });
    });

  function decodeError(err) {
    if (err?.revert?.name) return err.revert.name;
    const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
    const hex = typeof data === "string" ? data : data?.data;
    if (typeof hex === "string" && hex.startsWith("0x")) {
      for (const iface of interfaces) {
        try {
          const parsed = iface.parseError(hex);
          if (parsed) return parsed.name;
        } catch (_) {}
      }
    }
    return null;
  }

  function getIssuer(req, res) {
    const issuer = issuers[Number(req.params.id)];
    if (!issuer) res.status(404).json({ error: "unknown issuer" });
    return issuer;
  }

  const nowSec = () => Math.floor(Date.now() / 1000);
  const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().replace(/\.\d+Z$/, "Z");

  // ----------------------------------------------------------------- overview
  app.get("/api/state", wrap(async (_req, res) => {
    const list = [];
    for (const i of Object.values(issuers)) {
      const onchain = await registry.getIssuer(i.id);
      list.push({ id: i.id, name: i.name, short: i.short, kind: i.kind, credType: i.credType, eventId: i.eventId, eventName: i.eventName, key: onchain.key, active: onchain.active, epoch: Number(onchain.epoch) });
    }
    const [, accepted] = await gate.getDrop(drop.id);
    res.json({
      chainId,
      network: system.networkName,
      contracts: { IssuerRegistry: await registry.getAddress(), FanCredential: await credential.getAddress(), RedemptionGate: await gate.getAddress() },
      admin: await registry.admin(),
      relayer: relayer.address,
      issuers: list,
      doors: Object.values(doors).map((d) => ({ id: d.id, issuerId: d.issuerId, name: d.name, address: d.signer.address })),
      drop: { id: drop.id, name: drop.name, acceptedIssuers: accepted.map(Number) },
    });
  }));

  app.get("/api/events", wrap(async (_req, res) => {
    const sources = [["IssuerRegistry", registry], ["FanCredential", credential], ["RedemptionGate", gate]];
    const events = [];
    for (const [contractName, c] of sources) {
      for (const log of await c.queryFilter("*", 0)) {
        if (!log.fragment || ["Transfer", "Locked"].includes(log.fragment.name)) continue;
        const args = {};
        log.fragment.inputs.forEach((inp, idx) => {
          const v = log.args[idx];
          args[inp.name] = Array.isArray(v) ? v.map(String) : String(v);
        });
        events.push({ name: log.fragment.name, contract: contractName, args, txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.index });
      }
    }
    events.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    res.json(events);
  }));

  app.get("/api/outbox", (_req, res) => {
    res.json(outbox.map((m) => ({ ...m, currentOtp: totp(Buffer.from(m.mockPhoneSecret, "hex")) })));
  });

  // ------------------------------------------------------------ issuer portal
  app.get("/api/issuers/:id/sample", (req, res) => {
    const issuer = getIssuer(req, res);
    if (!issuer) return;
    const text = fs.readFileSync(path.join(ROOT, "data", issuer.sample), "utf8").replace("{{RECENT}}", isoDaysAgo(3));
    res.type("text/csv").send(text);
  });

  app.post("/api/issuers/:id/upload", (req, res) => {
    const issuer = getIssuer(req, res);
    if (!issuer) return;
    const rows = parseCsv(req.body.csv || "");
    const result = issuer.kind === "merch" ? evaluateMerch(rows) : evaluateAttendance(rows);
    for (const row of result.eligible) {
      const existing = [...claims.entries()].find(([, c]) => c.issuerId === issuer.id && c.row.email === row.email);
      if (existing) continue;
      const token = crypto.randomBytes(12).toString("hex");
      const otpSecret = generateSecret();
      claims.set(token, { issuerId: issuer.id, row, otpSecret, used: false });
      outbox.unshift({
        id: outbox.length + 1,
        issuerId: issuer.id,
        to: row.email,
        name: row.name,
        subject: `${issuer.short}: claim your FanPassport credential (${issuer.eventName})`,
        claimToken: token,
        link: `/claim.html?token=${token}`,
        mockPhone: String(row.phone).replace(/\d(?=\d{4})/g, "•"),
        mockPhoneSecret: otpSecret.toString("hex"),
        sentAt: new Date().toISOString(),
      });
    }
    res.json({
      issuerId: issuer.id,
      eligible: result.eligible.map((r) => ({ name: r.name, email: r.email })),
      rejected: result.rejected.map(({ row, reason }) => ({ id: row.order_id || row.ticket_id, name: row.name, email: row.email, reason })),
    });
  });

  app.get("/api/issuers/:id/credentials", wrap(async (req, res) => {
    const issuer = getIssuer(req, res);
    if (!issuer) return;
    const out = [];
    for (const c of issued.filter((x) => x.issuerId === issuer.id)) {
      const data = await credential.getCredential(c.tokenId);
      out.push({
        tokenId: c.tokenId, name: c.name, email: c.email, holder: c.holder, txHash: c.txHash,
        revoked: data.revoked, valid: await credential.isValid(c.tokenId), redeemedInD1: await gate.isRedeemed(drop.id, c.tokenId),
      });
    }
    res.json(out);
  }));

  app.post("/api/issuers/:id/revoke", wrap(async (req, res) => {
    const issuer = getIssuer(req, res);
    if (!issuer) return;
    const receipt = await (await credential.connect(issuer.signer).revoke(Number(req.body.tokenId))).wait();
    res.json({ txHash: receipt.hash, blockNumber: receipt.blockNumber });
  }));

  /** Seller upload list for a drop: codes only, no names (the seller's single-use rule is the soft gate). */
  app.post("/api/issuers/:id/upload-codes", wrap(async (req, res) => {
    const issuer = getIssuer(req, res);
    if (!issuer) return;
    const dropId = Number(req.body.dropId ?? drop.id);
    const codes = [];
    for (const c of issued.filter((x) => x.issuerId === issuer.id)) {
      if (!(await credential.isValid(c.tokenId))) continue;
      const code = presaleCode(issuer.masterKey, dropId, c.tokenId);
      if (!sellerCodes.has(code)) sellerCodes.set(code, { issuerId: issuer.id, dropId, used: false });
      codes.push(code);
    }
    res.json({ issuerId: issuer.id, dropId, count: codes.length, codes });
  }));

  // --------------------------------------------------------------- claim flow
  app.post("/api/claim/request", (req, res) => {
    const issuer = issuers[Number(req.body.issuerId)];
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!issuer) return res.status(404).json({ error: "unknown issuer" });
    const found = [...claims.values()].find((c) => c.issuerId === issuer.id && c.row.email.toLowerCase() === email);
    if (!found) return res.status(403).json({ error: `${email} is not on ${issuer.short}'s eligibility list` });
    res.json({ sent: true, message: `Claim link re-sent to ${email} (see the mock outbox)` });
  });

  app.get("/api/claim/:token", (req, res) => {
    const c = claims.get(req.params.token);
    if (!c) return res.status(404).json({ error: "unknown or expired claim link" });
    const issuer = issuers[c.issuerId];
    res.json({ issuerId: issuer.id, issuerShort: issuer.short, issuerName: issuer.name, eventName: issuer.eventName, credType: issuer.credType, name: c.row.name, email: c.row.email, used: c.used, tokenId: c.tokenId ?? null });
  });

  app.post("/api/claim/:token", wrap(async (req, res) => {
    const token = req.params.token;
    const c = claims.get(token);
    if (!c) return res.status(404).json({ error: "unknown or expired claim link" });
    if (c.used) return res.status(409).json({ error: "this claim link was already used" });
    if (!verifyTotp(c.otpSecret, req.body.otp)) return res.status(401).json({ error: "invalid or expired one-time code" });

    let holder;
    try {
      holder = ethers.getAddress(req.body.holder);
      if (ethers.verifyMessage(bindMessage(holder, token), req.body.signature) !== holder) throw new Error();
    } catch (_) {
      return res.status(400).json({ error: "wallet signature does not match the holder address" });
    }

    const issuer = issuers[c.issuerId];
    const att = {
      issuerId: issuer.id,
      credType: issuer.credType,
      eventId: issuer.eventId,
      identityCommitment: identityCommitment(issuer.identitySecret, c.row.name, c.row.phone),
      holder,
      deadline: nowSec() + 600,
    };
    const sig = await issuer.signer.signTypedData(domainFor(chainId, await credential.getAddress()), attestationTypes, att);
    let receipt;
    try {
      receipt = await (await credential.connect(relayer).mint(att, sig)).wait();
    } catch (err) {
      const reason = decodeError(err);
      return res.status(reason === "DuplicateCredential" ? 409 : 500).json({ error: reason || err.message });
    }
    const ev = receipt.logs.map((l) => { try { return credential.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === "CredentialIssued");
    const tokenId = Number(ev.args.tokenId);
    c.used = true;
    c.tokenId = tokenId;
    issued.push({ tokenId, issuerId: issuer.id, name: c.row.name, email: c.row.email, phone: c.row.phone, holder, txHash: receipt.hash });
    res.json({ tokenId, txHash: receipt.hash, blockNumber: receipt.blockNumber, issuerId: issuer.id, issuerShort: issuer.short, eventId: issuer.eventId, eventName: issuer.eventName, credType: issuer.credType, holder });
  }));

  /** Public, chain-only view of a credential (what any wallet or verifier can read). */
  app.get("/api/credentials/:tokenId", wrap(async (req, res) => {
    const tokenId = Number(req.params.tokenId);
    let owner;
    try {
      owner = await credential.ownerOf(tokenId);
    } catch (_) {
      return res.status(404).json({ error: "unknown credential" });
    }
    const data = await credential.getCredential(tokenId);
    const issuerId = Number(data.issuerId);
    res.json({
      tokenId, owner, issuerId, issuerShort: issuers[issuerId]?.short, credType: Number(data.credType), eventId: Number(data.eventId),
      identityCommitment: data.identityCommitment, issuedAt: Number(data.issuedAt), epoch: Number(data.epoch),
      revoked: data.revoked, valid: await credential.isValid(tokenId), locked: await credential.locked(tokenId), redeemedInD1: await gate.isRedeemed(drop.id, tokenId),
    });
  }));

  // ------------------------------------------------------- fan: presale code
  app.post("/api/wallet/code", wrap(async (req, res) => {
    const { tokenId, dropId, issuedAt, signature } = req.body;
    if (Math.abs(nowSec() - Number(issuedAt)) > 300) return res.status(401).json({ error: "stale request" });
    let owner;
    try {
      owner = await credential.ownerOf(Number(tokenId));
    } catch (_) {
      return res.status(404).json({ error: "unknown credential" });
    }
    let signer;
    try {
      signer = ethers.verifyMessage(codeRequestMessage(tokenId, dropId, issuedAt), signature);
    } catch (_) {
      return res.status(400).json({ error: "bad signature" });
    }
    if (signer !== owner) return res.status(403).json({ error: "only the holder can reveal this code" });
    const data = await credential.getCredential(Number(tokenId));
    const issuer = issuers[Number(data.issuerId)];
    res.json({ code: presaleCode(issuer.masterKey, Number(dropId), Number(tokenId)), dropId: Number(dropId), issuerShort: issuer.short });
  }));

  // --------------------------------------------------------------- mock seller
  app.post("/api/seller/redeem", (req, res) => {
    const code = String(req.body.code || "").trim().toUpperCase();
    const entry = sellerCodes.get(code);
    if (!entry) return res.json({ ok: false, reason: "unknown code" });
    if (entry.used) return res.json({ ok: false, reason: "code already used" });
    entry.used = true;
    entry.buyerName = req.body.buyerName || "";
    res.json({ ok: true, message: "Presale ticket reserved (mock seller)", dropId: entry.dropId, buyerName: entry.buyerName });
  });

  app.get("/api/seller/codes", (_req, res) => {
    res.json([...sellerCodes.entries()].map(([code, e]) => ({ code, issuerId: e.issuerId, dropId: e.dropId, used: e.used })));
  });

  // -------------------------------------------------------------------- doors
  function parsePayload(payload) {
    try {
      const p = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (!p || p.credentialId == null || p.dropId == null || p.issuedAt == null || !p.sig) return null;
      return { credentialId: BigInt(p.credentialId), dropId: BigInt(p.dropId), issuedAt: BigInt(p.issuedAt), sig: String(p.sig) };
    } catch (_) {
      return null;
    }
  }

  async function findRedemption(credentialId, dropId) {
    const logs = await gate.queryFilter(gate.filters.Redeemed(credentialId, dropId), 0);
    const last = logs[logs.length - 1];
    if (!last) return {};
    const doorEntry = Object.values(doors).find((d) => d.signer.address === last.args.door);
    return { priorTx: last.transactionHash, priorDoor: doorEntry ? doorEntry.name : last.args.door, priorBlock: last.blockNumber };
  }

  /**
   * The door's checks, in the order the app performs them: QR signature and freshness off-chain,
   * then chain state (redemption, revocation, issuer status, epoch, drop acceptance).
   */
  async function doorCheck(door, payload) {
    const steps = [];
    const fail = (reason, extra = {}) => ({ ok: false, reason, steps, ...extra });
    const p = parsePayload(payload);
    if (!p) return fail("MalformedQR");
    steps.push("QR parsed");

    const t = BigInt(nowSec());
    if (p.issuedAt > t + BigInt(MAX_CLOCK_SKEW) || t > p.issuedAt + BigInt(PROOF_TTL)) return fail("ProofExpired");
    steps.push(`QR fresh (signed ${Number(t - p.issuedAt)} s ago)`);

    let owner;
    try {
      owner = await credential.ownerOf(p.credentialId);
    } catch (_) {
      return fail("UnknownCredential");
    }
    let signer;
    try {
      signer = ethers.verifyTypedData(domainFor(chainId, await gate.getAddress()), holderProofTypes, { credentialId: p.credentialId, dropId: p.dropId, issuedAt: p.issuedAt }, p.sig);
    } catch (_) {
      return fail("BadHolderProof");
    }
    if (signer !== owner) return fail("BadHolderProof");
    steps.push("signed by the credential holder's key");

    const [dropExists] = await gate.getDrop(p.dropId);
    if (!dropExists) return fail("UnknownDrop");

    const data = await credential.getCredential(p.credentialId);
    const issuerId = Number(data.issuerId);
    const issuer = issuers[issuerId];
    const ownIssuer = issuerId === door.issuerId;
    const info = { credentialId: Number(p.credentialId), dropId: Number(p.dropId), issuerId, issuerShort: issuer?.short, credType: Number(data.credType), eventId: Number(data.eventId), holder: owner, ownIssuer };

    if (await gate.isRedeemed(p.dropId, p.credentialId)) return fail("AlreadyRedeemed", { ...info, ...(await findRedemption(p.credentialId, p.dropId)) });
    steps.push("not redeemed for this drop (chain)");
    if (data.revoked) return fail("Revoked", info);
    if (!(await registry.isActive(issuerId))) return fail("IssuerSuspended", info);
    if (Number(data.epoch) !== Number(await registry.epochOf(issuerId))) return fail("StaleEpoch", info);
    steps.push("not revoked, issuer active, current epoch (chain)");
    if (!(await gate.isAccepted(p.dropId, issuerId))) return fail("IssuerNotAccepted", info);
    steps.push(`issuer accepted by drop D${Number(p.dropId)} (chain)`);

    const result = { ok: true, steps, ...info };
    if (ownIssuer) {
      // Name comes from the issuer's authenticated backend, never from the chain - and only for its own credentials.
      const rec = issued.find((x) => x.tokenId === Number(p.credentialId));
      result.holderName = rec ? rec.name : "(no off-chain record)";
    }
    return result;
  }

  function getDoor(req, res) {
    const door = doors[Number(req.params.id)];
    if (!door) res.status(404).json({ error: "unknown door" });
    return door;
  }

  app.post("/api/doors/:id/check", wrap(async (req, res) => {
    const door = getDoor(req, res);
    if (!door) return;
    res.json(await doorCheck(door, req.body.payload));
  }));

  app.post("/api/doors/:id/redeem", wrap(async (req, res) => {
    const door = getDoor(req, res);
    if (!door) return;
    const p = parsePayload(req.body.payload);
    if (!p) return res.json({ admit: false, reason: "MalformedQR" });
    const tx = gate.connect(door.signer).redeem;
    const args = [p.credentialId, p.dropId, p.issuedAt, p.sig];

    if (!req.body.force) {
      const check = await doorCheck(door, req.body.payload);
      if (!check.ok) return res.json({ admit: false, ...check });
      if (check.ownIssuer && !req.body.idChecked) return res.status(400).json({ error: "ID check required: staff must match the holder name to an ID first" });
    } else {
      // Bypass the door's own checks to show that the contract itself enforces single use.
      try {
        await tx.staticCall(...args);
      } catch (err) {
        const reason = decodeError(err) || "Reverted";
        let revertedTx = null;
        try {
          const sent = await tx(...args, { gasLimit: 300000 });
          revertedTx = sent.hash;
          await sent.wait();
        } catch (e2) {
          revertedTx = revertedTx || e2?.receipt?.hash || e2?.transactionHash || e2?.data?.transactionHash || (await lastTxFrom(door.signer.address));
        }
        return res.json({ admit: false, reason, revertedTx, ...(await findRedemption(p.credentialId, p.dropId)) });
      }
    }

    // Admit only after the receipt shows success (a submission acknowledgement is a soft confirmation).
    try {
      const sent = await tx(...args);
      const receipt = await sent.wait();
      res.json({ admit: receipt.status === 1, receiptStatus: receipt.status, txHash: receipt.hash, blockNumber: receipt.blockNumber, door: door.name });
    } catch (err) {
      res.json({ admit: false, reason: decodeError(err) || err.shortMessage || "Reverted", ...(await findRedemption(p.credentialId, p.dropId)) });
    }
  }));

  async function lastTxFrom(address) {
    const block = await provider.getBlock("latest", true);
    const txs = block?.prefetchedTransactions || [];
    const t = txs.reverse().find((x) => x.from === address);
    return t ? t.hash : null;
  }

  // --------------------------------------------------------- demo utilities
  /** Non-transferability: simulate the holder calling transferFrom (eth_call, no gas needed). */
  app.post("/api/demo/transfer", wrap(async (req, res) => {
    const tokenId = Number(req.body.tokenId);
    const owner = await credential.ownerOf(tokenId);
    const data = credential.interface.encodeFunctionData("transferFrom", [owner, relayer.address, tokenId]);
    try {
      await provider.call({ from: owner, to: await credential.getAddress(), data });
      res.json({ reverted: false });
    } catch (err) {
      res.json({ reverted: true, error: decodeError(err) || err.shortMessage, from: owner });
    }
  }));

  return app;
}

module.exports = { createApp };
