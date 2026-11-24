// Section 4.3, detection layer 2: identity binding = keyed hash (per-issuer secret) of normalised legal name + phone.
const { expect } = require("chai");
const { normalizeName, normalizePhone, identityCommitment } = require("../../lib/identity");

const SECRET_A = Buffer.alloc(32, 1);
const SECRET_B = Buffer.alloc(32, 2);

describe("lib/identity", function () {
  it("normalises names: case, accents and extra spaces", function () {
    expect(normalizeName("  Ána   SOUZA ")).to.equal("ana souza");
    expect(normalizeName("João da Silva")).to.equal("joao da silva");
  });

  it("normalises phones to digits with a leading +", function () {
    expect(normalizePhone("+55 (48) 99999-0001")).to.equal("+5548999990001");
  });

  it("the same person yields the same commitment under the same issuer", function () {
    const c1 = identityCommitment(SECRET_A, "Ána Souza", "+55 48 99999-0001");
    const c2 = identityCommitment(SECRET_A, "ana souza", "+5548999990001");
    expect(c1).to.equal(c2);
    expect(c1).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("different issuers cannot link the same fan (per-issuer secret)", function () {
    expect(identityCommitment(SECRET_A, "Ana Souza", "+5548999990001")).to.not.equal(identityCommitment(SECRET_B, "Ana Souza", "+5548999990001"));
  });

  it("the commitment reveals neither name nor phone", function () {
    const c = identityCommitment(SECRET_A, "Ana Souza", "+5548999990001");
    expect(c).to.not.include("ana");
    expect(c).to.not.include("5548999990001");
  });
});
