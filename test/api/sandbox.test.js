// The sandbox page (split screen: demo steps left, fan iPhone right) needs a server that can
// reset the demo: redeploy fresh contracts and drop all off-chain state, without a restart.
const { expect } = require("chai");
const request = require("supertest");
const { ethers } = require("hardhat");
const { createServer } = require("../../src/server");

describe("Sandbox server - reset and pages", function () {
  let server;
  before(async function () {
    server = await createServer(ethers);
  });

  it("serves the sandbox as the home page", async function () {
    const res = await request(server).get("/");
    expect(res.status).to.equal(200);
    expect(res.text).to.include("sandbox.js");
  });

  it("serves the fan phone app used inside the iPhone frame", async function () {
    const res = await request(server).get("/phone.html");
    expect(res.status).to.equal(200);
    expect(res.text).to.include("phone.js");
  });

  for (const path of ["/js/sandbox.js", "/js/phone.js"]) {
    it(`serves ${path} as JavaScript`, async function () {
      const res = await request(server).get(path);
      expect(res.status).to.equal(200);
      expect(res.headers["content-type"]).to.match(/javascript/);
    });
  }

  it("keeps the classic pages reachable", async function () {
    expect((await request(server).get("/overview.html")).status).to.equal(200);
    expect((await request(server).get("/door.html")).status).to.equal(200);
  });

  it("reset redeploys the contracts and clears the off-chain state", async function () {
    const before = (await request(server).get("/api/state")).body;
    const csv = (await request(server).get("/api/issuers/1/sample")).text;
    await request(server).post("/api/issuers/1/upload").send({ csv });
    expect((await request(server).get("/api/outbox")).body).to.not.be.empty;

    const res = await request(server).post("/api/admin/reset");
    expect(res.status).to.equal(200);
    const after = (await request(server).get("/api/state")).body;
    expect(after.contracts.RedemptionGate).to.not.equal(before.contracts.RedemptionGate);
    expect(after.issuers.every((i) => i.active)).to.equal(true);
    expect((await request(server).get("/api/outbox")).body).to.deep.equal([]);
    const names = (await request(server).get("/api/events")).body.map((e) => e.name);
    expect(names).to.not.include("CredentialIssued");
    expect(names).to.include("DropCreated");
  });
});
