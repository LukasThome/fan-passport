// Scripted run of the Appendix A demo script through the same HTTP API the web pages use.
// Used by `npm run demo:cli` (terminal backup run) and `npm run testnet:demo` (public testnet run).
const { createSystem } = require("./system");
const { createApp } = require("./app");
const { totp } = require("../lib/totp");
const { holderProofTypes, domainFor, bindMessage } = require("../lib/eip712");

async function runDemo(ethers, { log = console.log, system: givenSystem } = {}) {
  const system = givenSystem || (await createSystem(ethers));
  const server = createApp(system).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = [];
  const add = (step, key, label, outcome, extra = {}) => {
    report.push({ step, key, label, outcome, ...extra });
    log(`  ${label}: ${outcome}${extra.txHash ? `  tx ${extra.txHash}` : ""}`);
  };
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch (_) { return { status: res.status, body: text }; }
  };

  try {
    const state = (await call("/api/state")).body;
    const pwa = () => {
      const root = ethers.HDNodeWallet.fromPhrase(ethers.Wallet.createRandom().mnemonic.phrase, undefined, "m/44'/60'/0'/0");
      return (i) => root.deriveChild(i);
    };
    const ana = pwa();
    const bruno = pwa();
    const now = () => Math.floor(Date.now() / 1000);
    const qr = async (w, id, issuedAt = now()) => {
      const v = { credentialId: String(id), dropId: "1", issuedAt: String(issuedAt) };
      return JSON.stringify({ ...v, sig: await w.signTypedData(domainFor(state.chainId, state.contracts.RedemptionGate), holderProofTypes, v) });
    };
    const claim = async (issuerId, email, w) => {
      const mail = (await call("/api/outbox")).body.find((m) => m.to === email && m.issuerId === issuerId);
      const otp = totp(Buffer.from(mail.mockPhoneSecret, "hex"));
      const res = await call(`/api/claim/${mail.claimToken}`, { otp, holder: w.address, signature: await w.signMessage(bindMessage(w.address, mail.claimToken)) });
      if (res.status !== 200) throw new Error(`claim failed for ${email}: ${JSON.stringify(res.body)}`);
      return res.body;
    };

    log(`Step 0 - registry: Issuer A, Issuer B, Door 1, Door 2, drop D1 (chainId ${state.chainId})`);

    log("Step 1 - Issuer A uploads the attendance CSV; fans claim");
    let up = (await call("/api/issuers/1/upload", { csv: (await call("/api/issuers/1/sample")).body })).body;
    up.rejected.forEach((r) => add(1, `rejectA-${r.id}`, `${r.name} (${r.id})`, r.reason));
    const refused = await call("/api/claim/request", { issuerId: 1, email: "mallory@example.com" });
    add(1, "refusedEmail", "Non-listed email requests a claim link", refused.status === 403 ? "refused" : `HTTP ${refused.status}`);
    const A = await claim(1, "ana@example.com", ana(1));
    add(1, "mintA", `Ana claims credential A #${A.tokenId}`, "minted", { txHash: A.txHash });
    const A2 = await claim(1, "bruno@example.com", bruno(1));
    add(1, "mintA2", `Bruno claims credential A2 #${A2.tokenId}`, "minted", { txHash: A2.txHash });

    log("Step 2 - Issuer B uploads a merch order CSV; Ana claims");
    up = (await call("/api/issuers/2/upload", { csv: (await call("/api/issuers/2/sample")).body })).body;
    up.rejected.forEach((r) => add(2, `rejectB-${r.id}`, `${r.name} (${r.id})`, r.reason));
    const B = await claim(2, "ana@example.com", ana(2));
    add(2, "mintB", `Ana claims credential B #${B.tokenId} at a second address`, "minted", { txHash: B.txHash });

    log("Step 3 - Non-transferability");
    const t = (await call("/api/demo/transfer", { tokenId: A.tokenId })).body;
    add(3, "transfer", `transferFrom(#${A.tokenId})`, t.reverted ? t.error : "NOT REVERTED");

    log("Step 4 - Door 1 (Issuer A) scans credential A");
    const live = await qr(ana(1), A.tokenId);
    const r4 = (await call("/api/doors/1/redeem", { payload: live, idChecked: true })).body;
    add(4, "door1", `Door 1 redeems #${A.tokenId} after the receipt`, r4.admit ? "ADMIT" : `REJECT ${r4.reason}`, { txHash: r4.txHash });

    log("Step 5 - same live QR at Door 2 (Issuer B)");
    const r5 = (await call("/api/doors/2/check", { payload: live })).body;
    add(5, "door2", `Door 2 checks #${A.tokenId}`, r5.ok ? "ADMIT?!" : r5.reason, { citesTx: r5.priorTx });
    const f5 = (await call("/api/doors/2/redeem", { payload: live, force: true })).body;
    add(5, "door2forced", "Door 2 forces redeem() anyway", f5.admit ? "ADMIT?!" : f5.reason, { txHash: f5.revertedTx || undefined });

    log("Step 6 - Door 2 scans credential B (its own issuer)");
    const r6 = (await call("/api/doors/2/redeem", { payload: await qr(ana(2), B.tokenId), idChecked: true })).body;
    add(6, "door2B", `Door 2 redeems #${B.tokenId}`, r6.admit ? "ADMIT" : `REJECT ${r6.reason}`, { txHash: r6.txHash });

    log("Step 7 - re-scan, revocation, expired QR");
    add(7, "rescan", `Re-scan of #${A.tokenId}`, (await call("/api/doors/1/check", { payload: await qr(ana(1), A.tokenId) })).body.reason);
    const rev = (await call("/api/issuers/1/revoke", { tokenId: A2.tokenId })).body;
    add(7, "revoke", `Issuer A revokes #${A2.tokenId} (refund)`, "revoked", { txHash: rev.txHash });
    add(7, "revoked", `Scan of revoked #${A2.tokenId}`, (await call("/api/doors/1/check", { payload: await qr(bruno(1), A2.tokenId) })).body.reason);
    add(7, "expired", "QR signed 120 s ago", (await call("/api/doors/1/check", { payload: await qr(ana(1), A.tokenId, now() - 120) })).body.reason);

    const costs = (await call("/api/costs")).body;
    return { chainId: state.chainId, contracts: state.contracts, admin: state.admin, report, costs, finishedAt: new Date().toISOString() };
  } finally {
    server.close();
  }
}

function renderReport(result, { network, explorer } = {}) {
  const tx = (h) => (!h ? "" : explorer ? `[\`${h.slice(0, 10)}…${h.slice(-6)}\`](${explorer}/tx/${h})` : `\`${h}\``);
  const addr = (a) => (explorer ? `[\`${a}\`](${explorer}/address/${a})` : `\`${a}\``);
  const lines = [
    `# FanPassport — demo run on ${network}`,
    "",
    `Chain ID ${result.chainId} · finished ${result.finishedAt}. All fan data is synthetic. Generated by \`src/demoRunner.js\`.`,
    "",
    "## Contracts",
    "",
    "| Contract | Address |",
    "|---|---|",
    ...Object.entries(result.contracts).map(([k, v]) => `| ${k} | ${addr(v)} |`),
    "",
    "## Appendix A, step by step",
    "",
    "| Step | Action | Outcome | Transaction |",
    "|---|---|---|---|",
    ...result.report.map((r) => `| ${r.step} | ${r.label} | **${r.outcome}** | ${tx(r.txHash)}${r.citesTx ? ` cites ${tx(r.citesTx)}` : ""} |`),
    "",
    "## Measured gas (from this run's receipts)",
    "",
    `- mint(): ${result.costs.measured.mint.avgGas.toLocaleString("en")} gas (avg of ${result.costs.measured.mint.count})`,
    `- redeem(): ${result.costs.measured.redeem.avgGas.toLocaleString("en")} gas (avg of ${result.costs.measured.redeem.count})`,
    `- revoke(): ${result.costs.measured.revoke.avgGas.toLocaleString("en")} gas`,
    `- Reference drop (${result.costs.referenceDrop.mints} mints + ${result.costs.referenceDrop.redemptions} redemptions): ${result.costs.referenceDropGas.toLocaleString("en")} gas`,
    "",
  ];
  return lines.join("\n");
}

const EXPLORERS = { 84532: "https://sepolia.basescan.org", 421614: "https://sepolia.arbiscan.io" };
const explorerFor = (chainId) => EXPLORERS[Number(chainId)];

module.exports = { runDemo, renderReport, explorerFor };
