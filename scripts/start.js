// Deploys the contracts, runs Step 0 (issuers, doors, drop D1) and serves the demo web app.
//   npm start                     -> in-process Hardhat chain (one command, nothing else to run)
//   npm run chain + start:localhost -> separate Hardhat node at 127.0.0.1:8545
const hre = require("hardhat");
const { createServer } = require("../src/server");

const PORT = Number(process.env.PORT || 3000);

async function main() {
  const app = await createServer(hre.ethers);
  const system = app.current().system;
  const { registry, credential, gate } = system.contracts;
  await new Promise((resolve) => app.listen(PORT, resolve));

  const url = `http://localhost:${PORT}`;
  console.log(`
  FanPassport MVP running on ${hre.network.name} (chainId ${system.chainId})

    IssuerRegistry  ${await registry.getAddress()}
    FanCredential   ${await credential.getAddress()}
    RedemptionGate  ${await gate.getAddress()}

    Sandbox         ${url}/            <- start here: demo steps left, fan iPhone right
    Overview        ${url}/overview.html
    Issuer A        ${url}/issuer.html?id=1
    Issuer B        ${url}/issuer.html?id=2
    Fan inbox       ${url}/outbox.html
    Fan wallet      ${url}/wallet.html
    Door 1          ${url}/door.html?id=1
    Door 2          ${url}/door.html?id=2
    Ticket seller   ${url}/seller.html

  Ctrl+C to stop. Chain state lives in memory and resets on restart.
`);
  await new Promise(() => {}); // keep serving
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
