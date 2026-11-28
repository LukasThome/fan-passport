/* Fan phone app shown inside the sandbox's iPhone frame. Reads the same browser wallet (localStorage). */
/* global FP, qrcode */
(() => {
  const app = document.getElementById("app");
  const q = new URLSearchParams(location.search);
  const screen = q.get("screen") || "wallet";
  const wallet = FP.loadWallet();
  const profile = q.get("profile") || wallet.active;
  const token = q.get("token") ? Number(q.get("token")) : null;
  const esc = FP.esc;
  const creds = (profile && wallet.profiles[profile] && wallet.profiles[profile].credentials) || [];
  const link = (s, extra = {}) => `phone.html?${new URLSearchParams({ screen: s, ...(profile ? { profile } : {}), ...extra })}`;
  const initials = (n) => (n || "?").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();

  const ICON = {
    wallet: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="5" width="20" height="15" rx="3"/><path d="M16 12h2M2 9h20"/></svg>',
    qr: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3z"/></svg>',
    ticket: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z"/></svg>',
    music: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    shirt: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.4 6.6 16 3a4 4 0 0 1-8 0L3.6 6.6 5 11l2-1v11h10V10l2 1z"/></svg>',
    check: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  function top() {
    return `<div class="ph-top"><div class="avatar">${esc(initials(profile))}</div>
      <div style="display:flex;flex-direction:column;flex-grow:1"><span class="small muted">FanPassport</span><span style="font:600 17px var(--display)">${esc(profile || "No wallet yet")}</span></div>
      <span class="hdr-chip" style="border:1px solid var(--line);border-radius:999px;padding:5px 10px"><span class="dot"></span>Local chain</span></div>`;
  }
  function nav(active) {
    const first = creds[0];
    const a = (s, label, icon, extra) => `<a href="${link(s, extra)}" class="${active === s ? "on" : ""}">${icon}${label}</a>`;
    return `<nav class="ph-nav">${a("wallet", "Wallet", ICON.wallet)}${a("pass", "Pass", ICON.qr, first ? { token: first.tokenId } : {})}${a("presale", "Drops", ICON.ticket, first ? { token: first.tokenId } : {})}</nav>`;
  }
  const render = (html, active) => (app.innerHTML = `${top()}<div class="ph-body" style="margin-top:18px">${html}</div>${active ? nav(active) : ""}`);

  // ------------------------------------------------------------------ screens
  function empty() {
    render(`<div class="center" style="display:flex;flex-direction:column;gap:14px;margin-top:150px">
      <div class="card" style="width:64px;height:64px;display:flex;align-items:center;justify-content:center;color:var(--accent);padding:0">${ICON.wallet}</div>
      <span style="font:600 22px var(--display)">Your FanPassport</span>
      <span class="muted" style="line-height:1.5">No credentials yet. Go to a show or buy official merch — the issuer will invite you to claim.</span></div>`);
  }

  function claimed() {
    const c = creds.find((x) => x.tokenId === token) || {};
    render(`<div class="center" style="display:flex;flex-direction:column;gap:14px;margin-top:70px">
      <div style="width:72px;height:72px;border-radius:22px;background:var(--ok-bg);color:var(--ok);display:flex;align-items:center;justify-content:center">${ICON.check}</div>
      <span style="font:600 24px var(--display)">Credential claimed</span>
      <span class="muted">${esc(c.issuerShort || "")} · ${esc(c.eventName || "")}</span></div>
      <div class="card" style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        <div class="kv"><span class="k">Token</span><span>#${token} · locked</span></div>
        <div class="kv"><span class="k">Holder</span><span class="mono">${FP.short(c.holder || "")}</span></div>
        <div class="kv"><span class="k">Network fee</span><span style="color:var(--ok);font-weight:600">Sponsored · $0.00</span></div>
        <div class="kv"><span class="k">On-chain data</span><span>no name, email or phone</span></div>
        <span class="mono muted" style="font-size:11px">tx ${esc(q.get("tx") || c.txHash || "")}</span>
      </div>
      <a class="btn" style="text-align:center;margin-top:8px" href="${link("wallet")}">Open wallet</a>`, "wallet");
  }

  async function walletScreen() {
    const items = [];
    let validCount = 0;
    for (const c of creds) {
      let st = null;
      try { st = await FP.api(`/api/credentials/${c.tokenId}`); } catch (_) {}
      if (st && st.valid) validCount++;
      const label = { Revoked: "Revoked", IssuerSuspended: "Suspended", StaleEpoch: "Re-issue pending" };
      const chip = !st ? '<span class="chip bad">not on chain</span>' : st.valid ? `<span class="chip ok">${st.redeemedInD1 ? "Used D1" : "Valid"}</span>` : `<span class="chip bad">${label[st.status] || "Invalid"}</span>`;
      items.push(`<div class="card cred-row"><div class="cred-ic i${c.issuerId}">${c.credType === 2 ? ICON.shirt : ICON.music}</div>
        <div style="display:flex;flex-direction:column;gap:2px;flex-grow:1;min-width:0"><span style="font-weight:600">${c.credType === 2 ? "Merch-qualified" : "Attended"} · ${esc(c.issuerShort)}</span>
        <span class="small muted">${esc(c.eventName)}</span><span class="mono muted" style="font-size:11.5px">${FP.short(c.holder)}</span></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><span class="mono small">#${c.tokenId}</span>${chip}</div></div>`);
    }
    const first = creds[0];
    render(`<div class="card hero" style="display:flex;flex-direction:column;gap:14px">
        <div class="kv"><span class="eyebrow">Fan reputation</span><span class="mono muted" style="font-size:12px">HD wallet · ${creds.length} address${creds.length === 1 ? "" : "es"}</span></div>
        <div style="display:flex;align-items:baseline;gap:10px"><span class="big-num">${creds.length}</span><span style="color:#C9CFDA">soulbound credential${creds.length === 1 ? "" : "s"}</span></div>
        <div style="display:flex;gap:8px">${first ? `<a class="btn" style="flex:1;text-align:center" href="${link("pass", { token: first.tokenId })}">Door pass</a><a class="btn secondary" style="flex:1;text-align:center" href="${link("presale", { token: first.tokenId })}">Presale code</a>` : ""}</div>
      </div>
      <div class="kv" style="margin-top:6px"><span class="sec-title" style="margin:0">Credentials</span><span class="small muted">Locked · ERC-5192</span></div>
      ${items.join("") || '<div class="card muted">No credentials in this wallet.</div>'}
      <span class="sec-title">Open drops</span>
      <div class="card" style="border-style:dashed;display:flex;align-items:center;gap:12px"><div style="display:flex;flex-direction:column;flex-grow:1"><span style="font-weight:600">D1 · Summer Tour 2027</span><span class="small muted">Joint presale · Issuer A + B</span></div>
      <span class="chip" style="border:1px solid var(--accent);color:var(--accent)">${validCount ? "Eligible" : "Not eligible"}</span></div>`, "wallet");
  }

  function pass() {
    const c = creds.find((x) => x.tokenId === token) || creds[0];
    if (!c) return empty();
    render(`<div class="card hero" style="display:flex;flex-direction:column;gap:16px">
        <div class="kv"><span style="font-weight:600;display:flex;align-items:center;gap:8px"><span class="dot" style="background:var(--accent)"></span>Live · signed by your key</span><span class="mono" id="cd" style="color:var(--accent)">0:30</span></div>
        <div class="qrbox" id="qr"></div>
        <div class="bar"><div id="bar" style="width:100%"></div></div>
        <span class="small muted center" style="line-height:1.5">New signature every 30 s. A screenshot goes stale in 60 s.</span>
      </div>
      <div class="card" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
        <div><div class="small muted">Credential</div><b>#${c.tokenId} · ${c.credType === 2 ? "Merch" : "Attended"}</b></div>
        <div><div class="small muted">Issuer</div><b>${esc(c.issuerShort)}</b></div>
        <div><div class="small muted">Holder</div><span class="mono">${FP.short(c.holder)}</span></div>
        <div><div class="small muted">Drop</div><b>D1</b></div>
      </div>`, "pass");
    const w = FP.signerFor(profile, c.issuerId);
    let issuedAt = 0;
    async function refresh() {
      issuedAt = Math.floor(Date.now() / 1000);
      const payload = await FP.signHolderProof(w, c.tokenId, 1, issuedAt);
      const qr = qrcode(0, "M");
      qr.addData(payload);
      qr.make();
      document.getElementById("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
      FP.publishLiveQr(`${profile}#${c.tokenId}`, { label: `${profile} · ${c.issuerShort} credential #${c.tokenId}`, payload, at: issuedAt });
    }
    refresh();
    setInterval(() => {
      const left = 30 - (Math.floor(Date.now() / 1000) - issuedAt);
      document.getElementById("cd").textContent = `0:${String(Math.max(left, 0)).padStart(2, "0")}`;
      document.getElementById("bar").style.width = `${Math.max(left, 0) / 30 * 100}%`;
      if (left <= 0) refresh();
    }, 1000);
  }

  async function presale() {
    const c = creds.find((x) => x.tokenId === token) || creds[0];
    if (!c) return empty();
    const issuedAt = Math.floor(Date.now() / 1000);
    let code = "--------";
    try {
      const signature = await FP.signerFor(profile, c.issuerId).signMessage(`FanPassport code request ${c.tokenId} 1 ${issuedAt}`);
      code = (await FP.api("/api/wallet/code", { tokenId: c.tokenId, dropId: 1, issuedAt, signature })).code;
    } catch (_) {}
    let used = false;
    try { used = (await FP.api("/api/seller/codes")).some((x) => x.code === code && x.used); } catch (_) {}
    render(`<div><span style="font:600 20px var(--display)">Drop D1</span><div class="small muted">Summer Tour 2027 · Florianópolis</div></div>
      <div class="card hero" style="display:flex;flex-direction:column;gap:14px">
        <div class="kv"><span class="eyebrow">Your presale code</span><span class="chip" style="border:1px solid var(--accent);color:var(--accent)">Single use</span></div>
        <div class="code8">${code.split("").map((ch) => `<span>${esc(ch)}</span>`).join("")}</div>
        <span class="small muted" style="line-height:1.5">Bound to credential #${c.tokenId}. The seller only ever sees the code — no name, no wallet.</span>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:12px">
        <div class="kv"><span class="k">Ticket seller</span><span>mock · uploaded code list</span></div>
        <div class="kv"><span class="k">Name on the order</span><span>${esc(profile)}</span></div>
        ${used ? `<div class="chip ok" style="padding:12px 14px;border-radius:12px;font-size:13.5px">Code accepted · presale ticket reserved</div>` : `<div class="chip info" style="padding:12px 14px;border-radius:12px;font-size:13.5px">Not used yet</div>`}
      </div>`, "presale");
  }

  const screens = { empty, claimed, wallet: walletScreen, pass, presale };
  (screens[screen] || walletScreen)();
})();
