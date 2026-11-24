const { ethers } = require("hardhat");

const CRED_ATTENDANCE = 1;
const CRED_MERCH = 2;
const ISSUER_A = 1n;
const ISSUER_B = 2n;
const DROP_D1 = 1n;

/** EIP-712 helpers shared by the tests (mirrors lib/eip712.js). */
async function signAttestation(issuerSigner, credential, att) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "FanPassport", version: "1", chainId, verifyingContract: await credential.getAddress() };
  const types = {
    Attestation: [
      { name: "issuerId", type: "uint256" },
      { name: "credType", type: "uint8" },
      { name: "eventId", type: "uint256" },
      { name: "identityCommitment", type: "bytes32" },
      { name: "holder", type: "address" },
      { name: "deadline", type: "uint64" },
    ],
  };
  return issuerSigner.signTypedData(domain, types, att);
}

async function signHolderProof(holderWallet, gate, proof) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "FanPassport", version: "1", chainId, verifyingContract: await gate.getAddress() };
  const types = {
    HolderProof: [
      { name: "credentialId", type: "uint256" },
      { name: "dropId", type: "uint256" },
      { name: "issuedAt", type: "uint64" },
    ],
  };
  return holderWallet.signTypedData(domain, types, proof);
}

async function now() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

/** Step 0 of the demo script: admin registers Issuer A and B, their doors, and creates joint drop D1. */
async function deployFanPassport() {
  const [admin, issuerA, issuerB, door1, door2, relayer, outsider] = await ethers.getSigners();

  const Registry = await ethers.getContractFactory("IssuerRegistry");
  const registry = await Registry.deploy(admin.address);
  const Credential = await ethers.getContractFactory("FanCredential");
  const credential = await Credential.deploy(await registry.getAddress());
  const Gate = await ethers.getContractFactory("RedemptionGate");
  const gate = await Gate.deploy(await registry.getAddress(), await credential.getAddress());

  await registry.addIssuer(ISSUER_A, issuerA.address, "Issuer A - Floripa Live (attendance)");
  await registry.addIssuer(ISSUER_B, issuerB.address, "Issuer B - Band Store (merch)");
  await registry.addDoor(door1.address, ISSUER_A);
  await registry.addDoor(door2.address, ISSUER_B);
  await gate.createDrop(DROP_D1, [ISSUER_A, ISSUER_B]);

  // Fans hold keys off-chain (PWA). They never need ETH: the relayer pays gas.
  const fanAna = ethers.Wallet.createRandom();
  const fanBruno = ethers.Wallet.createRandom();

  async function mintFor({ issuer, issuerId, credType, eventId, holder, commitment, deadline }) {
    const att = {
      issuerId,
      credType,
      eventId,
      identityCommitment: commitment ?? ethers.id(`identity:${holder}:${eventId}`),
      holder,
      deadline: deadline ?? (await now()) + 3600n,
    };
    const sig = await signAttestation(issuer, credential, att);
    const tx = await credential.connect(relayer).mint(att, sig);
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => credential.interface.parseLog(l)).find((e) => e && e.name === "CredentialIssued");
    return { tokenId: ev.args.tokenId, att, sig, receipt };
  }

  async function proofFor(holderWallet, credentialId, dropId, issuedAt) {
    const p = { credentialId, dropId, issuedAt: issuedAt ?? (await now()) };
    return { ...p, sig: await signHolderProof(holderWallet, gate, p) };
  }

  return { registry, credential, gate, admin, issuerA, issuerB, door1, door2, relayer, outsider, fanAna, fanBruno, mintFor, proofFor };
}

module.exports = { deployFanPassport, signAttestation, signHolderProof, now, CRED_ATTENDANCE, CRED_MERCH, ISSUER_A, ISSUER_B, DROP_D1 };
