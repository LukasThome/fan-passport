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

  for (const page of ["index", "overview", "issuer", "outbox", "claim", "wallet", "door", "seller"]) {
    it(`serves ${page}.html`, async function () {
      const res = await request(app).get(`/${page}.html`);
      expect(res.status).to.equal(200);
      expect(res.text).to.include("js/common.js");
    });
  }
});

describe("API - real phone on the same Wi-Fi + camera scanning at the door", function () {
  let app;
  before(async function () {
    app = createApp(await createSystem(ethers));
  });

  it("serves the jsQR decoder used by the door camera", async function () {
    const res = await request(app).get("/vendor/jsqr.js");
    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.match(/javascript/);
    expect(res.text).to.include("jsQR");
  });

  it("the door page offers camera scanning", async function () {
    const res = await request(app).get("/door.html");
    expect(res.text).to.include("/vendor/jsqr.js");
    expect(res.text).to.include('id="cameraBtn"');
  });

  it("the inbox can show claim links as QR codes for a phone", async function () {
    const res = await request(app).get("/outbox.html");
    expect(res.text).to.include("/vendor/qrcode.js");
  });

  it("GET /api/lan lists the URLs a phone on the same network can open", async function () {
    const res = await request(app).get("/api/lan");
    expect(res.status).to.equal(200);
    expect(res.body.urls).to.be.an("array");
    for (const u of res.body.urls) expect(u).to.match(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
  });
});
