/* Shared browser helpers: API, navigation, the fan's HD wallet (PWA) and EIP-712 types. */
/* global ethers */

const FP = (() => {
  const NAV = [
    ["index.html", "Sandbox"],
    ["overview.html", "Overview"],
    ["issuer.html?id=1", "Issuer A"],
    ["issuer.html?id=2", "Issuer B"],
    ["outbox.html", "Fan inbox / phone"],
    ["wallet.html", "Fan wallet"],
    ["door.html?id=1", "Door 1"],
    ["door.html?id=2", "Door 2"],
    ["seller.html", "Ticket seller"],
  ];

  function renderNav() {
    const here = location.pathname.split("/").pop() + location.search;
    const header = document.createElement("header");
    header.className = "top";
    header.innerHTML = `<a class="brand" href="index.html">Fan<span>Passport</span> <span class="muted small" style="color:var(--muted)">MVP</span></a><nav></nav>`;
    const nav = header.querySelector("nav");
    for (const [href, label] of NAV) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = label;
      if (here === href || (here === "" && href === "index.html")) a.classList.add("active");
      nav.appendChild(a);
    }
    document.body.prepend(header);
  }

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(path, opts);
    const isJson = (res.headers.get("content-type") || "").includes("json");
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(msg, bad = false) {
    const el = document.createElement("div");
    el.className = "toast" + (bad ? " bad" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");
  const param = (k) => new URLSearchParams(location.search).get(k);

  let stateCache = null;
  async function state() {
    if (!stateCache) stateCache = await api("/api/state");
    return stateCache;
  }

  // ------------------------------------------------------------- fan wallet
  // One HD wallet per fan profile; a distinct address per issuer (path m/44'/60'/0'/0/<issuerId>).
  const WALLET_KEY = "fp.wallet.v1";
  const LIVE_QR_KEY = "fp.liveqr.v1";

  function safeGet(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch (_) {
      return fallback;
    }
  }
  function safeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function loadWallet() {
    return safeGet(WALLET_KEY, { profiles: {}, active: null });
  }
  function saveWallet(w) {
    safeSet(WALLET_KEY, w);
  }
  function ensureProfile(name) {
    const w = loadWallet();
    if (!w.profiles[name]) w.profiles[name] = { mnemonic: ethers.Wallet.createRandom().mnemonic.phrase, credentials: [] };
    w.active = name;
    saveWallet(w);
    return w;
  }
  function signerFor(profileName, issuerId) {
    const p = loadWallet().profiles[profileName];
    const root = ethers.HDNodeWallet.fromPhrase(p.mnemonic, undefined, "m/44'/60'/0'/0");
    return root.deriveChild(Number(issuerId));
  }
  function addCredential(profileName, cred) {
    const w = loadWallet();
    const list = w.profiles[profileName].credentials;
    if (!list.find((c) => c.tokenId === cred.tokenId)) list.push(cred);
    saveWallet(w);
  }

  function publishLiveQr(key, entry) {
    const all = safeGet(LIVE_QR_KEY, {});
    all[key] = entry;
    safeSet(LIVE_QR_KEY, all);
  }
  function liveQrs(maxAgeSec = 90) {
    const all = safeGet(LIVE_QR_KEY, {});
    const now = Date.now() / 1000;
    return Object.entries(all).filter(([, e]) => now - e.at <= maxAgeSec);
  }

  const holderProofTypes = {
    HolderProof: [
      { name: "credentialId", type: "uint256" },
      { name: "dropId", type: "uint256" },
      { name: "issuedAt", type: "uint64" },
    ],
  };
  async function signHolderProof(wallet, credentialId, dropId, issuedAt) {
    const s = await state();
    const domain = { name: "FanPassport", version: "1", chainId: s.chainId, verifyingContract: s.contracts.RedemptionGate };
    const value = { credentialId: String(credentialId), dropId: String(dropId), issuedAt: String(issuedAt) };
    const sig = await wallet.signTypedData(domain, holderProofTypes, value);
    return JSON.stringify({ ...value, sig });
  }

  const REASONS = {
    AlreadyRedeemed: "This credential was already redeemed for this drop (shared on-chain state).",
    Revoked: "The issuer revoked this credential (e.g. refund or chargeback).",
    ProofExpired: "The QR is stale - it must be signed by the holder's phone within the last 60 s.",
    BadHolderProof: "The QR was not signed by the key that holds this credential (screenshot / stolen code).",
    MalformedQR: "This is not a FanPassport QR.",
    UnknownCredential: "No such credential on-chain.",
    IssuerSuspended: "The issuer is suspended in the registry.",
    StaleEpoch: "The issuer bumped its epoch; this credential must be re-attested.",
    IssuerNotAccepted: "This drop does not accept credentials from that issuer.",
    UnknownDrop: "Unknown drop.",
    NotADoor: "This device is not a registered door.",
  };

  return { renderNav, api, toast, esc, short, param, state, loadWallet, saveWallet, ensureProfile, signerFor, addCredential, publishLiveQr, liveQrs, signHolderProof, REASONS };
})();

document.addEventListener("DOMContentLoaded", () => {
  if (!window.FP_NO_NAV) FP.renderNav();
});
