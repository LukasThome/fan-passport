// Deploys the three contracts and runs Step 0 of the demo script (admin registers Issuer A and B,
// their doors, and the joint drop D1). Returns everything the HTTP layer needs.
const crypto = require("crypto");

const ISSUERS = [
  { id: 1, name: "Issuer A - Floripa Live (promoter, attendance)", short: "Issuer A", kind: "attendance", credType: 1, eventId: 100, eventName: "Floripa Live 2026-10-10", sample: "issuerA_attendance.csv" },
  { id: 2, name: "Issuer B - Band Store (artist, merch)", short: "Issuer B", kind: "merch", credType: 2, eventId: 200, eventName: "Official merch store 2026", sample: "issuerB_merch.csv" },
];
const DROP = { id: 1, name: "D1 - joint presale, Summer Tour 2027 (Florianópolis)", acceptedIssuers: [1, 2] };

async function deployContracts(ethers, adminSigner) {
  const registry = await (await ethers.getContractFactory("IssuerRegistry", adminSigner)).deploy(adminSigner.address);
  await registry.waitForDeployment();
  const credential = await (await ethers.getContractFactory("FanCredential", adminSigner)).deploy(await registry.getAddress());
  await credential.waitForDeployment();
  const gate = await (await ethers.getContractFactory("RedemptionGate", adminSigner)).deploy(await registry.getAddress(), await credential.getAddress());
  await gate.waitForDeployment();
  return { registry, credential, gate };
}

/**
 * Roles map to the first accounts of the node (Hardhat's well-known dev accounts locally;
 * on a testnet, configure funded keys). Fans never hold ETH: the relayer sponsors gas.
 */
async function createSystem(ethers) {
  const [admin, issuerA, issuerB, door1, door2, relayer] = await ethers.getSigners();
  if (!relayer) throw new Error("FanPassport needs 6 accounts (admin, issuer A, issuer B, door 1, door 2, relayer). On a testnet run `npm run testnet:keys` first.");
  const fromBlock = await ethers.provider.getBlockNumber();
  const { registry, credential, gate } = await deployContracts(ethers, admin);
  const issuerSigners = { 1: issuerA, 2: issuerB };
  const doorSigners = { 1: door1, 2: door2 };

  for (const i of ISSUERS) await (await registry.addIssuer(i.id, issuerSigners[i.id].address, i.name)).wait();
  await (await registry.addDoor(door1.address, 1)).wait();
  await (await registry.addDoor(door2.address, 2)).wait();
  await (await gate.createDrop(DROP.id, DROP.acceptedIssuers)).wait();

  const issuers = {};
  for (const i of ISSUERS) {
    issuers[i.id] = {
      ...i,
      signer: issuerSigners[i.id],
      // Off-chain secrets held by each issuer (never on-chain)
      identitySecret: crypto.randomBytes(32),
      masterKey: crypto.randomBytes(32),
    };
  }
  const doors = {
    1: { id: 1, issuerId: 1, name: "Door 1 - operated by Issuer A", signer: door1 },
    2: { id: 2, issuerId: 2, name: "Door 2 - operated by Issuer B", signer: door2 },
  };

  const { chainId } = await ethers.provider.getNetwork();
  return {
    ethers,
    provider: ethers.provider,
    chainId: Number(chainId),
    fromBlock,
    networkName: (await ethers.provider.getNetwork()).name,
    contracts: { registry, credential, gate },
    admin,
    relayer,
    issuers,
    doors,
    drop: DROP,
  };
}

module.exports = { createSystem, deployContracts, ISSUERS, DROP };
