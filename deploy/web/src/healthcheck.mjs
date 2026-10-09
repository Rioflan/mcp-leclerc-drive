// Healthcheck Docker (l'image distroless n'a ni shell ni curl).
try {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/healthz`, {
    signal: AbortSignal.timeout(3000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
