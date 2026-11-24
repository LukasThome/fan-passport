// Section 4.2 of the technical white paper: issuer lifecycle (compromise, epoch recovery, key rotation).
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFanPassport, CRED_ATTENDANCE, ISSUER_A, ISSUER_B, DROP_D1 } = require("./fixture");

describe("IssuerRegistry - compromise, epochs and key rotation", function () {
  it("suspending an issuer makes all its credentials invalid at every door", async function () {
    const { registry, credential, gate, issuerA, door2, fanAna, mintFor, proofFor } = await loadFixture(deployFanPassport);
    const { tokenId } = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
    await expect(registry.suspendIssuer(ISSUER_A)).to.emit(registry, "IssuerSuspended").withArgs(ISSUER_A);
    expect(await credential.isValid(tokenId)).to.equal(false);
    const p = await proofFor(fanAna, tokenId, DROP_D1);
    await expect(gate.connect(door2).redeem(tokenId, DROP_D1, p.issuedAt, p.sig)).to.be.revertedWithCustomError(gate, "CredentialNotValid");
  });

  it("an epoch bump invalidates every existing credential in one transaction; re-attested ones are valid", async function () {
    const { registry, credential, issuerA, fanAna, mintFor } = await loadFixture(deployFanPassport);
    const old = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
    await expect(registry.connect(issuerA).bumpEpoch(ISSUER_A)).to.emit(registry, "EpochBumped").withArgs(ISSUER_A, 2n);
    expect(await credential.isValid(old.tokenId)).to.equal(false);
    // issuer re-attests the genuine one (burn old, mint new under epoch 2)
    await credential.connect(issuerA).burn(old.tokenId);
    const fresh = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
    expect((await credential.getCredential(fresh.tokenId)).epoch).to.equal(2n);
    expect(await credential.isValid(fresh.tokenId)).to.equal(true);
  });

  it("another issuer cannot bump my epoch or suspend me", async function () {
    const { registry, issuerB } = await loadFixture(deployFanPassport);
    await expect(registry.connect(issuerB).bumpEpoch(ISSUER_A)).to.be.revertedWithCustomError(registry, "NotAuthorized");
    await expect(registry.connect(issuerB).suspendIssuer(ISSUER_A)).to.be.revertedWithCustomError(registry, "NotAdmin");
  });

  it("key rotation takes effect only after a 24-hour timelock; existing credentials stay valid", async function () {
    const { registry, credential, issuerA, outsider, fanAna, mintFor } = await loadFixture(deployFanPassport);
    const before = await mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 100n, holder: fanAna.address });
    await expect(registry.connect(issuerA).proposeKeyRotation(ISSUER_A, outsider.address)).to.emit(registry, "KeyRotationProposed");
    await expect(registry.executeKeyRotation(ISSUER_A)).to.be.revertedWithCustomError(registry, "TimelockActive");
    await time.increase(24 * 3600);
    await expect(registry.executeKeyRotation(ISSUER_A)).to.emit(registry, "KeyRotated").withArgs(ISSUER_A, outsider.address);
    expect((await registry.getIssuer(ISSUER_A)).key).to.equal(outsider.address);
    expect(await credential.isValid(before.tokenId)).to.equal(true);
    // the old key can no longer issue
    await expect(
      mintFor({ issuer: issuerA, issuerId: ISSUER_A, credType: CRED_ATTENDANCE, eventId: 101n, holder: fanAna.address })
    ).to.be.revertedWithCustomError(credential, "InvalidIssuerSignature");
  });

  it("executing a rotation that was never proposed reverts", async function () {
    const { registry } = await loadFixture(deployFanPassport);
    await expect(registry.executeKeyRotation(ISSUER_B)).to.be.revertedWithCustomError(registry, "NoPendingRotation");
  });

  it("an issuer can register its own doors but not doors for another issuer", async function () {
    const { registry, issuerA, outsider } = await loadFixture(deployFanPassport);
    await expect(registry.connect(issuerA).addDoor(outsider.address, ISSUER_A)).to.emit(registry, "DoorAdded").withArgs(outsider.address, ISSUER_A);
    expect(await registry.doorIssuer(outsider.address)).to.equal(ISSUER_A);
    await expect(registry.connect(issuerA).addDoor(outsider.address, ISSUER_B)).to.be.revertedWithCustomError(registry, "NotAuthorized");
  });

  it("admin role can be handed over (planned handover to an issuers' multisig)", async function () {
    const { registry, admin, outsider } = await loadFixture(deployFanPassport);
    await expect(registry.transferAdmin(outsider.address)).to.emit(registry, "AdminTransferred").withArgs(admin.address, outsider.address);
    await expect(registry.addIssuer(7n, outsider.address, "x")).to.be.revertedWithCustomError(registry, "NotAdmin");
  });
});
