/* Sandbox: runs the Appendix A demo script against the real API (left) and drives the fan's phone (right). */
/* global FP */
(() => {
  const PROGRESS_KEY = "fp.sandbox.v1";
  const $ = (id) => document.getElementById(id);
  const esc = FP.esc;
  const now = () => Math.floor(Date.now() / 1000);

  let progress = load() || { done: -1, view: 0, ctx: {}, results: {} };
  let busy = false;

  function load() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)); } catch (_) { return null; }
  }
  function save() {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch (_) {}
  }
  function clearLocal() {
    for (const k of [PROGRESS_KEY, "fp.wallet.v1", "fp.liveqr.v1"]) {
      try { localStorage.removeItem(k); } catch (_) {}
    }
  }

  // ------------------------------------------------------------ fan helpers
  async function claim(issuerId, email) {
    const mail = (await FP.api("/api/outbox")).find((m) => m.to === email && m.issuerId === issuerId);
    if (!mail) throw new Error(`no invite for ${email}`);
    FP.ensureProfile(mail.name);
    const w = FP.signerFor(mail.name, issuerId);
    const signature = await w.signMessage(`FanPassport: bind ${w.address} to claim ${mail.claimToken}`);
    const r = await FP.api(`/api/claim/${mail.claimToken}`, { otp: mail.currentOtp, holder: w.address, signature });
    FP.addCredential(mail.name, { tokenId: r.tokenId, issuerId: r.issuerId, issuerShort: r.issuerShort, eventName: r.eventName, credType: r.credType, holder: r.holder, txHash: r.txHash });
    return { ...r, name: mail.name };
  }
  async function qr(profile, issuerId, tokenId, issuedAt = now()) {
    return FP.signHolderProof(FP.signerFor(profile, issuerId), tokenId, 1, issuedAt);
  }
  const row = (l, v, tone) => ({ l, v, tone });
  function replaceCredential(profile, oldId, newId, txHash) {
    const w = FP.loadWallet();
    const c = (w.profiles[profile]?.credentials || []).find((x) => x.tokenId === oldId);
    if (c) { c.tokenId = newId; c.txHash = txHash; FP.saveWallet(w); }
  }
  const ANA = "Ana Souza";
  const BRUNO = "Bruno Lima";

  // ------------------------------------------------------------------ steps
  const STEPS = [
    {
      short: "Setup issuers & drop", actor: "Registry admin", cta: "Read the registry",
      title: "Two independent issuers, their doors and joint drop D1",
      desc: "IssuerRegistry is permissioned: only the admin (a team multisig in production) admits issuers. Each issuer runs its own door. D1 accepts credentials from both. This ran on-chain when the server started.",
      async run() {
        const s = await FP.api("/api/state");
        return {
          phone: { screen: "empty" },
          rows: [
            ...s.issuers.map((i) => row(`${i.name}`, i.active ? `active · epoch ${i.epoch}` : "suspended", i.active ? "ok" : "bad")),
            ...s.doors.map((d) => row(d.name, `${FP.short(d.address)}`, "info")),
            row(s.drop.name, `accepts ${s.drop.acceptedIssuers.map((x) => (x === 1 ? "A" : "B")).join(" + ")}`, "info"),
          ],
        };
      },
    },
    {
      short: "Issuer A: attendance", actor: "Issuer A · promoter", cta: "Upload check-ins & claim",
      title: "A check-in list becomes non-transferable credentials",
      desc: "Rules run off-chain on the issuer’s own export. Eligible fans get a claim link and a one-time code (TOTP). Ana and Bruno claim with their wallets; the relayer mints and pays the gas. A non-listed email is refused.",
      async run(ctx) {
        const csv = await (await fetch("/api/issuers/1/sample")).text();
        const up = await FP.api("/api/issuers/1/upload", { csv });
        let refused = "";
        try { await FP.api("/api/claim/request", { issuerId: 1, email: "mallory@example.com" }); } catch (e) { refused = e.message; }
        const a = await claim(1, "ana@example.com");
        const a2 = await claim(1, "bruno@example.com");
        ctx.A = a.tokenId; ctx.A2 = a2.tokenId;
        return {
          verdict: { tone: "ok", big: "MINTED", text: `Ana → credential #${a.tokenId} · Bruno → #${a2.tokenId} (locked, gas sponsored)`, tx: `tx ${a.txHash}` },
          rows: [
            ...up.eligible.map((e) => row(e.name, "eligible", "ok")),
            ...up.rejected.map((r) => row(`${r.name} · ${r.id}`, r.reason, "bad")),
            row("mallory@example.com asks for a link", refused ? "refused" : "?", "bad"),
          ],
          phone: { screen: "claimed", profile: ANA, token: a.tokenId, tx: a.txHash },
        };
      },
    },
    {
      short: "Issuer B: merch", actor: "Issuer B · artist store", cta: "Upload orders & claim",
      title: "A second, independent issuer",
      desc: "Issuer B applies its own rules: paid, not refunded, at least $15, past the 14-day hold. Ana claims a merch credential at a different address derived for Issuer B.",
      async run(ctx) {
        const csv = await (await fetch("/api/issuers/2/sample")).text();
        const up = await FP.api("/api/issuers/2/upload", { csv });
        const b = await claim(2, "ana@example.com");
        ctx.B = b.tokenId;
        return {
          verdict: { tone: "ok", big: "MINTED", text: `Ana → credential #${b.tokenId} at ${FP.short(b.holder)}`, tx: `tx ${b.txHash}` },
          rows: [...up.eligible.map((e) => row(e.name, "eligible", "ok")), ...up.rejected.map((r) => row(`${r.name} · ${r.id}`, r.reason, "bad"))],
          phone: { screen: "wallet", profile: ANA },
        };
      },
    },
    {
      short: "Non-transferable", actor: "Fan", cta: "Try to transfer #A",
      title: "Credentials cannot be sold or handed on",
      desc: "FanCredential is an ERC-5192 locked token: transferFrom, approve and setApprovalForAll revert. Only mint and burn can move it.",
      async run(ctx) {
        const t = await FP.api("/api/demo/transfer", { tokenId: ctx.A });
        const st = await FP.api(`/api/credentials/${ctx.A}`);
        return {
          verdict: { tone: t.reverted ? "bad" : "ok", big: t.reverted ? "REVERTED" : "MOVED?", text: `transferFrom(#${ctx.A}) → ${t.error}()`, tx: `eth_call from ${t.from}` },
          rows: [row(`locked(#${ctx.A})`, String(st.locked), "ok"), row("supportsInterface(0xb45a3c0e)", "ERC-5192", "info"), row("Holder pays gas?", "no — sponsored", "info")],
          phone: { screen: "wallet", profile: ANA },
        };
      },
    },
    {
      short: "Presale code", actor: "Issuer A + ticket seller", cta: "Upload codes & buy",
      title: "Single-use code at the ticket seller the fan already uses",
      desc: "Each issuer derives one code per credential (HMAC-SHA256 with an HKDF per-drop key) and uploads the list. The seller never sees names or wallets: this is the soft gate. The door is the hard gate.",
      async run(ctx) {
        const upA = await FP.api("/api/issuers/1/upload-codes", { dropId: 1 });
        const upB = await FP.api("/api/issuers/2/upload-codes", { dropId: 1 });
        const issuedAt = now();
        const signature = await FP.signerFor(ANA, 1).signMessage(`FanPassport code request ${ctx.A} 1 ${issuedAt}`);
        const { code } = await FP.api("/api/wallet/code", { tokenId: ctx.A, dropId: 1, issuedAt, signature });
        ctx.code = code;
        const first = await FP.api("/api/seller/redeem", { code, buyerName: ANA });
        const second = await FP.api("/api/seller/redeem", { code, buyerName: ANA });
        const bogus = await FP.api("/api/seller/redeem", { code: "AAAAAAAA", buyerName: "Bot" });
        return {
          verdict: { tone: "ok", big: "RESERVED", text: `${code} · presale ticket reserved for ${ANA}`, tx: "mock seller · codes only, no personal data" },
          rows: [
            row("Codes uploaded for D1", `${upA.count + upB.count} codes`, "info"),
            row(`${code} · first use`, first.ok ? "reserved" : first.reason, first.ok ? "ok" : "bad"),
            row(`${code} · second use`, second.reason || "?", "bad"),
            row("AAAAAAAA", bogus.reason || "?", "bad"),
          ],
          phone: { screen: "presale", profile: ANA, token: ctx.A },
        };
      },
    },
    {
      short: "Door 1 admits", actor: "Door 1 · Issuer A", cta: "Scan Ana at Door 1",
      title: "The door admits only after the receipt",
      desc: "Door 1 verifies the QR signed by Ana’s key, reads chain state, name-checks her against Issuer A’s record, then calls redeem() and waits for a success receipt.",
      async run(ctx) {
        ctx.payloadA = await qr(ANA, 1, ctx.A);
        const check = await FP.api("/api/doors/1/check", { payload: ctx.payloadA });
        if (!check.ok) return { verdict: { tone: "bad", big: "REJECT", text: check.reason, tx: "" }, rows: [], phone: { screen: "pass", profile: ANA, token: ctx.A } };
        const r = await FP.api("/api/doors/1/redeem", { payload: ctx.payloadA, idChecked: true });
        ctx.door1Tx = r.txHash;
        return {
          verdict: { tone: r.admit ? "ok" : "bad", big: r.admit ? "ADMIT" : "REJECT", text: `${check.holderName} · credential #${ctx.A} · receipt status ${r.receiptStatus} · block ${r.blockNumber}`, tx: `tx ${r.txHash}` },
          rows: [...check.steps.map((s) => row(s, "pass", "ok")), row(`Name on Issuer A record: ${check.holderName}`, "ID match", "ok")],
          phone: { screen: "pass", profile: ANA, token: ctx.A },
        };
      },
    },
    {
      short: "Door 2 rejects", actor: "Door 2 · Issuer B", cta: "Same QR at Door 2",
      title: "Shared state: no trust in Issuer A’s server",
      desc: "Seconds later the same, still-fresh QR reaches Door 2, run by another issuer. It reads the same chain state and rejects on AlreadyRedeemed. Even a forced redeem() is reverted by the contract itself.",
      async run(ctx) {
        const payload = ctx.payloadA && Number(JSON.parse(ctx.payloadA).issuedAt) > now() - 55 ? ctx.payloadA : await qr(ANA, 1, ctx.A);
        const check = await FP.api("/api/doors/2/check", { payload });
        const forced = await FP.api("/api/doors/2/redeem", { payload, force: true });
        return {
          verdict: { tone: "bad", big: "REJECT", text: `${check.reason} · redeemed by ${check.priorDoor || "?"}${check.priorBlock ? " at block " + check.priorBlock : ""}`, tx: `cites tx ${check.priorTx || "?"}` },
          rows: [
            ...(check.steps || []).map((s) => row(s, "pass", "ok")),
            row(`isRedeemed(D1, #${ctx.A})`, "true", "bad"),
            row("Name check of another issuer's credential", "not done here", "info"),
            row("Forced redeem() on-chain", `reverted: ${forced.reason}`, "bad"),
          ],
          phone: { screen: "pass", profile: ANA, token: ctx.A },
        };
      },
    },
    {
      short: "Door 2 admits B", actor: "Door 2 · Issuer B", cta: "Scan credential B",
      title: "The second issuer’s credential works independently",
      desc: "Door 2 name-checks only its own issuer’s credentials. Ana’s merch credential is redeemed for D1.",
      async run(ctx) {
        const payload = await qr(ANA, 2, ctx.B);
        const check = await FP.api("/api/doors/2/check", { payload });
        const r = await FP.api("/api/doors/2/redeem", { payload, idChecked: true });
        return {
          verdict: { tone: r.admit ? "ok" : "bad", big: r.admit ? "ADMIT" : "REJECT", text: `${check.holderName} · credential #${ctx.B} (Issuer B)`, tx: `tx ${r.txHash}` },
          rows: [...(check.steps || []).map((s) => row(s, "pass", "ok")), row(`Name on Issuer B record: ${check.holderName}`, "ID match", "ok")],
          phone: { screen: "pass", profile: ANA, token: ctx.B },
        };
      },
    },
    {
      short: "Revoke & expiry", actor: "Issuer A + doors", cta: "Revoke & re-scan",
      title: "Invalid scans are rejected",
      desc: "Issuer A revokes Bruno’s credential after a refund. A re-scan, a revoked credential and a stale QR are all rejected.",
      async run(ctx) {
        const rev = await FP.api("/api/issuers/1/revoke", { tokenId: ctx.A2 });
        const re = await FP.api("/api/doors/1/check", { payload: await qr(ANA, 1, ctx.A) });
        const rv = await FP.api("/api/doors/1/check", { payload: await qr(BRUNO, 1, ctx.A2) });
        const ex = await FP.api("/api/doors/1/check", { payload: await qr(ANA, 1, ctx.A, now() - 120) });
        const n = [re, rv, ex].filter((x) => !x.ok).length;
        return {
          verdict: { tone: "bad", big: "REJECT", text: `${n} of 3 invalid scans rejected`, tx: `CredentialRevoked(#${ctx.A2}) · tx ${rev.txHash}` },
          rows: [row(`Re-scan of #${ctx.A}`, re.reason, "bad"), row(`Bruno's #${ctx.A2} after refund`, rv.reason, "bad"), row("QR signed 120 s ago", ex.reason, "bad")],
          phone: { screen: "wallet", profile: BRUNO },
        };
      },
    },
    {
      short: "Issuer compromise", actor: "Registry admin + Issuer B", cta: "Suspend, bump epoch, re-attest",
      title: "A compromised issuer key is contained in one transaction",
      desc: "Suppose Issuer B's signing key leaks. The admin suspends Issuer B: every door rejects its credentials at once. After the fix, Issuer B bumps its epoch (all old credentials become invalid) and re-attests the genuine ones under the new epoch.",
      async run(ctx) {
        const p1 = await qr(ANA, 2, ctx.B);
        const sus = await FP.api("/api/admin/issuers/2/suspend", {});
        const c1 = await FP.api("/api/doors/2/check", { payload: p1 });
        await FP.api("/api/admin/issuers/2/reactivate", {});
        const bump = await FP.api("/api/issuers/2/bump-epoch", {});
        const c2 = await FP.api("/api/doors/2/check", { payload: await qr(ANA, 2, ctx.B) });
        const re = await FP.api("/api/issuers/2/reattest", { tokenId: ctx.B });
        replaceCredential(ANA, ctx.B, re.tokenId, re.txHash);
        ctx.B = re.tokenId;
        const c3 = await FP.api("/api/doors/2/check", { payload: await qr(ANA, 2, ctx.B) });
        return {
          verdict: { tone: c3.ok ? "ok" : "bad", big: "CONTAINED", text: `Old #${re.oldTokenId} burned · re-attested as #${re.tokenId} under epoch ${re.epoch}`, tx: `suspend tx ${sus.txHash}` },
          rows: [
            row("Admin suspends Issuer B → scan of its credential", c1.reason, "bad"),
            row("Admin reactivates · Issuer B bumps epoch", `epoch ${bump.epoch}`, "info"),
            row(`Old credential #${re.oldTokenId} after the bump`, c2.reason, "bad"),
            row(`Re-attested #${re.tokenId} at Door 2`, c3.ok ? "eligible" : c3.reason, c3.ok ? "ok" : "bad"),
          ],
          phone: { screen: "wallet", profile: ANA },
        };
      },
    },
    {
      short: "Is the chain worth it?", actor: "Evaluate", cta: "Measure the cost",
      title: "What the chain costs, measured — and when it is the wrong tool",
      desc: "Gas comes from this run's own receipts. Prices are assumptions you can edit. For one artist, one seller and one door, a signed credential plus a database is cheaper and sufficient; the chain earns its place at the second issuer.",
      async run() {
        const costs = await FP.api("/api/costs");
        return { cost: costs, phone: { screen: "wallet", profile: ANA } };
      },
    },
  ];

  // ----------------------------------------------------------------- render
  function renderSteps() {
    $("steps").innerHTML = STEPS.map((s, i) => {
      const cls = i === progress.view ? "current" : i <= progress.done ? "done" : "";
      return `<button type="button" class="step ${cls}" data-i="${i}" style="width:100%;margin-bottom:6px"><span class="n">${i <= progress.done && i !== progress.view ? "✓" : i}</span><span>${esc(s.short)}</span></button>`;
    }).join("");
    $("steps").querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => goTo(Number(b.dataset.i))));
  }

  function renderStep() {
    const i = progress.view;
    const s = STEPS[i];
    $("stepNo").textContent = `STEP ${i}`;
    $("actor").textContent = s.actor;
    $("title").textContent = s.title;
    $("desc").textContent = s.desc;
    const res = progress.results[i];
    const run = $("runBtn");
    if (res) {
      run.textContent = i < STEPS.length - 1 ? `Next: ${STEPS[i + 1].short} →` : "Reset & run again";
      $("runHint").textContent = "done on-chain";
    } else {
      run.textContent = `${s.cta} →`;
      $("runHint").textContent = i > progress.done + 1 ? "runs the earlier steps first" : "";
    }
    renderResult(res);
    renderSteps();
    setPhone((res && res.phone) || { screen: i === 0 ? "empty" : "wallet", profile: ANA });
  }

  const COST_KEY = "fp.costinputs.v1";
  function costInputs() {
    try { return { gwei: 0.05, ethUsd: 2500, ...JSON.parse(localStorage.getItem(COST_KEY) || "{}") }; } catch (_) { return { gwei: 0.05, ethUsd: 2500 }; }
  }
  const usd = (x) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
  function renderCost(c) {
    const inp = costInputs();
    const gasUsd = (gas) => gas * inp.gwei * 1e-9 * inp.ethUsd;
    const m = c.measured;
    const refUsd = gasUsd(c.referenceDropGas);
    const wp = c.whitePaper;
    const ceilingUsd = (c.referenceDrop.mints + c.referenceDrop.redemptions) * wp.perTxCeilingUsd;
    const offChain = wp.designC - ceilingUsd; // OTP, email, escalation: identical in (a) and (c)
    const designCmeasured = offChain + refUsd;
    $("verdict").innerHTML = `<div class="verdict2 ok"><span class="big">${usd(gasUsd(m.redeem.avgGas))}</span><div class="txt"><span>per admission at your prices · white paper ceiling ${usd(wp.perTxCeilingUsd)}</span><span class="tx">redeem() ≈ ${m.redeem.avgGas.toLocaleString("en")} gas · mint() ≈ ${m.mint.avgGas.toLocaleString("en")} gas · measured on this chain</span></div></div>`;
    $("rows").hidden = false;
    $("rows").innerHTML = `
      <div class="rowi" style="flex-wrap:wrap;gap:16px">
        <label class="small muted" style="display:flex;align-items:center;gap:8px">Effective gas price (L2 + L1 data), gwei <input id="cGwei" type="number" step="0.001" min="0" value="${inp.gwei}" style="width:100px"></label>
        <label class="small muted" style="display:flex;align-items:center;gap:8px">ETH / USD <input id="cEth" type="number" step="1" min="0" value="${inp.ethUsd}" style="width:100px"></label>
        <span class="chip info">assumptions — edit</span>
      </div>
      <div class="rowi"><span class="l">Measured gas · ${m.mint.count} mints · ${m.redeem.count} redemptions · ${m.revoke.count} revocations</span><span class="chip info">from receipts</span></div>
      <div class="rowi"><span class="l">Reference drop: ${c.referenceDrop.mints.toLocaleString("en")} mints + ${c.referenceDrop.redemptions.toLocaleString("en")} redemptions = ${c.referenceDropGas.toLocaleString("en")} gas</span><span class="chip ok">${usd(refUsd)}</span></div>
      <div class="rowi"><span class="l">Same drop at the white paper's $0.02 ceiling</span><span class="chip info">${usd(ceilingUsd)}</span></div>
      <div class="rowi"><span class="l"><b>(a)</b> signed credential + central database (no gas)</span><span class="chip ok">$${wp.designA.min.toFixed(2)}–${wp.designA.max.toFixed(2)}</span></div>
      <div class="rowi"><span class="l"><b>(c)</b> on-chain · white paper worksheet / with measured gas</span><span class="chip bad">$${wp.designC.toFixed(2)} / ${usd(designCmeasured)}</span></div>
      <div class="rowi"><span class="l"><b>1 artist · 1 seller · 1 door</b> → the chain is the wrong tool: (a) is cheaper, faster (no block wait) and simpler to erase (LGPD).</span><span class="chip ok">use (a)</span></div>
      <div class="rowi"><span class="l"><b>2+ distrusting issuers and doors</b> → only (c) gives single-use state with no trusted operator (steps 5–6).</span><span class="chip ok">use (c)</span></div>`;
    const save = () => {
      try { localStorage.setItem(COST_KEY, JSON.stringify({ gwei: Number($("cGwei").value) || 0, ethUsd: Number($("cEth").value) || 0 })); } catch (_) {}
      renderCost(c);
    };
    $("cGwei").onchange = save;
    $("cEth").onchange = save;
  }

  function renderResult(res) {
    if (res && res.cost) return renderCost(res.cost);
    const v = res && res.verdict;
    $("verdict").innerHTML = v ? `<div class="verdict2 ${v.tone}"><span class="big">${esc(v.big)}</span><div class="txt"><span>${esc(v.text)}</span><span class="tx">${esc(v.tx)}</span></div></div>` : "";
    const rows = (res && res.rows) || [];
    $("rows").hidden = !rows.length;
    $("rows").innerHTML = rows.map((r) => `<div class="rowi"><span class="l">${esc(r.l)}</span><span class="chip ${r.tone}">${esc(r.v)}</span></div>`).join("");
  }

  let phoneKey = "";
  function setPhone(p) {
    const params = new URLSearchParams({ screen: p.screen });
    if (p.profile) params.set("profile", p.profile);
    if (p.token) params.set("token", p.token);
    if (p.tx) params.set("tx", p.tx);
    const key = params.toString();
    const labels = { empty: "empty wallet", claimed: "claimed", wallet: "wallet", presale: "drop D1", pass: "door pass" };
    $("phoneLabel").textContent = `${labels[p.screen] || p.screen}${p.profile ? " · " + p.profile : ""}`;
    if (key !== phoneKey) {
      phoneKey = key;
      $("phone").src = `phone.html?${key}`;
    }
  }

  async function renderEvents() {
    try {
      const evs = await FP.api("/api/events");
      $("events").innerHTML = evs.slice(0, 14).map((e) => {
        const color = e.name === "Redeemed" ? "var(--ok)" : e.name === "CredentialRevoked" ? "var(--bad)" : e.name === "CredentialIssued" ? "var(--accent)" : "var(--info)";
        const args = Object.entries(e.args).filter(([k]) => !["name", "key"].includes(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? "[" + v.join(",") + "]" : v.length > 20 ? FP.short(v) : v}`).join(" ");
        return `<div class="ev"><span class="b">#${e.blockNumber}</span><span style="color:${color}">${esc(e.name)}</span><span class="a">${esc(args)}</span></div>`;
      }).join("");
      $("chain").textContent = `block ${evs.length ? evs[0].blockNumber : 0}`;
    } catch (_) {}
  }

  // ---------------------------------------------------------------- actions
  async function runStep(i) {
    const res = await STEPS[i].run(progress.ctx);
    progress.results[i] = res;
    progress.done = Math.max(progress.done, i);
    save();
  }

  async function goTo(i) {
    if (busy) return;
    if (progress.results[i]) {
      progress.view = i;
      save();
      renderStep();
      return;
    }
    busy = true;
    $("runBtn").disabled = true;
    try {
      for (let k = progress.done + 1; k <= i; k++) {
        progress.view = k;
        renderSteps();
        $("verdict").innerHTML = `<div class="verdict2 wait"><span class="big">WAIT</span><div class="txt"><span>Running step ${k}: ${esc(STEPS[k].short)}… waiting for receipts</span></div></div>`;
        await runStep(k);
        await renderEvents();
      }
      progress.view = i;
      save();
      renderStep();
    } catch (e) {
      $("verdict").innerHTML = `<div class="verdict2 bad"><span class="big">ERROR</span><div class="txt"><span>${esc(e.message)}</span><span class="tx">Try “Reset chain”.</span></div></div>`;
    } finally {
      busy = false;
      $("runBtn").disabled = false;
    }
  }

  $("runBtn").onclick = () => {
    const i = progress.view;
    if (!progress.results[i]) return goTo(i);
    if (i < STEPS.length - 1) return goTo(i + 1);
    return reset();
  };

  async function reset() {
    if (busy) return;
    busy = true;
    $("runBtn").disabled = true;
    $("verdict").innerHTML = `<div class="verdict2 wait"><span class="big">RESET</span><div class="txt"><span>Deploying fresh contracts…</span></div></div>`;
    try {
      await FP.api("/api/admin/reset", {});
    } finally {
      clearLocal();
      location.reload();
    }
  }
  $("resetBtn").onclick = reset;

  async function init() {
    // A fresh server (restarted) has no invites yet: forget any wallet/progress from a previous chain.
    const outbox = await FP.api("/api/outbox");
    if (!outbox.length) {
      clearLocal();
      progress = { done: -1, view: 0, ctx: {}, results: {} };
    }
    if (progress.done < 0) await runStep(0);
    renderStep();
    renderEvents();
    setInterval(renderEvents, 4000);
  }
  init().catch((e) => FP.toast(e.message, true));
})();
