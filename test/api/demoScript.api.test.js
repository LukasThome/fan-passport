// End-to-end acceptance test: the Appendix A demo script driven through the HTTP API that the
// web front-ends (issuer portal, claim page, fan PWA, two doors, mock seller) use.
const { expect } = require("chai");
const request = require("supertest");
const { ethers } = require("hardhat");
const { createSystem } = require("../../src/system");
const { createApp } = require("../../src/app");
const { holderProofTypes, domainFor } = require("../../lib/eip712");
const { totp } = require("../../lib/totp");

const MNEMONIC_ANA = "test test test test test test test test test test test junk";
const MNEMONIC_BRUNO = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** The fan's PWA: one HD wallet, a distinct address per issuer (Table 3, row 13). */
function pwa(mnemonic) {
  const root = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0");
  return { forIssuer: (issuerId) => root.deriveChild(Number(issuerId)) };
}

describe("API - Appendix A demo script end to end", function () {
  let system, app, state;
  const ana = pwa(MNEMONIC_ANA);
  const bruno = pwa(MNEMONIC_BRUNO);
  const creds = {};

  async function claimAs(issuerId, email, wallet) {
    const outbox = (await request(app).get("/api/outbox")).body;
    const mail = outbox.find((m) => m.to === email && m.issuerId === issuerId);
    expect(mail, `invite for ${email}`).to.exist;
    const token = mail.claimToken;
    const otp = totp(Buffer.from(mail.mockPhoneSecret, "hex"));
    const holder = wallet.address;
    const signature = await wallet.signMessage(`FanPassport: bind ${holder} to claim ${token}`);
    return request(app).post(`/api/claim/${token}`).send({ otp, holder, signature });
  }

  async function qr(wallet, credentialId, dropId = 1, issuedAt = Math.floor(Date.now() / 1000)) {
    const domain = domainFor(state.chainId, state.contracts.RedemptionGate);
    const value = { credentialId: String(credentialId), dropId: String(dropId), issuedAt: String(issuedAt) };
    const sig = await wallet.signTypedData(domain, holderProofTypes, value);
    return JSON.stringify({ ...value, sig });
  }

  before(async function () {
    system = await createSystem(ethers);
    app = createApp(system);
    state = (await request(app).get("/api/state")).body;
  });

  it("Step 0 - state shows two active issuers, two doors and joint drop D1 on-chain", async function () {
    expect(state.issuers.map((i) => i.id)).to.deep.equal([1, 2]);
    expect(state.issuers.every((i) => i.active)).to.equal(true);
    expect(state.doors.map((d) => d.issuerId)).to.deep.equal([1, 2]);
    expect(state.drop).to.deep.include({ id: 1, acceptedIssuers: [1, 2] });
    const events = (await request(app).get("/api/events")).body.map((e) => e.name);
    expect(events).to.include.members(["IssuerAdded", "DropCreated", "DoorAdded"]);
  });

  describe("Step 1 - Issuer A uploads attendance CSV; fan claims", function () {
    it("applies the rules and reports eligible and rejected rows", async function () {
      const csv = (await request(app).get("/api/issuers/1/sample")).text;
      const res = await request(app).post("/api/issuers/1/upload").send({ csv });
      expect(res.status).to.equal(200);
      expect(res.body.eligible.map((r) => r.email)).to.include.members(["ana@example.com", "bruno@example.com"]);
      expect(res.body.rejected.map((r) => r.reason)).to.include("not checked in");
    });

    it("a non-listed email is refused", async function () {
      const res = await request(app).post("/api/claim/request").send({ issuerId: 1, email: "mallory@example.com" });
      expect(res.status).to.equal(403);
    });

    it("a wrong OTP is refused", async function () {
      const outbox = (await request(app).get("/api/outbox")).body;
      const mail = outbox.find((m) => m.to === "ana@example.com" && m.issuerId === 1);
      const w = ana.forIssuer(1);
      const signature = await w.signMessage(`FanPassport: bind ${w.address} to claim ${mail.claimToken}`);
      const res = await request(app).post(`/api/claim/${mail.claimToken}`).send({ otp: "000000", holder: w.address, signature });
      expect(res.status).to.equal(401);
    });

    it("a wallet signature from another key is refused", async function () {
      const outbox = (await request(app).get("/api/outbox")).body;
      const mail = outbox.find((m) => m.to === "ana@example.com" && m.issuerId === 1);
      const otp = totp(Buffer.from(mail.mockPhoneSecret, "hex"));
      const signature = await bruno.forIssuer(1).signMessage(`FanPassport: bind ${ana.forIssuer(1).address} to claim ${mail.claimToken}`);
      const res = await request(app).post(`/api/claim/${mail.claimToken}`).send({ otp, holder: ana.forIssuer(1).address, signature });
      expect(res.status).to.equal(400);
    });

    it("Ana claims (OTP + wallet signature) and the relayer mints credential A", async function () {
      const res = await claimAs(1, "ana@example.com", ana.forIssuer(1));
      expect(res.status).to.equal(200);
      expect(res.body.txHash).to.match(/^0x[0-9a-f]{64}$/);
      creds.A = res.body.tokenId;
      expect(await system.contracts.credential.ownerOf(creds.A)).to.equal(ana.forIssuer(1).address);
    });

    it("the same claim link cannot be used twice", async function () {
      const res = await claimAs(1, "ana@example.com", ana.forIssuer(1));
      expect(res.status).to.equal(409);
    });

    it("Bruno claims credential A2", async function () {
      const res = await claimAs(1, "bruno@example.com", bruno.forIssuer(1));
      expect(res.status).to.equal(200);
      creds.A2 = res.body.tokenId;
    });
  });

  describe("Step 2 - Issuer B uploads merch CSV; a row below the minimum is rejected; fan claims", function () {
    it("rejects the order below the minimum value", async function () {
      const csv = (await request(app).get("/api/issuers/2/sample")).text;
      const res = await request(app).post("/api/issuers/2/upload").send({ csv });
      expect(res.body.rejected.map((r) => r.reason)).to.include("below minimum value ($15)");
      expect(res.body.eligible.map((r) => r.email)).to.include("ana@example.com");
    });

    it("Ana claims credential B with a different address derived for Issuer B", async function () {
      const res = await claimAs(2, "ana@example.com", ana.forIssuer(2));
      expect(res.status).to.equal(200);
      creds.B = res.body.tokenId;
      expect(await system.contracts.credential.ownerOf(creds.B)).to.equal(ana.forIssuer(2).address);
    });
  });

  describe("Step 3 - Non-transferability", function () {
    it("a transfer attempt reverts with Soulbound", async function () {
      const res = await request(app).post("/api/demo/transfer").send({ tokenId: creds.A });
      expect(res.body).to.deep.include({ reverted: true, error: "Soulbound" });
    });
  });

  describe("Presale code (soft gate at the seller)", function () {
    it("the fan reveals her own code after signing in with her holder key", async function () {
      const w = ana.forIssuer(1);
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await w.signMessage(`FanPassport code request ${creds.A} 1 ${issuedAt}`);
      const res = await request(app).post("/api/wallet/code").send({ tokenId: creds.A, dropId: 1, issuedAt, signature });
      expect(res.status).to.equal(200);
      expect(res.body.code).to.match(/^[A-Z2-7]{8}$/);
      creds.codeA = res.body.code;
    });

    it("someone else cannot reveal Ana's code", async function () {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await bruno.forIssuer(1).signMessage(`FanPassport code request ${creds.A} 1 ${issuedAt}`);
      const res = await request(app).post("/api/wallet/code").send({ tokenId: creds.A, dropId: 1, issuedAt, signature });
      expect(res.status).to.equal(403);
    });

    it("the issuer uploads the code list to the seller; the code works once", async function () {
      const up = await request(app).post("/api/issuers/1/upload-codes").send({ dropId: 1 });
      expect(up.body.count).to.be.greaterThan(0);
      expect(up.body.codes).to.include(creds.codeA);
      const first = await request(app).post("/api/seller/redeem").send({ code: creds.codeA, buyerName: "Ana Souza" });
      expect(first.body.ok).to.equal(true);
      const second = await request(app).post("/api/seller/redeem").send({ code: creds.codeA, buyerName: "Ana Souza" });
      expect(second.body).to.deep.include({ ok: false, reason: "code already used" });
      const bogus = await request(app).post("/api/seller/redeem").send({ code: "AAAAAAAA", buyerName: "Bot" });
      expect(bogus.body).to.deep.include({ ok: false, reason: "unknown code" });
    });
  });

  describe("Step 4 - Door 1 admits credential A after the success receipt", function () {
    it("check: valid, own issuer, returns holder name for the ID check", async function () {
      creds.liveQrA = await qr(ana.forIssuer(1), creds.A);
      const res = await request(app).post("/api/doors/1/check").send({ payload: creds.liveQrA });
      expect(res.body).to.deep.include({ ok: true, ownIssuer: true, holderName: "Ana Souza" });
    });

    it("redeem without the staff ID check is refused for the door's own issuer", async function () {
      const res = await request(app).post("/api/doors/1/redeem").send({ payload: creds.liveQrA });
      expect(res.status).to.equal(400);
    });

    it("redeem: ADMIT with tx hash once the receipt shows success", async function () {
      const res = await request(app).post("/api/doors/1/redeem").send({ payload: creds.liveQrA, idChecked: true });
      expect(res.body.admit).to.equal(true);
      expect(res.body.receiptStatus).to.equal(1);
      creds.door1Tx = res.body.txHash;
    });
  });

  describe("Step 5 - Door 2 (Issuer B) rejects credential A on AlreadyRedeemed, citing Door 1's tx", function () {
    it("check reads the shared chain state, with no name check", async function () {
      const res = await request(app).post("/api/doors/2/check").send({ payload: creds.liveQrA });
      expect(res.body).to.deep.include({ ok: false, reason: "AlreadyRedeemed", ownIssuer: false, priorTx: creds.door1Tx });
      expect(res.body.holderName).to.equal(undefined);
    });

    it("even if the door forces the transaction, the contract reverts it", async function () {
      const res = await request(app).post("/api/doors/2/redeem").send({ payload: creds.liveQrA, force: true });
      expect(res.body).to.deep.include({ admit: false, reason: "AlreadyRedeemed" });
      expect(res.body.revertedTx).to.match(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("Step 6 - Door 2 admits credential B (its own issuer)", function () {
    it("name-checks against Issuer B's record and admits", async function () {
      const payload = await qr(ana.forIssuer(2), creds.B);
      const check = await request(app).post("/api/doors/2/check").send({ payload });
      expect(check.body).to.deep.include({ ok: true, ownIssuer: true, holderName: "Ana Souza" });
      const res = await request(app).post("/api/doors/2/redeem").send({ payload, idChecked: true });
      expect(res.body.admit).to.equal(true);
    });
  });

  describe("Step 7 - re-scan, revocation and expired QR are rejected", function () {
    it("a re-scan of A is rejected", async function () {
      const res = await request(app).post("/api/doors/1/check").send({ payload: await qr(ana.forIssuer(1), creds.A) });
      expect(res.body).to.deep.include({ ok: false, reason: "AlreadyRedeemed" });
    });

    it("Issuer A revokes A2 (refund) and its scan is rejected", async function () {
      const rev = await request(app).post("/api/issuers/1/revoke").send({ tokenId: creds.A2 });
      expect(rev.body.txHash).to.match(/^0x/);
      const res = await request(app).post("/api/doors/1/check").send({ payload: await qr(bruno.forIssuer(1), creds.A2) });
      expect(res.body).to.deep.include({ ok: false, reason: "Revoked" });
    });

    it("an expired QR is rejected", async function () {
      const old = Math.floor(Date.now() / 1000) - 120;
      const res = await request(app).post("/api/doors/1/check").send({ payload: await qr(bruno.forIssuer(1), creds.A2, 1, old) });
      expect(res.body).to.deep.include({ ok: false, reason: "ProofExpired" });
    });

    it("a QR signed by someone who is not the holder is rejected", async function () {
      const res = await request(app).post("/api/doors/1/check").send({ payload: await qr(bruno.forIssuer(1), creds.B) });
      expect(res.body).to.deep.include({ ok: false, reason: "BadHolderProof" });
    });

    it("a malformed QR is rejected", async function () {
      const res = await request(app).post("/api/doors/1/check").send({ payload: "not json" });
      expect(res.body).to.deep.include({ ok: false, reason: "MalformedQR" });
    });
  });

  describe("Audit trail", function () {
    it("the issuer portal lists credentials with their on-chain status", async function () {
      const list = (await request(app).get("/api/issuers/1/credentials")).body;
      const a = list.find((c) => c.tokenId === creds.A);
      const a2 = list.find((c) => c.tokenId === creds.A2);
      expect(a).to.deep.include({ valid: true, redeemedInD1: true, name: "Ana Souza" });
      expect(a2).to.deep.include({ valid: false, revoked: true });
    });

    it("the event log contains mints, redemptions and the revocation", async function () {
      const names = (await request(app).get("/api/events")).body.map((e) => e.name);
      expect(names).to.include.members(["CredentialIssued", "Redeemed", "CredentialRevoked"]);
    });

    it("the public credential status (used by the fan wallet) comes from the chain and holds no personal data", async function () {
      const res = await request(app).get(`/api/credentials/${creds.A2}`);
      expect(res.body).to.deep.include({ tokenId: creds.A2, issuerId: 1, valid: false, revoked: true, redeemedInD1: false });
      expect(JSON.stringify(res.body).toLowerCase()).to.not.include("bruno");
      expect((await request(app).get("/api/credentials/9999")).status).to.equal(404);
    });

    it("no personal data appears in any on-chain event", async function () {
      const blob = JSON.stringify((await request(app).get("/api/events")).body).toLowerCase();
      for (const pii of ["ana souza", "souza", "example.com", "+5548"]) expect(blob).to.not.include(pii);
    });
  });
});
