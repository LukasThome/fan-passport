// Footnote 1 of the technical white paper: HMAC-SHA256 over the credential ID, keyed by a per-drop key
// that HKDF derives from the issuer master key with salt = dropId; first 5 bytes, base32, 8 characters.
const { expect } = require("chai");
const { deriveDropKey, presaleCode, base32 } = require("../../lib/presaleCode");

const MASTER = Buffer.alloc(32, 7);

describe("lib/presaleCode", function () {
  it("base32-encodes 5 bytes to exactly 8 RFC 4648 characters", function () {
    expect(base32(Buffer.from([0, 0, 0, 0, 0]))).to.equal("AAAAAAAA");
    expect(base32(Buffer.from("fooba"))).to.equal("MZXW6YTB"); // RFC 4648 test vector
  });

  it("codes are 8 characters from the base32 alphabet", function () {
    const code = presaleCode(MASTER, 1n, 42n);
    expect(code).to.match(/^[A-Z2-7]{8}$/);
  });

  it("is deterministic (issuer can re-derive codes for post-sale audit)", function () {
    expect(presaleCode(MASTER, 1n, 42n)).to.equal(presaleCode(MASTER, 1n, 42n));
  });

  it("is credential-bound and drop-bound", function () {
    const a = presaleCode(MASTER, 1n, 42n);
    expect(presaleCode(MASTER, 1n, 43n)).to.not.equal(a);
    expect(presaleCode(MASTER, 2n, 42n)).to.not.equal(a);
  });

  it("depends on the issuer-held master key (derivation is open, the key is secret)", function () {
    expect(presaleCode(Buffer.alloc(32, 8), 1n, 42n)).to.not.equal(presaleCode(MASTER, 1n, 42n));
  });

  it("derives a 32-byte per-drop key with HKDF", function () {
    const k1 = deriveDropKey(MASTER, 1n);
    expect(k1).to.have.length(32);
    expect(deriveDropKey(MASTER, 2n).equals(k1)).to.equal(false);
  });

  it("produces no collisions across 2,000 credentials in one drop", function () {
    const seen = new Set();
    for (let i = 1n; i <= 2000n; i++) seen.add(presaleCode(MASTER, 1n, i));
    expect(seen.size).to.equal(2000);
  });
});
