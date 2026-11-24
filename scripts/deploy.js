// Deploys the three contracts to any configured network and records the addresses.
//   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network baseSepolia
// The deployer becomes the registry admin (the white paper's MVP admin is a team 2-of-3 multisig:
// transfer it with registry.transferAdmin(<safe address>) after deploying).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { deployContracts } = require("../src/system");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY for this network");
  console.log(`Deploying to ${hre.network.name} from ${deployer.address}`);
  const { registry, credential, gate } = await deployContracts(hre.ethers, deployer);
  const out = {
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    admin: deployer.address,
    IssuerRegistry: await registry.getAddress(),
    FanCredential: await credential.getAddress(),
    RedemptionGate: await gate.getAddress(),
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const suffix = hre.network.name === "hardhat" || hre.network.name === "localhost" ? ".local.json" : ".json";
  fs.writeFileSync(path.join(dir, hre.network.name + suffix), JSON.stringify(out, null, 2));
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
