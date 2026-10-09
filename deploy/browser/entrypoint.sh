#!/bin/bash
# Démarre l'écran virtuel, le VNC (protégé par mot de passe), noVNC, Chrome et,
# si BRIDGE_TOKEN est défini, le bridge HTTP interne utilisé par le conteneur web.
# Le serveur MCP n'est pas lancé ici : Claude Code le démarre à la demande via
# `docker exec -i leclerc-drive mcp-leclerc-drive`, et il réutilise ce Chrome.
set -euo pipefail

mkdir -p /data/.vnc "$LECLERC_CHROME_PROFILE_DIR"
chmod 700 /data/.vnc

# Mot de passe VNC généré au premier démarrage (VNC limite à 8 caractères).
if [[ ! -s /data/.vnc/passwd ]]; then
  pw=$(head -c 6 /dev/urandom | base64 | tr '+/' '-_')
  x11vnc -storepasswd "$pw" /data/.vnc/passwd >/dev/null 2>&1
  printf '%s\n' "$pw" > /data/.vnc/password.txt
  chmod 600 /data/.vnc/passwd /data/.vnc/password.txt
fi

# Magasin fourni par l'environnement, appliqué seulement si aucun n'est encore
# choisi (la détection depuis l'interface reste prioritaire ensuite).
store_file=/data/.mcp-leclerc-drive/config.json
if [[ -n "${LECLERC_STORE_ID:-}" && ! -s "$store_file" ]]; then
  nopr=${LECLERC_STORE_NOPR:-$LECLERC_STORE_ID}
  host=${LECLERC_HOST:-}
  if [[ ! "$LECLERC_STORE_ID$nopr" =~ ^[0-9]{12}$ || ! "$host" =~ ^fd[0-9]+-courses\.leclercdrive\.fr$ ]]; then
    echo "LECLERC_STORE_ID/LECLERC_STORE_NOPR (6 chiffres) ou LECLERC_HOST (fdN-courses.leclercdrive.fr) invalides." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$store_file")"
  printf '{\n  "storeId": "%s",\n  "noPR": "%s",\n  "host": "%s"\n}\n' \
    "$LECLERC_STORE_ID" "$nopr" "$host" > "$store_file"
fi

# Verrous laissés par un arrêt brutal du conteneur précédent.
rm -f "$LECLERC_CHROME_PROFILE_DIR"/Singleton{Lock,Socket,Cookie}

# Répertoire des sockets X (sur le tmpfs /tmp), qu'Xvfb ne peut pas créer sans root.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
xvfb=$!
for _ in $(seq 50); do [[ -e /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done

x11vnc -display :99 -rfbport 5900 -localhost -rfbauth /data/.vnc/passwd \
  -forever -shared -quiet &
vnc=$!

websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
ws=$!

# Page d'ouverture : le magasin enregistré s'il y en a un (la détection depuis
# l'onglet retrouve alors aussi son nom), sinon l'accueil Leclerc Drive.
# shellcheck disable=SC2016  # ${…} est un template literal JavaScript, pas du shell.
start_url=$(node -e '
  try {
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!/^fd\d+-courses\.leclercdrive\.fr$/.test(s.host) || !/^\d{6}$/.test(s.storeId + "") || !/^\d{6}$/.test(s.noPR + "")) throw 0;
    const slug = typeof s.name === "string" ? "-" + encodeURIComponent(s.name.replace(/\s+/g, "-")) : "";
    console.log(`https://${s.host}/magasin-${s.storeId}-${s.noPR}${slug}/`);
  } catch { console.log("https://www.leclercdrive.fr/"); }
' "$store_file")

# Même port / profil que ceux qu'utilise le serveur MCP, qui le réutilisera.
chrome-wrapper.sh \
  --remote-debugging-port="$LECLERC_CHROME_PORT" \
  --user-data-dir="$LECLERC_CHROME_PROFILE_DIR" \
  --no-first-run --no-default-browser-check \
  "$start_url" >/dev/null 2>&1 &

pids=("$xvfb" "$vnc" "$ws")
if [[ -n "${BRIDGE_TOKEN:-}" ]]; then
  node /app/bridge/bridge.mjs &
  pids+=("$!")
fi

echo "Prêt. noVNC : port 6080 (mot de passe : /data/.vnc/password.txt)" >&2

# Si un service d'infrastructure tombe, on sort pour que Docker redémarre le conteneur.
wait -n "${pids[@]}"
