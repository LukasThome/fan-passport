// Creates throwaway keys for the six demo roles on a public testnet and prints the address to fund.
//   npm run testnet:keys
// The file testnet-keys.json is git-ignored. Never put mainnet funds on these keys.
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const ROLES = ["admin", "issuerA", "issuerB", "door1", "door2", "relayer"];
const file = path.join(__dirname, "..", "testnet-keys.json");

let data;
if (fs.existsSync(file)) {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log("testnet-keys.json already exists - reusing it.\n");
} else {
  const wallets = ROLES.map(() => Wallet.createRandom());
  data = { note: "Throwaway TESTNET keys for the FanPassport demo. Do not fund with real ETH.", roles: ROLES, keys: wallets.map((w) => w.privateKey), addresses: wallets.map((w) => w.address) };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log("Created testnet-keys.json (git-ignored).\n");
}
ROLES.forEach((r, i) => console.log(`  ${r.padEnd(8)} ${data.addresses[i]}`));
console.log(`
Next:
  1. Send ~0.01 Base Sepolia ETH from a faucet to the admin address:
       ${data.addresses[0]}
     (faucets: https://docs.base.org/base-chain/tools/network-faucets)
  2. npm run testnet:demo      -> funds the other roles from admin, deploys, runs Appendix A,
                                  writes docs/testnet-run-baseSepolia.md with Basescan links
`);
