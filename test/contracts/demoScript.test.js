// Acceptance tests: Technical White Paper, Appendix A "Demo script (two issuers, two doors)".
// Each `describe` maps to one row of Table A. Written before the contracts (TDD).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deployFanPassport, signAttestation, now, CRED_ATTENDANCE, CRED_MERCH, ISSUER_A, ISSUER_B, DROP_D1 } = require("./fixture");

describe("Appendix A - demo script", function () {
  describe("Step 0 - Admin registers Issuer A and Issuer B, creates joint drop D1", function () {
    it("registers both issuers as active with epoch 1", async function () {
      const { registry, issuerA, issuerB } = await loadFixture(deployFanPassport);
      const a = await registry.getIssuer(ISSUER_A);
      const b = await registry.getIssuer(ISSUER_B);
      expect(a.key).to.equal(issuerA.address);
      expect(a.active).to.equal(true);
      expect(a.epoch).to.equal(1n);
      expect(b.key).to.equal(issuerB.address);
    });

    it("emits IssuerAdded and DropCreated", async function () {
      const { registry, gate, outsider } = await loadFixture(deployFanPassport);
      await expect(registry.addIssuer(3n, outsider.address, "Issuer C")).to.emit(registry, "IssuerAdded").withArgs(3n, outsider.address, "Issuer C");
      await expect(gate.createDrop(2n, [ISSUER_A])).to.emit(gate, "DropCreated").withArgs(2n, [ISSUER_A]);
    });

    it("D1 accepts credentials from both issuers", async function () {
      const { gate } = await loadFixture(deployFanPassport);
      expect(await gate.isAccepted(DROP_D1, ISSUER_A)).to.equal(true);
      expect(await gate.isAccepted(DROP_D1, ISSUER_B)).to.equal(true);
      expect(await gate.isAccepted(DROP_D1, 99n)).to.equal(false);
    });

    it("only the admin can register issuers or create drops (permissioned registry)", async function () {
      const { registry, gate, outsider } = await loadFixture(deployFanPassport);
      await expect(registry.connect(outsider).addIssuer(9n, outsider.address, "Rogue")).to.be.revertedWithCustomError(registry, "NotAdmin");
      await expect(gate.connect(outsider).createDrop(9n, [ISSUER_A])).to.be.revertedWithCustomError(gate, "NotAdmin");
    });

    it("rejects a duplicate issuer id and a duplicate drop id", async function () {
      const { registry, gate, outsider } = await loadFixture(deployFanPassport);
      await expect(registry.addIssuer(ISSUER_A, outsider.address, "dup")).to.be.revertedWithCustomError(registry, "IssuerExists");
      await expect(gate.createDrop(DROP_D1, [ISSUER_A])).to.be.revertedWithCustomError(gate, "DropExists");
    });
  });

  describe("Step 1 - Issuer A: attendance credential is minted from an issuer-signed attestation", function () {
    it("mints a credential to the fan, paid for by an untrusted relayer", async function () {
      const { credential, issuerA, fanAna, mintFor } = await loadFixture(deployFanPassport);
      const { tokenId } = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
      expect(await credential.ownerOf(tokenId)).to.equal(fanAna.address);
      const c = await credential.getCredential(tokenId);
      expect(c.issuerId).to.equal(ISSUER_A);
      expect(c.credType).to.equal(CRED_ATTENDANCE);
      expect(c.eventId).to.equal(100n);
      expect(c.epoch).to.equal(1n);
      expect(c.revoked).to.equal(false);
      expect(await credential.isValid(tokenId)).to.equal(true);
    });

    it("stores no personal data on-chain - only a commitment", async function () {
      const { credential, issuerA, fanAna, mintFor } = await loadFixture(deployFanPassport);
      const commitment = ethers.id("hmac(issuerSecret, 'ana souza|+5548999990001')");
      const { tokenId } = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address, commitment });
      expect((await credential.getCredential(tokenId)).identityCommitment).to.equal(commitment);
    });

    it("refuses an attestation not signed by the issuer's registered key", async function () {
      const { credential, outsider, fanAna, relayer } = await loadFixture(deployFanPassport);
      const att = { issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, identityCommitment: ethers.ZeroHash, holder: fanAna.address, deadline: (await now()) + 600n };
      const forged = await signAttestation(outsider, credential, att);
      await expect(credential.connect(relayer).mint(att, forged)).to.be.revertedWithCustomError(credential, "InvalidIssuerSignature");
    });

    it("refuses an attestation whose fields were tampered after signing", async function () {
      const { credential, issuerA, fanAna, outsider, relayer } = await loadFixture(deployFanPassport);
      const att = { issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, identityCommitment: ethers.ZeroHash, holder: fanAna.address, deadline: (await now()) + 600n };
      const sig = await signAttestation(issuerA, credential, att);
      await expect(credential.connect(relayer).mint({ ...att, holder: outsider.address }, sig)).to.be.revertedWithCustomError(credential, "InvalidIssuerSignature");
    });

    it("refuses an expired attestation", async function () {
      const { credential, issuerA, fanAna, relayer } = await loadFixture(deployFanPassport);
      const att = { issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, identityCommitment: ethers.ZeroHash, holder: fanAna.address, deadline: (await now()) - 1n };
      const sig = await signAttestation(issuerA, credential, att);
      await expect(credential.connect(relayer).mint(att, sig)).to.be.revertedWithCustomError(credential, "AttestationExpired");
    });

    it("issues at most one credential per identity per event", async function () {
      const { credential, issuerA, fanAna, fanBruno, mintFor } = await loadFixture(deployFanPassport);
      const commitment = ethers.id("same-person");
      await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address, commitment });
      await expect(
        mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanBruno.address, commitment })
      ).to.be.revertedWithCustomError(credential, "DuplicateCredential");
    });

    it("refuses issuance by a suspended issuer", async function () {
      const { registry, credential, issuerA, fanAna, mintFor } = await loadFixture(deployFanPassport);
      await registry.suspendIssuer(ISSUER_A);
      await expect(
        mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address })
      ).to.be.revertedWithCustomError(credential, "IssuerNotActive");
    });
  });

  describe("Step 2 - Issuer B: a second, independent issuer mints a merch credential", function () {
    it("the same fan holds one credential from each issuer, at distinct addresses", async function () {
      const { credential, issuerA, issuerB, mintFor } = await loadFixture(deployFanPassport);
      // One HD wallet in the PWA, a distinct address per issuer (Table 3, row 13)
      const hd = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, "m/44'/60'/0'/0");
      const anaForA = hd.deriveChild(Number(ISSUER_A));
      const anaForB = hd.deriveChild(Number(ISSUER_B));
      const a = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: anaForA.address });
      const b = await mintFor({ issuer: issuerB, issuerId: ISSUER_B, credType: CRED_MERCH, eventId: 200n, holder: anaForB.address });
      expect(anaForA.address).to.not.equal(anaForB.address);
      expect((await credential.getCredential(b.tokenId)).issuerId).to.equal(ISSUER_B);
      expect(await credential.ownerOf(a.tokenId)).to.equal(anaForA.address);
    });

    it("Issuer B cannot sign credentials on behalf of Issuer A", async function () {
      const { credential, issuerB, fanAna, relayer } = await loadFixture(deployFanPassport);
      const att = { issuerId: ISSUER_A, credType: CRED_MERCH, eventId: 200n, identityCommitment: ethers.ZeroHash, holder: fanAna.address, deadline: (await now()) + 600n };
      const sig = await signAttestation(issuerB, credential, att);
      await expect(credential.connect(relayer).mint(att, sig)).to.be.revertedWithCustomError(credential, "InvalidIssuerSignature");
    });
  });

  describe("Step 3 - Non-transferability (ERC-5192 locked token)", function () {
    async function mintedFixture() {
      const f = await deployFanPassport();
      const holder = f.fanAna.connect(ethers.provider);
      await f.admin.sendTransaction({ to: holder.address, value: ethers.parseEther("1") }); // only so the holder can *try* to transfer
      const { tokenId } = await f.mintFor({ issuer: f.issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: holder.address });
      return { ...f, holder, tokenId };
    }

    it("reports locked() == true and supports the ERC-5192 interface", async function () {
      const { credential, tokenId } = await loadFixture(mintedFixture);
      expect(await credential.locked(tokenId)).to.equal(true);
      expect(await credential.supportsInterface("0xb45a3c0e")).to.equal(true);
      expect(await credential.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
    });

    it("reverts transferFrom and safeTransferFrom", async function () {
      const { credential, holder, outsider, tokenId } = await loadFixture(mintedFixture);
      await expect(credential.connect(holder).transferFrom(holder.address, outsider.address, tokenId)).to.be.revertedWithCustomError(credential, "Soulbound");
      await expect(
        credential.connect(holder)["safeTransferFrom(address,address,uint256)"](holder.address, outsider.address, tokenId)
      ).to.be.revertedWithCustomError(credential, "Soulbound");
    });

    it("reverts approve and setApprovalForAll", async function () {
      const { credential, holder, outsider, tokenId } = await loadFixture(mintedFixture);
      await expect(credential.connect(holder).approve(outsider.address, tokenId)).to.be.revertedWithCustomError(credential, "Soulbound");
      await expect(credential.connect(holder).setApprovalForAll(outsider.address, true)).to.be.revertedWithCustomError(credential, "Soulbound");
    });

    it("emits Locked on mint", async function () {
      const { credential, issuerA, fanBruno, relayer } = await loadFixture(mintedFixture);
      const att = { issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, identityCommitment: ethers.id("bruno"), holder: fanBruno.address, deadline: (await now()) + 600n };
      const sig = await signAttestation(issuerA, credential, att);
      await expect(credential.connect(relayer).mint(att, sig)).to.emit(credential, "Locked");
    });
  });

  describe("Steps 4-6 - Two doors share redemption state on-chain", function () {
    async function walletFixture() {
      const f = await deployFanPassport();
      const credA = await f.mintFor({ issuer: f.issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: f.fanAna.address });
      const credB = await f.mintFor({ issuer: f.issuerB, issuerId: ISSUER_B, credType: CRED_MERCH, eventId: 200n, holder: f.fanBruno.address });
      return { ...f, credA: credA.tokenId, credB: credB.tokenId };
    }

    it("Step 4 - Door 1 redeems credential A with a fresh holder proof", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanAna, credA, DROP_D1);
      await expect(gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.emit(gate, "Redeemed").withArgs(credA, DROP_D1, door1.address, ISSUER_A, anyValue);
      expect(await gate.isRedeemed(DROP_D1, credA)).to.equal(true);
    });

    it("Step 5 - Door 2 (another issuer) rejects the same credential seconds later with AlreadyRedeemed", async function () {
      const { gate, door1, door2, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanAna, credA, DROP_D1);
      await gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig);
      // Same live QR (still fresh) presented at Door 2: rejected on shared state, not on freshness
      await expect(gate.connect(door2).redeem(credA, DROP_D1, p.issuedAt, p.sig))
        .to.be.revertedWithCustomError(gate, "AlreadyRedeemed")
        .withArgs(credA, DROP_D1);
    });

    it("Step 6 - Door 2 redeems the second issuer's credential independently", async function () {
      const { gate, door2, fanBruno, credB, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanBruno, credB, DROP_D1);
      await expect(gate.connect(door2).redeem(credB, DROP_D1, p.issuedAt, p.sig)).to.emit(gate, "Redeemed").withArgs(credB, DROP_D1, door2.address, ISSUER_B, anyValue);
    });

    it("a door may admit another issuer's credential if it is unredeemed (cross-issuer acceptance)", async function () {
      const { gate, door2, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanAna, credA, DROP_D1);
      await expect(gate.connect(door2).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.emit(gate, "Redeemed");
    });

    it("rejects a proof signed by someone other than the holder (screenshot / stolen code)", async function () {
      const { gate, door1, fanBruno, credA, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanBruno, credA, DROP_D1);
      await expect(gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "BadHolderProof");
    });

    it("rejects a proof signed for a different drop (no replay across drops)", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      await gate.createDrop(2n, [ISSUER_A]);
      const p = await proofFor(fanAna, credA, 2n);
      await expect(gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "BadHolderProof");
    });

    it("rejects redemption from an address that is not a registered door", async function () {
      const { gate, outsider, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanAna, credA, DROP_D1);
      await expect(gate.connect(outsider).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "NotADoor");
    });

    it("rejects a credential whose issuer is not accepted by the drop", async function () {
      const { gate, door1, fanBruno, credB, proofFor } = await loadFixture(walletFixture);
      await gate.createDrop(3n, [ISSUER_A]); // only Issuer A
      const p = await proofFor(fanBruno, credB, 3n);
      await expect(gate.connect(door1).redeem(credB, 3n, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "IssuerNotAccepted");
    });

    it("rejects an unknown drop", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      const p = await proofFor(fanAna, credA, 42n);
      await expect(gate.connect(door1).redeem(credA, 42n, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "UnknownDrop");
    });

    it("the same credential can be redeemed once per drop (separate drops are independent)", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(walletFixture);
      await gate.createDrop(2n, [ISSUER_A]);
      const p1 = await proofFor(fanAna, credA, DROP_D1);
      const p2 = await proofFor(fanAna, credA, 2n);
      await gate.connect(door1).redeem(credA, DROP_D1, p1.issuedAt, p1.sig);
      await expect(gate.connect(door1).redeem(credA, 2n, p2.issuedAt, p2.sig)).to.emit(gate, "Redeemed");
    });
  });

  describe("Step 7 - Re-scan, revocation and expired QR are rejected", function () {
    async function step7Fixture() {
      const f = await deployFanPassport();
      const credA = await f.mintFor({ issuer: f.issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: f.fanAna.address });
      const credA2 = await f.mintFor({ issuer: f.issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: f.fanBruno.address });
      return { ...f, credA: credA.tokenId, credA2: credA2.tokenId };
    }

    it("a re-scan of A at Door 1 is rejected", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(step7Fixture);
      const p = await proofFor(fanAna, credA, DROP_D1);
      await gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig);
      const p2 = await proofFor(fanAna, credA, DROP_D1);
      await expect(gate.connect(door1).redeem(credA, DROP_D1, p2.issuedAt, p2.sig)).to.be.revertedWithCustomError(gate, "AlreadyRedeemed");
    });

    it("Issuer A revokes A2 (refund) and its scan is rejected", async function () {
      const { credential, gate, issuerA, door1, fanBruno, credA2, proofFor } = await loadFixture(step7Fixture);
      await expect(credential.connect(issuerA).revoke(credA2)).to.emit(credential, "CredentialRevoked").withArgs(credA2, issuerA.address);
      expect(await credential.isValid(credA2)).to.equal(false);
      const p = await proofFor(fanBruno, credA2, DROP_D1);
      await expect(gate.connect(door1).redeem(credA2, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "CredentialNotValid");
    });

    it("only the issuing issuer (or admin) can revoke", async function () {
      const { credential, issuerB, admin, credA2 } = await loadFixture(step7Fixture);
      await expect(credential.connect(issuerB).revoke(credA2)).to.be.revertedWithCustomError(credential, "NotAuthorized");
      await expect(credential.connect(admin).revoke(credA2)).to.emit(credential, "CredentialRevoked");
    });

    it("an expired QR (proof older than 60 s) is rejected", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(step7Fixture);
      const p = await proofFor(fanAna, credA, DROP_D1);
      await time.increase(61);
      await expect(gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "ProofExpired");
    });

    it("a proof dated in the future (beyond clock skew) is rejected", async function () {
      const { gate, door1, fanAna, credA, proofFor } = await loadFixture(step7Fixture);
      const p = await proofFor(fanAna, credA, DROP_D1, (await now()) + 300n);
      await expect(gate.connect(door1).redeem(credA, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "ProofExpired");
    });
  });
});
