// "Evaluate" (course objective): what the chain costs, measured from this run's own receipts,
// against the white paper's worksheet (section 5.2) - and the issuer-compromise lifecycle (section 4.2).
const { expect } = require("chai");
const request = require("supertest");
const { ethers } = require("hardhat");
const { createSystem } = require("../../src/system");
const { createApp } = require("../../src/app");
const { holderProofTypes, domainFor, bindMessage } = require("../../lib/eip712");
const { totp } = require("../../lib/totp");

const root = (m) => ethers.HDNodeWallet.fromPhrase(m, undefined, "m/44'/60'/0'/0");
const ana = root("test test test test test test test test test test test junk");

describe("API - Evaluate: measured costs and issuer compromise", function () {
  let app, state;
  const ids = {};

  async function claim(issuerId, email, wallet) {
    const mail = (await request(app).get("/api/outbox")).body.find((m) => m.to === email && m.issuerId === issuerId);
    const signature = await wallet.signMessage(bindMessage(wallet.address, mail.claimToken));
    const res = await request(app).post(`/api/claim/${mail.claimToken}`).send({ otp: totp(Buffer.from(mail.mockPhoneSecret, "hex")), holder: wallet.address, signature });
    return res.body;
  }
  async function qr(wallet, credentialId) {
    const v = { credentialId: String(credentialId), dropId: "1", issuedAt: String(Math.floor(Date.now() / 1000)) };
    return JSON.stringify({ ...v, sig: await wallet.signTypedData(domainFor(state.chainId, state.contracts.RedemptionGate), holderProofTypes, v) });
  }

  before(async function () {
    app = createApp(await createSystem(ethers));
    state = (await request(app).get("/api/state")).body;
  });

  describe("GET /api/costs", function () {
    it("starts with no measurements and carries the white paper's worksheet", async function () {
      const c = (await request(app).get("/api/costs")).body;
      expect(c.measured.mint.count).to.equal(0);
      expect(c.measured.redeem.count).to.equal(0);
      expect(c.referenceDrop).to.deep.equal({ mints: 1500, redemptions: 1000 });
      expect(c.whitePaper).to.deep.include({ perTxCeilingUsd: 0.02, designC: 276.5 });
      expect(c.whitePaper.designA).to.deep.equal({ min: 225, max: 229 });
    });

    it("measures gasUsed from the receipts of real mints and redemptions", async function () {
      for (const id of [1, 2]) {
        const csv = (await request(app).get(`/api/issuers/${id}/sample`)).text;
        await request(app).post(`/api/issuers/${id}/upload`).send({ csv });
      }
      ids.A = (await claim(1, "ana@example.com", ana.deriveChild(1))).tokenId;
      ids.B = (await claim(2, "ana@example.com", ana.deriveChild(2))).tokenId;
      const r = await request(app).post("/api/doors/1/redeem").send({ payload: await qr(ana.deriveChild(1), ids.A), idChecked: true });
      expect(r.body.admit).to.equal(true);

      const c = (await request(app).get("/api/costs")).body;
      expect(c.measured.mint.count).to.equal(2);
      expect(c.measured.mint.avgGas).to.be.within(100000, 400000);
      expect(c.measured.redeem.count).to.equal(1);
      expect(c.measured.redeem.avgGas).to.be.within(40000, 150000);
      expect(c.referenceDropGas).to.equal(1500 * c.measured.mint.avgGas + 1000 * c.measured.redeem.avgGas);
    });

    it("counts revocations too", async function () {
      // A reverted (forced) redemption is not counted as a redemption
      const forced = await request(app).post("/api/doors/2/redeem").send({ payload: await qr(ana.deriveChild(1), ids.A), force: true });
      expect(forced.body.admit).to.equal(false);
      const c = (await request(app).get("/api/costs")).body;
      expect(c.measured.redeem.count).to.equal(1);
    });
  });

  describe("Issuer compromise (white paper 4.2): suspend, epoch bump, re-attest", function () {
    it("the admin suspends Issuer B and every door rejects its credentials", async function () {
      const res = await request(app).post("/api/admin/issuers/2/suspend");
      expect(res.body.txHash).to.match(/^0x/);
      const check = await request(app).post("/api/doors/2/check").send({ payload: await qr(ana.deriveChild(2), ids.B) });
      expect(check.body).to.deep.include({ ok: false, reason: "IssuerSuspended" });
    });

    it("the admin reactivates Issuer B", async function () {
      await request(app).post("/api/admin/issuers/2/reactivate");
      const check = await request(app).post("/api/doors/2/check").send({ payload: await qr(ana.deriveChild(2), ids.B) });
      expect(check.body.ok).to.equal(true);
    });

    it("an epoch bump invalidates all of Issuer B's credentials in one transaction", async function () {
      const res = await request(app).post("/api/issuers/2/bump-epoch");
      expect(res.body.epoch).to.equal(2);
      const check = await request(app).post("/api/doors/2/check").send({ payload: await qr(ana.deriveChild(2), ids.B) });
      expect(check.body).to.deep.include({ ok: false, reason: "StaleEpoch" });
      expect((await request(app).get(`/api/credentials/${ids.B}`)).body.valid).to.equal(false);
    });

    it("the issuer re-attests the genuine credential under the new epoch", async function () {
      const res = await request(app).post("/api/issuers/2/reattest").send({ tokenId: ids.B });
      expect(res.status).to.equal(200);
      expect(res.body.oldTokenId).to.equal(ids.B);
      expect(res.body.tokenId).to.not.equal(ids.B);
      const fresh = (await request(app).get(`/api/credentials/${res.body.tokenId}`)).body;
      expect(fresh).to.deep.include({ valid: true, epoch: 2, owner: ana.deriveChild(2).address });
      expect((await request(app).get(`/api/credentials/${ids.B}`)).status).to.equal(404);
      const check = await request(app).post("/api/doors/2/check").send({ payload: await qr(ana.deriveChild(2), res.body.tokenId) });
      expect(check.body).to.deep.include({ ok: true, holderName: "Ana Souza" });
    });

    it("only known issuers can be suspended", async function () {
      expect((await request(app).post("/api/admin/issuers/9/suspend")).status).to.equal(404);
    });
  });
});
