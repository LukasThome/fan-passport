// Section 4.1, Step 3 - issuer verification rules (initial parameters):
// merch: paid, past a 14-day hold, not refunded, value >= $15, one record per identity, <= 2 identities per phone.
// attendance: checked in at an event the issuer controls.
const { expect } = require("chai");
const { parseCsv } = require("../../lib/csv");
const { evaluateMerch, evaluateAttendance } = require("../../lib/eligibility");

const NOW = new Date("2026-11-24T12:00:00Z");
const OLD = "2026-10-01T10:00:00Z";

function merchRow(over = {}) {
  return { order_id: "M1", name: "Ana Souza", email: "ana@example.com", phone: "+5548999990001", value: "35.00", paid: "true", refunded: "false", created_at: OLD, ...over };
}

describe("lib/csv", function () {
  it("parses a header row into objects, trimming cells and skipping blank lines", function () {
    const rows = parseCsv("a,b\n 1 , 2\n\n3,4\n");
    expect(rows).to.deep.equal([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  it("supports quoted cells containing commas", function () {
    expect(parseCsv('name,city\n"Souza, Ana",Floripa')).to.deep.equal([{ name: "Souza, Ana", city: "Floripa" }]);
  });
});

describe("lib/eligibility - merch orders (Issuer B)", function () {
  it("accepts a paid, held, non-refunded order of at least $15", function () {
    const { eligible, rejected } = evaluateMerch([merchRow()], { now: NOW });
    expect(eligible).to.have.length(1);
    expect(rejected).to.have.length(0);
  });

  const cases = [
    ["below the minimum value", { value: "12.00" }, "below minimum value ($15)"],
    ["unpaid", { paid: "false" }, "order not paid"],
    ["refunded", { refunded: "true" }, "order refunded"],
    ["inside the 14-day hold", { created_at: "2026-11-20T10:00:00Z" }, "inside 14-day hold"],
    ["missing email", { email: "" }, "missing name, email or phone"],
  ];
  for (const [label, over, reason] of cases) {
    it(`rejects an order ${label}`, function () {
      const { eligible, rejected } = evaluateMerch([merchRow(over)], { now: NOW });
      expect(eligible).to.have.length(0);
      expect(rejected[0].reason).to.equal(reason);
    });
  }

  it("keeps one record per identity (same name + phone)", function () {
    const { eligible, rejected } = evaluateMerch([merchRow(), merchRow({ order_id: "M2", name: "ANA  SOUZA" })], { now: NOW });
    expect(eligible).to.have.length(1);
    expect(rejected[0].reason).to.equal("duplicate identity");
  });

  it("allows at most 2 identities per phone", function () {
    const rows = [
      merchRow({ order_id: "M1", name: "A One" }),
      merchRow({ order_id: "M2", name: "B Two" }),
      merchRow({ order_id: "M3", name: "C Three" }),
    ];
    const { eligible, rejected } = evaluateMerch(rows, { now: NOW });
    expect(eligible).to.have.length(2);
    expect(rejected[0].reason).to.equal("more than 2 identities on this phone");
  });

  it("honours custom thresholds", function () {
    const { eligible } = evaluateMerch([merchRow({ value: "12.00" })], { now: NOW, minValue: 10 });
    expect(eligible).to.have.length(1);
  });
});

describe("lib/eligibility - attendance check-ins (Issuer A)", function () {
  const row = (over = {}) => ({ ticket_id: "T1", name: "Ana Souza", email: "ana@example.com", phone: "+5548999990001", checked_in: "yes", ...over });

  it("accepts a checked-in attendee", function () {
    expect(evaluateAttendance([row()]).eligible).to.have.length(1);
  });

  it("rejects a ticket that was never scanned at the door", function () {
    const { rejected } = evaluateAttendance([row({ checked_in: "no" })]);
    expect(rejected[0].reason).to.equal("not checked in");
  });

  it("rejects duplicate identities", function () {
    const { eligible, rejected } = evaluateAttendance([row(), row({ ticket_id: "T2" })]);
    expect(eligible).to.have.length(1);
    expect(rejected[0].reason).to.equal("duplicate identity");
  });
});
