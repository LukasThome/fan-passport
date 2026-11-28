// Backup run of the Appendix A demo script in the terminal (Table 8: "recorded backup run").
//   npm run demo:cli
const hre = require("hardhat");
const { runDemo, renderReport } = require("../src/demoRunner");

async function main() {
  console.log(`\nFanPassport demo script on ${hre.network.name}\n`);
  const result = await runDemo(hre.ethers);
  console.log(`\n${renderReport(result, { network: hre.network.name })}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
