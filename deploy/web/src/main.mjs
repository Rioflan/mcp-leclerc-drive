// Point d'entrée du service web.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { LoginLimiter, SessionStore } from "./auth.mjs";
import { AlertStore } from "./store.mjs";
import { Ntfy } from "./ntfy.mjs";
import { BridgeClient } from "./bridge-client.mjs";
import { Scheduler } from "./scheduler.mjs";
import { createApp, loadStatic } from "./server.mjs";
import { formatDuration } from "./duration.mjs";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const store = await new AlertStore(config.dataDir).load();
const notifier = new Ntfy(config.ntfy);
const bridge = new BridgeClient({ url: config.bridgeUrl, token: config.bridgeToken });
const scheduler = new Scheduler({ store, bridge, notifier, config });
const staticFiles = await loadStatic(fileURLToPath(new URL("../public/", import.meta.url)));

const handler = createApp({
  config,
  staticFiles,
  sessions: new SessionStore({ ttlMs: config.sessionTtlMs }),
  limiter: new LoginLimiter(),
  store,
  bridge,
  notifier,
  scheduler,
});

const server = createServer(handler);
// La recherche et la vérification manuelle passent par le site (lent, throttlé).
server.requestTimeout = 5 * 60_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, () => {
  scheduler.start();
  console.error(
    `web prêt sur :${config.port} — vérification toutes les ${formatDuration(config.checkIntervalMs)}` +
      ` + 0 à ${formatDuration(config.checkJitterMs)}, notifications ${notifier.describe()}`,
  );
});

async function shutdown() {
  scheduler.stop();
  server.close();
  await store.writing.catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
