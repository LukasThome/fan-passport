// Backup run of the Appendix A demo script in the terminal (Table 8: "recorded backup run").
// Drives the same HTTP API the web pages use.  npm run demo:cli
const hre = require("hardhat");
const { createSystem } = require("../src/system");
const { createApp } = require("../src/app");
const { totp } = require("../lib/totp");
const { holderProofTypes, domainFor, bindMessage } = require("../lib/eip712");

const { ethers } = hre;
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

async function main() {
  const system = await createSystem(ethers);
  const server = createApp(system).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch (_) { return { status: res.status, body: text }; }
  };
  const step = (n, s) => console.log(`\n${c.y(`Step ${n}`)} ${s}`);
  const state = (await call("/api/state")).body;
  const pwa = (m) => { const root = ethers.HDNodeWallet.fromPhrase(m, undefined, "m/44'/60'/0'/0"); return (i) => root.deriveChild(i); };
  const ana = pwa(ethers.Wallet.createRandom().mnemonic.phrase);
  const bruno = pwa(ethers.Wallet.createRandom().mnemonic.phrase);
  const qr = async (w, id, issuedAt = Math.floor(Date.now() / 1000)) => {
    const v = { credentialId: String(id), dropId: "1", issuedAt: String(issuedAt) };
    return JSON.stringify({ ...v, sig: await w.signTypedData(domainFor(state.chainId, state.contracts.RedemptionGate), holderProofTypes, v) });
  };
  const claim = async (issuerId, email, w) => {
    const mail = (await call("/api/outbox")).body.find((m) => m.to === email && m.issuerId === issuerId);
    const otp = totp(Buffer.from(mail.mockPhoneSecret, "hex"));
    return (await call(`/api/claim/${mail.claimToken}`, { otp, holder: w.address, signature: await w.signMessage(bindMessage(w.address, mail.claimToken)) })).body;
  };

  step(0, `Admin registered Issuer A and B, Door 1 and 2, drop D1 on ${hre.network.name} (chainId ${state.chainId})`);
  console.log(c.d(`  RedemptionGate ${state.contracts.RedemptionGate}`));

  step(1, "Issuer A uploads the attendance check-in CSV");
  let up = (await call("/api/issuers/1/upload", { csv: (await call("/api/issuers/1/sample")).body })).body;
  console.log(`  eligible: ${up.eligible.map((e) => e.name).join(", ")}`);
  up.rejected.forEach((r) => console.log(c.r(`  rejected: ${r.name} - ${r.reason}`)));
  const refused = await call("/api/claim/request", { issuerId: 1, email: "mallory@example.com" });
  console.log(c.r(`  non-listed email refused (${refused.status}): ${refused.body.error}`));
  const A = await claim(1, "ana@example.com", ana(1));
  console.log(c.g(`  Ana claimed credential A #${A.tokenId}  tx ${A.txHash}`));
  const A2 = await claim(1, "bruno@example.com", bruno(1));
  console.log(c.g(`  Bruno claimed credential A2 #${A2.tokenId}`));

  step(2, "Issuer B uploads a merch order CSV");
  up = (await call("/api/issuers/2/upload", { csv: (await call("/api/issuers/2/sample")).body })).body;
  up.rejected.forEach((r) => console.log(c.r(`  rejected: ${r.name} - ${r.reason}`)));
  const B = await claim(2, "ana@example.com", ana(2));
  console.log(c.g(`  Ana claimed credential B #${B.tokenId} at a different address (${B.holder})`));

  step(3, "Non-transferability");
  const t = (await call("/api/demo/transfer", { tokenId: A.tokenId })).body;
  console.log(c.r(`  transferFrom reverted: ${t.error}`));

  step(4, "Door 1 (Issuer A) scans credential A");
  const live = await qr(ana(1), A.tokenId);
  const chk = (await call("/api/doors/1/check", { payload: live })).body;
  console.log(`  checks: ${chk.steps.join(" | ")}`);
  console.log(`  name on Issuer A's record: ${chk.holderName} -> staff matches ID`);
  const r4 = (await call("/api/doors/1/redeem", { payload: live, idChecked: true })).body;
  console.log(c.g(`  ADMIT after receipt (status ${r4.receiptStatus})  tx ${r4.txHash}`));

  step(5, "Same live QR at Door 2 (Issuer B), seconds later");
  const r5 = (await call("/api/doors/2/check", { payload: live })).body;
  console.log(c.r(`  REJECT ${r5.reason} - redeemed by ${r5.priorDoor}, tx ${r5.priorTx}`));
  const f5 = (await call("/api/doors/2/redeem", { payload: live, force: true })).body;
  console.log(c.r(`  forced redeem() reverted on-chain: ${f5.reason}`));

  step(6, "Door 2 scans credential B (its own issuer)");
  const qB = await qr(ana(2), B.tokenId);
  const r6 = (await call("/api/doors/2/redeem", { payload: qB, idChecked: true })).body;
  console.log(c.g(`  ADMIT  tx ${r6.txHash}`));

  step(7, "Re-scan, revocation, expired QR");
  console.log(c.r(`  re-scan of A: ${(await call("/api/doors/1/check", { payload: await qr(ana(1), A.tokenId) })).body.reason}`));
  await call("/api/issuers/1/revoke", { tokenId: A2.tokenId });
  console.log(c.r(`  A2 after revocation: ${(await call("/api/doors/1/check", { payload: await qr(bruno(1), A2.tokenId) })).body.reason}`));
  console.log(c.r(`  expired QR: ${(await call("/api/doors/1/check", { payload: await qr(ana(1), A.tokenId, Math.floor(Date.now() / 1000) - 120) })).body.reason}`));

  console.log(`\n${c.g("Demo script complete.")}\n`);
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
