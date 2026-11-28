// The scripted demo run (terminal backup and public-testnet run) must reproduce every outcome of
// Appendix A and produce a report whose transactions link to a block explorer.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { runDemo, renderReport } = require("../../src/demoRunner");

describe("demoRunner - scripted Appendix A run and its report", function () {
  let result;
  before(async function () {
    result = await runDemo(ethers, { log: () => {} });
  });

  it("reproduces every expected outcome of the demo script", function () {
    const byKey = Object.fromEntries(result.report.map((r) => [r.key, r]));
    expect(byKey.refusedEmail.outcome).to.equal("refused");
    expect(byKey.mintA.outcome).to.equal("minted");
    expect(byKey.mintB.outcome).to.equal("minted");
    expect(byKey.transfer.outcome).to.equal("Soulbound");
    expect(byKey.door1.outcome).to.equal("ADMIT");
    expect(byKey.door2.outcome).to.equal("AlreadyRedeemed");
    expect(byKey.door2forced.outcome).to.equal("AlreadyRedeemed");
    expect(byKey.door2B.outcome).to.equal("ADMIT");
    expect(byKey.rescan.outcome).to.equal("AlreadyRedeemed");
    expect(byKey.revoked.outcome).to.equal("Revoked");
    expect(byKey.expired.outcome).to.equal("ProofExpired");
  });

  it("every on-chain write in the report carries its transaction hash", function () {
    for (const key of ["mintA", "mintB", "door1", "door2B", "revoke"]) {
      const r = result.report.find((x) => x.key === key);
      expect(r.txHash, key).to.match(/^0x[0-9a-f]{64}$/);
    }
  });

  it("Door 2's rejection cites Door 1's transaction", function () {
    const door1 = result.report.find((x) => x.key === "door1");
    const door2 = result.report.find((x) => x.key === "door2");
    expect(door2.citesTx).to.equal(door1.txHash);
  });

  it("records the contract addresses and measured gas", function () {
    expect(result.contracts.RedemptionGate).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(result.costs.measured.redeem.avgGas).to.be.greaterThan(0);
  });

  it("renders a Markdown report with explorer links", function () {
    const md = renderReport(result, { network: "baseSepolia", explorer: "https://sepolia.basescan.org" });
    expect(md).to.include("# FanPassport");
    expect(md).to.include(`https://sepolia.basescan.org/address/${result.contracts.RedemptionGate}`);
    const door1 = result.report.find((x) => x.key === "door1");
    expect(md).to.include(`https://sepolia.basescan.org/tx/${door1.txHash}`);
    expect(md).to.include("AlreadyRedeemed");
  });

  it("renders plain hashes when there is no explorer (local chain)", function () {
    const md = renderReport(result, { network: "hardhat" });
    expect(md).to.not.include("basescan");
  });
});
