// Found by the sandbox run: redemption state keyed by tokenId let a re-issued credential
// (epoch re-attestation or wallet-loss re-issue) enter the same drop twice.
// Single use must follow the credential's identity (issuer, event, commitment), not the token.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFanPassport, CRED_MERCH, ISSUER_B, DROP_D1 } = require("./fixture");

describe("Re-issuance cannot reset single use", function () {
  async function redeemedFixture() {
    const f = await deployFanPassport();
    const commitment = ethers.id("ana-merch");
    const first = await f.mintFor({ issuer: f.issuerB, issuerId: ISSUER_B, credType: CRED_MERCH, eventId: 200n, holder: f.fanAna.address, commitment });
    const p = await f.proofFor(f.fanAna, first.tokenId, DROP_D1);
    await f.gate.connect(f.door2).redeem(first.tokenId, DROP_D1, p.issuedAt, p.sig);
    return { ...f, commitment, oldId: first.tokenId };
  }

  it("a credential re-attested after an epoch bump stays redeemed for the drop", async function () {
    const { registry, credential, gate, issuerB, door2, fanAna, mintFor, proofFor, commitment, oldId } = await loadFixture(redeemedFixture);
    await registry.connect(issuerB).bumpEpoch(ISSUER_B);
    await credential.connect(issuerB).burn(oldId);
    const fresh = await mintFor({ issuer: issuerB, issuerId: ISSUER_B, credType: CRED_MERCH, eventId: 200n, holder: fanAna.address, commitment });
    expect(await gate.isRedeemed(DROP_D1, fresh.tokenId)).to.equal(true);
    const p = await proofFor(fanAna, fresh.tokenId, DROP_D1);
    await expect(gate.connect(door2).redeem(fresh.tokenId, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "AlreadyRedeemed");
  });

  it("a credential re-issued to a new wallet after loss stays redeemed for the drop", async function () {
    const { credential, gate, issuerB, door2, fanBruno, mintFor, proofFor, commitment, oldId } = await loadFixture(redeemedFixture);
    await credential.connect(issuerB).burn(oldId);
    const reissued = await mintFor({ issuer: issuerB, issuerId: ISSUER_B, credType: CRED_MERCH, eventId: 200n, holder: fanBruno.address, commitment });
    const p = await proofFor(fanBruno, reissued.tokenId, DROP_D1);
    await expect(gate.connect(door2).redeem(reissued.tokenId, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "AlreadyRedeemed");
  });

  it("the Redeemed event carries the identity key so doors can cite the original redemption", async function () {
    const { gate, credential, oldId } = await loadFixture(redeemedFixture);
    const logs = await gate.queryFilter(gate.filters.Redeemed(oldId, DROP_D1));
    const c = await credential.getCredential(oldId);
    const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "bytes32"], [c.issuerId, c.eventId, c.identityCommitment]));
    expect(logs[0].args.identityKey).to.equal(expected);
  });

  it("a different person's credential at the same event is unaffected", async function () {
    const { gate, issuerB, door2, fanBruno, mintFor, proofFor } = await loadFixture(redeemedFixture);
    const other = await mintFor({ issuer: issuerB, issuerId: ISSUER_B, credType: CRED_MERCH, eventId: 200n, holder: fanBruno.address, commitment: ethers.id("bruno-merch") });
    const p = await proofFor(fanBruno, other.tokenId, DROP_D1);
    await expect(gate.connect(door2).redeem(other.tokenId, DROP_D1, p.issuedAt, p.sig)).to.emit(gate, "Redeemed");
  });
});
