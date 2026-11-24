# FanPassport — PD3 MVP

**Fair access to the shows fans love.** Group 5 · INE5458 Blockchain and Cryptocurrencies Technologies · UFSC

FanPassport turns the shows you have really been to into a pass for the next one. An issuer (artist, promoter or label) turns its own attendance and merch records into **non-transferable credentials**; each fan gets a **single-use presale code** for the seller; at the door, a **rotating QR signed by the fan's key** is checked and the credential is **redeemed on-chain**, so a second door — run by a different issuer — rejects it.

This repository is the MVP described in the Technical White Paper, built test-first. It stages the one scenario where the chain earns its place (Table 3, row 10): **two issuers and two doors sharing redemption state without a trusted operator**.

> For one artist, one seller and one door, a signed credential plus a database is cheaper and sufficient. The chain's threshold is the second issuer. This MVP demonstrates that mechanism; it does not claim a single pilot needs a chain.

---

## Quick start

Requires Node.js 18+ (22 recommended). No compiler download is needed: Solidity 0.8.24 comes from the `solc` npm package.

```bash
npm install
npm test           # 111 tests: contracts, off-chain rules, API end to end
npm start          # deploys to an in-process chain and serves http://localhost:3000
```

Other commands:

| Command | What it does |
|---|---|
| `npm run demo:cli` | Runs the whole Appendix A demo script in the terminal (backup run for the pitch) |
| `npm run chain` + `npm run start:localhost` | Same app against a separate Hardhat node at `127.0.0.1:8545` |
| `REPORT_GAS=1 npm run test:contracts` | Gas per `mint` / `redeem` / `revoke` |
| `npx hardhat run scripts/deploy.js --network baseSepolia` | Deploys the contracts to Base Sepolia (set `DEPLOYER_PRIVATE_KEY`; `arbitrumSepolia` also configured) |

Chain state lives in memory: restarting `npm start` resets the demo. To reset the fan wallets too, clear the site data for `localhost:3000` in the browser.

---

## Live demo walkthrough (≈5 min)

Open `http://localhost:3000` — the overview shows the contracts, the issuer registry and a live on-chain event log.

| Step | Where | What to click | What it shows |
|---|---|---|---|
| 0 | Overview | — (done at start-up) | Admin registered Issuer A, Issuer B, their doors, and joint drop D1 |
| 1 | **Issuer A** | *Load sample export* → *Apply rules & send claim invites* | Carla (not checked in) and Ana's duplicate row are rejected |
| 1 | **Fan inbox** | *Request a claim link* for `mallory@example.com` | A non-listed email is refused |
| 1 | **Fan inbox** | Ana's *Claim my credential* → type the one-time code → *Sign & claim* | OTP + wallet signature; relayer mints credential A (gas sponsored) |
| 1 | **Fan inbox** | Same for Bruno | Credential A2 (used in step 7) |
| 2 | **Issuer B** | Load sample → apply rules; then Ana claims from the inbox | Order below $15, refunded, unpaid and inside the 14-day hold are rejected |
| 3 | **Fan wallet** (Ana) | *Try to transfer* | `Soulbound()` revert — ERC-5192 locked token; two addresses, one per issuer |
| — | Issuer A → *Upload code list*; Wallet → *Reveal presale code*; **Ticket seller** | Buy twice with the same code | Soft gate: the code works once; the seller never sees names |
| 4 | **Wallet** → *Show door QR*; **Door 1** → *Scan live QR from this device's wallet* | Tick the ID check → *Redeem on-chain & admit* | ADMIT only after the receipt shows success |
| 5 | **Door 2** → scan the same QR within 60 s | — | REJECT `AlreadyRedeemed`, citing Door 1's tx; *Force-submit* shows the contract itself reverts |
| 6 | Wallet → QR of credential B; **Door 2** | Redeem | ADMIT; Door 2 name-checks only its own issuer's credentials |
| 7 | Door 1 re-scan · Issuer A *Revoke* Bruno's A2 · Wallet *Expired QR (test)* | — | `AlreadyRedeemed`, `Revoked`, `ProofExpired` |

Tip: put the wallet and a door side by side in two browser windows.

---

## Test-driven development

Tests were written before the code (see the commit history: red → green). The acceptance criteria are the white paper's demo script, written as Gherkin in [`docs/demo-script.feature`](docs/demo-script.feature), and automated at three levels:

| Suite | File | Covers |
|---|---|---|
| Contract acceptance | `test/contracts/demoScript.test.js` | Appendix A steps 0–7 directly on the contracts, plus attack cases (forged/tampered attestations, wrong holder key, replay across drops, non-door callers, unaccepted issuer, clock skew) |
| Issuer lifecycle | `test/contracts/issuerRegistry.test.js` | Suspension, epoch bump + re-attestation, 24 h timelocked key rotation, door registration, admin handover |
| Off-chain rules | `test/lib/*.test.js` | TOTP against RFC 4226/6238 vectors, presale-code derivation (HKDF + HMAC, base32), identity commitments, eligibility rules, CSV parsing |
| End to end (API) | `test/api/demoScript.api.test.js` | The full demo script through the same HTTP API the pages use, including "no personal data in any on-chain event" |

CI runs `npm test` and the CLI demo on every push (`.github/workflows/test.yml`).

---

## Architecture

```
 Issuer A portal ─┐                         ┌─ Door 1 (Issuer A)
 Issuer B portal ─┤  issuer-signed EIP-712  │  holder-signed EIP-712 QR
                  ▼  attestation            ▼  (refreshed every 30 s)
            ┌──────────────┐  mint   ┌───────────────┐  redeem()  ┌────────────────┐
 relayer ──▶│ FanCredential│◀────────│ IssuerRegistry│───────────▶│ RedemptionGate │◀── Door 2 (Issuer B)
 (pays gas) │ ERC-721 +    │  keys,  │ issuers, keys,│  doors     │ drops + single │
            │ ERC-5192     │  epochs │ epochs, doors │            │ -use flags     │
            └──────────────┘         └───────────────┘            └────────────────┘
```

| Contract | Responsibility |
|---|---|
| `IssuerRegistry` | Permissioned issuer list (admin = team multisig in the white paper, handover via `transferAdmin`), suspension, epochs for compromise recovery, 24 h timelocked key rotation, door registration |
| `FanCredential` | Locked ERC-721 (ERC-5192). Minted by anyone (the relayer) against an EIP-712 attestation signed by an active issuer's key. One credential per identity commitment per event. Revocation and burning by the issuer or admin |
| `RedemptionGate` | Drops and their accepted issuers. `redeem()` checks the door, the drop, single-use state, credential validity, accepted issuer, proof freshness (≤ 60 s) and that the QR was signed by the credential holder — then sets the redeemed flag once |

On-chain data: issuerId, credType, eventId, identity commitment, status and redemption flags. Off-chain (issuer-held): names, emails, phones, order contents, check-in logs, salts, code lists.

Off-chain pieces (`lib/`): eligibility rules (paid, not refunded, ≥ $15, 14-day hold, one record per identity, ≤ 2 identities per phone), identity commitment (HMAC under a per-issuer secret), presale code (HMAC-SHA256 keyed by HKDF(master key, salt = dropId), 8 base32 chars), and TOTP for the claim OTP — ported from our INE5680 project [security-mini-blockchain](https://github.com/LukasThome/security-mini-blockchain).

Measured gas (Hardhat, optimizer on): `mint` ≈ 241k, `redeem` ≈ 87k, `revoke` ≈ 39k.

## What is mocked (per the white paper's MVP scope)

- All fan data is synthetic (`data/*.csv`).
- E-mail and SMS/OTP delivery are a mock inbox; the ticket seller is a mock page that accepts uploaded code lists.
- ID checks are a staff checkbox; payments do not exist.
- Joint-drop consent is mocked by a single drop creator (the admin).
- All off-chain actors (both issuers, both doors, the relayer, the seller) run in one Node process, each with its own key. Each door still decides only from the signed QR and the shared chain state.
- The demo runs on a local Hardhat chain; `scripts/deploy.js` targets Base Sepolia / Arbitrum Sepolia for the public-testnet run.

## Known limits (honest list)

- A presale code can still be passed on; we raise the cost of scalping (locked credential, rotating QR, name-matched door check), we do not eliminate it.
- The chain records the issuer's claim; it does not make the activity true. A colluding issuer can mint sybil credentials (mitigated by the registry, the public issuance log and revocation).
- The admin is a standing trust assumption until handover to an issuers' multisig.
- The fan's key lives in the browser (`localStorage`): losing it means re-issuance.
- Offline doors (bounded double-entry window) and ZK privacy are roadmap, not MVP.

## Team

- Arthur Bastos — Programming and Software Engineering, backend + frontend
- Felix Gebhardt — Engineering and Strategy
- Lucas Thomé da Silva — Quality Assurance Engineering, software testing

License: MIT
