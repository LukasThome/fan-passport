// OTP step of the claim flow. Ported from LukasThome/security-mini-blockchain (autenticacao.py),
// checked against the RFC 4226 / RFC 6238 test vectors.
const { expect } = require("chai");
const { hotp, totp, verifyTotp, generateSecret } = require("../../lib/totp");

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("lib/totp (RFC 4226 / RFC 6238)", function () {
  it("HOTP matches the RFC 4226 Appendix D vectors", function () {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).to.equal(code));
  });

  it("TOTP matches the RFC 6238 SHA-1 vectors (8 digits)", function () {
    const vectors = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [t, code] of vectors) expect(totp(RFC_SECRET, { time: t, digits: 8 })).to.equal(code);
  });

  it("verifyTotp accepts the current code and +/-1 step, rejects older ones", function () {
    const secret = generateSecret();
    const t = 1_800_000_000;
    expect(verifyTotp(secret, totp(secret, { time: t }), { time: t })).to.equal(true);
    expect(verifyTotp(secret, totp(secret, { time: t - 30 }), { time: t })).to.equal(true);
    expect(verifyTotp(secret, totp(secret, { time: t + 30 }), { time: t })).to.equal(true);
    expect(verifyTotp(secret, totp(secret, { time: t - 90 }), { time: t })).to.equal(false);
  });

  it("rejects malformed codes", function () {
    const secret = generateSecret();
    expect(verifyTotp(secret, "", { time: 1 })).to.equal(false);
    expect(verifyTotp(secret, "12a456", { time: 1 })).to.equal(false);
  });

  it("generates 20-byte (160-bit) secrets", function () {
    expect(generateSecret()).to.have.length(20);
  });
});
