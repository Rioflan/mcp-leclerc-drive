# syntax=docker/dockerfile:1
# Conteneur navigateur : Chrome dans un écran virtuel (Xvfb), accessible via noVNC
# pour se connecter une fois à Leclerc Drive, le serveur MCP compilé depuis la
# source du dépôt et le bridge HTTP interne utilisé par le conteneur web.
# Le port CDP (9222) reste en loopback dans le conteneur.
#
# Contexte de build : la racine du dépôt (voir deploy/compose.yaml).
# Mise à jour du digest : docker buildx imagetools inspect node:22-bookworm-slim

# ---- Compilation du serveur MCP (src/ → dist/) ----
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
RUN npx tsc \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && chmod 0755 dist/index.js

# ---- Image d'exécution ----
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Chrome stable (dépôt signé Google) + écran virtuel + VNC/noVNC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      xvfb x11vnc novnc python3-websockify \
      fonts-liberation fonts-noto-color-emoji \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/google-chrome.list

# Utilisateur non-root dédié ; tout l'état persistant vit dans /data.
RUN useradd --uid 10001 --create-home --home-dir /data --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules/ ./node_modules/
COPY --from=build /src/dist/ ./dist/
COPY deploy/browser/src/ ./bridge/
COPY --chmod=0755 deploy/browser/chrome-wrapper.sh deploy/browser/entrypoint.sh /usr/local/bin/
# Commande attendue par la configuration MCP : docker exec -i leclerc-drive mcp-leclerc-drive
RUN ln -s /app/dist/index.js /usr/local/bin/mcp-leclerc-drive

ENV HOME=/data \
    DISPLAY=:99 \
    LECLERC_CHROME_PATH=/usr/local/bin/chrome-wrapper.sh \
    LECLERC_CHROME_PROFILE_DIR=/data/chrome \
    LECLERC_CHROME_PORT=9222

USER 10001:10001
VOLUME /data
# 6080 : noVNC (publié en loopback) ; 8000 : bridge (réseau interne uniquement).
EXPOSE 6080 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/bridge/healthcheck.mjs"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
