// Healthcheck Docker, sans contacter Leclerc Drive : le bridge s'il est activé,
// sinon Chrome (mode MCP seul).
const url = process.env.BRIDGE_TOKEN
  ? `http://127.0.0.1:${process.env.BRIDGE_PORT || 8000}/health`
  : `http://127.0.0.1:${process.env.LECLERC_CHROME_PORT || 9222}/json/version`;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
