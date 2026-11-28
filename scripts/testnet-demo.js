// Runs the Appendix A demo script on a public testnet and writes an explorer-linked report.
//   npm run testnet:demo                       (Base Sepolia)
//   npx hardhat run scripts/testnet-demo.js --network arbitrumSepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { runDemo, renderReport, explorerFor } = require("../src/demoRunner");

async function main() {
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  if (signers.length < 6) throw new Error("Need six role keys: run `npm run testnet:keys` first.");
  const [admin, ...others] = signers;
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Network ${hre.network.name} (chainId ${chainId}) · admin ${admin.address}`);

  // Fund the other roles from admin (doors and relayer pay gas; fans never do)
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 1n;
  const perRole = ethers.parseEther("0.0005") > gasPrice * 3_000_000n ? ethers.parseEther("0.0005") : gasPrice * 3_000_000n;
  const adminBalance = await ethers.provider.getBalance(admin.address);
  if (adminBalance < perRole * 6n) throw new Error(`Admin balance ${ethers.formatEther(adminBalance)} ETH is too low: send faucet ETH to ${admin.address}`);
  for (const s of others) {
    const bal = await ethers.provider.getBalance(s.address);
    if (bal < perRole) {
      const tx = await admin.sendTransaction({ to: s.address, value: perRole - bal });
      await tx.wait();
      console.log(`  funded ${s.address} with ${ethers.formatEther(perRole - bal)} ETH`);
    }
  }

  const result = await runDemo(ethers);
  const explorer = explorerFor(chainId);
  const md = renderReport(result, { network: hre.network.name, explorer });
  const docs = path.join(__dirname, "..", "docs");
  const deployments = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(deployments, { recursive: true });
  const local = ["hardhat", "localhost", "rehearsal"].includes(hre.network.name);
  const mdFile = path.join(docs, `testnet-run-${hre.network.name}${local ? ".local" : ""}.md`);
  fs.writeFileSync(mdFile, md);
  fs.writeFileSync(path.join(deployments, `${hre.network.name}${local ? ".local" : ""}.json`), JSON.stringify({ network: hre.network.name, chainId: Number(chainId), ...result.contracts, admin: result.admin, at: result.finishedAt }, null, 2));
  console.log(`\nReport: ${path.relative(process.cwd(), mdFile)}${explorer ? `\nExplorer: ${explorer}/address/${result.contracts.RedemptionGate}` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
