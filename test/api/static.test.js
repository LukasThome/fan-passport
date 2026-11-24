// The pages depend on vendored browser bundles; a wrong path silently breaks the wallet QR.
const { expect } = require("chai");
const request = require("supertest");
const { ethers } = require("hardhat");
const { createSystem } = require("../../src/system");
const { createApp } = require("../../src/app");

describe("API - static pages and vendored scripts", function () {
  let app;
  before(async function () {
    app = createApp(await createSystem(ethers));
  });

  for (const path of ["/vendor/ethers.js", "/vendor/qrcode.js", "/js/common.js"]) {
    it(`serves ${path} as JavaScript`, async function () {
      const res = await request(app).get(path);
      expect(res.status).to.equal(200);
      expect(res.headers["content-type"]).to.match(/javascript/);
    });
  }

  it("the QR bundle defines the global qrcode() used by the wallet", async function () {
    const res = await request(app).get("/vendor/qrcode.js");
    expect(res.text).to.match(/var qrcode\s*=/);
  });

  for (const page of ["index", "issuer", "outbox", "claim", "wallet", "door", "seller"]) {
    it(`serves ${page}.html`, async function () {
      const res = await request(app).get(`/${page}.html`);
      expect(res.status).to.equal(200);
      expect(res.text).to.include("js/common.js");
    });
  }
});
