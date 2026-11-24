// Wraps the demo app so the sandbox can reset everything without restarting the process:
// POST /api/admin/reset deploys fresh contracts (Step 0 again) and drops all off-chain state.
const express = require("express");
const { createSystem } = require("./system");
const { createApp } = require("./app");

async function createServer(ethers) {
  let current = { system: await createSystem(ethers) };
  current.app = createApp(current.system);

  const server = express();
  server.post("/api/admin/reset", async (_req, res) => {
    try {
      const system = await createSystem(ethers);
      current = { system, app: createApp(system) };
      res.json({ ok: true, contracts: { RedemptionGate: await system.contracts.gate.getAddress() } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  server.use((req, res, next) => current.app(req, res, next));
  server.current = () => current;
  return server;
}

module.exports = { createServer };
