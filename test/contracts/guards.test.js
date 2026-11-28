// Guard clauses: every input the contracts refuse, so branch coverage reflects real checks.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFanPassport, CRED_ATTENDANCE, ISSUER_A, ISSUER_B, DROP_D1 } = require("./fixture");

const ZERO = ethers.ZeroAddress;

describe("Guards - inputs the contracts refuse", function () {
  describe("IssuerRegistry", function () {
    it("refuses a zero admin at deployment", async function () {
      const Registry = await ethers.getContractFactory("IssuerRegistry");
      await expect(Registry.deploy(ZERO)).to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });

    it("refuses issuer id 0 and a zero signing key", async function () {
      const { registry, outsider } = await loadFixture(deployFanPassport);
      await expect(registry.addIssuer(0n, outsider.address, "x")).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(registry.addIssuer(5n, ZERO, "x")).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("refuses suspend, reactivate and epoch bump for an unknown issuer", async function () {
      const { registry } = await loadFixture(deployFanPassport);
      await expect(registry.suspendIssuer(42n)).to.be.revertedWithCustomError(registry, "UnknownIssuer");
      await expect(registry.reactivateIssuer(42n)).to.be.revertedWithCustomError(registry, "UnknownIssuer");
      await expect(registry.bumpEpoch(42n)).to.be.revertedWithCustomError(registry, "UnknownIssuer");
    });

    it("reactivates a suspended issuer", async function () {
      const { registry } = await loadFixture(deployFanPassport);
      await registry.suspendIssuer(ISSUER_A);
      await expect(registry.reactivateIssuer(ISSUER_A)).to.emit(registry, "IssuerReactivated").withArgs(ISSUER_A);
      expect(await registry.isActive(ISSUER_A)).to.equal(true);
    });

    it("refuses zero addresses for admin handover, key rotation and doors", async function () {
      const { registry } = await loadFixture(deployFanPassport);
      await expect(registry.transferAdmin(ZERO)).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(registry.proposeKeyRotation(ISSUER_A, ZERO)).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(registry.addDoor(ZERO, ISSUER_A)).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("only the admin hands over the admin role", async function () {
      const { registry, outsider } = await loadFixture(deployFanPassport);
      await expect(registry.connect(outsider).transferAdmin(outsider.address)).to.be.revertedWithCustomError(registry, "NotAdmin");
    });

    it("exposes the registered issuers", async function () {
      const { registry, issuerB } = await loadFixture(deployFanPassport);
      expect(await registry.issuerCount()).to.equal(2n);
      expect(await registry.issuerIds(1)).to.equal(ISSUER_B);
      expect(await registry.keyOf(ISSUER_B)).to.equal(issuerB.address);
    });
  });

  describe("FanCredential", function () {
    it("refuses revoke, burn and locked() for a token that does not exist", async function () {
      const { credential } = await loadFixture(deployFanPassport);
      await expect(credential.revoke(999n)).to.be.revertedWithCustomError(credential, "UnknownCredential");
      await expect(credential.burn(999n)).to.be.revertedWithCustomError(credential, "UnknownCredential");
      await expect(credential.locked(999n)).to.be.revertedWithCustomError(credential, "ERC721NonexistentToken");
      expect(await credential.isValid(999n)).to.equal(false);
    });

    it("only the issuing issuer or the admin can burn", async function () {
      const { credential, issuerA, issuerB, fanAna, mintFor } = await loadFixture(deployFanPassport);
      const { tokenId } = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
      await expect(credential.connect(issuerB).burn(tokenId)).to.be.revertedWithCustomError(credential, "NotAuthorized");
      await expect(credential.burn(tokenId)).to.emit(credential, "CredentialBurned");
    });

    it("a burned credential frees its identity slot for re-issuance (wallet loss)", async function () {
      const { credential, issuerA, fanAna, fanBruno, mintFor } = await loadFixture(deployFanPassport);
      const commitment = ethers.id("lost-wallet");
      const first = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address, commitment });
      await credential.connect(issuerA).burn(first.tokenId);
      const again = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanBruno.address, commitment });
      expect(await credential.ownerOf(again.tokenId)).to.equal(fanBruno.address);
    });

    it("reports no ERC-5192 support for unrelated interfaces", async function () {
      const { credential } = await loadFixture(deployFanPassport);
      expect(await credential.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("RedemptionGate", function () {
    it("exposes a drop and its accepted issuers", async function () {
      const { gate } = await loadFixture(deployFanPassport);
      const [exists, accepted] = await gate.getDrop(DROP_D1);
      expect(exists).to.equal(true);
      expect(accepted).to.deep.equal([ISSUER_A, ISSUER_B]);
      const [missing] = await gate.getDrop(77n);
      expect(missing).to.equal(false);
    });

    it("refuses a door whose own issuer is not part of the drop", async function () {
      const { gate, door2, fanAna, issuerA, mintFor, proofFor } = await loadFixture(deployFanPassport);
      await gate.createDrop(5n, [ISSUER_A]); // Door 2 belongs to Issuer B
      const { tokenId } = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
      const p = await proofFor(fanAna, tokenId, 5n);
      await expect(gate.connect(door2).redeem(tokenId, 5n, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "NotADoor");
    });

    it("refuses a malformed holder signature", async function () {
      const { gate, door1, fanAna, issuerA, mintFor } = await loadFixture(deployFanPassport);
      const { tokenId } = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
      const t = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      await expect(gate.connect(door1).redeem(tokenId, DROP_D1, t, "0x1234")).to.be.revertedWithCustomError(gate, "BadHolderProof");
    });
  });
});
