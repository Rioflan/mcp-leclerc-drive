#!/usr/bin/env bash
# Liste les articles du panier Leclerc Drive en rupture de stock.
# Passe par le conteneur navigateur (Chrome connecté + MCP compilé depuis la source).
#
# Usage : scripts/ruptures.sh          → liste lisible
#         scripts/ruptures.sh --json   → JSON (pour d'autres scripts)
# Variable : LECLERC_CONTAINER (défaut : leclerc-drive)
set -euo pipefail

container=${LECLERC_CONTAINER:-leclerc-drive}
args=()
case "${1:-}" in
  --json) args=(--json) ;;
  "") ;;
  -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
  *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
esac

if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
  echo "Le conteneur $container ne tourne pas (docker compose up -d)." >&2
  exit 2
fi

exec docker exec "$container" node /app/bridge/ruptures.mjs "${args[@]}"
