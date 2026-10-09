#!/bin/sh
# Lancé à la place de Chrome (par l'entrypoint et par le serveur MCP).
# --no-sandbox : le sandbox interne de Chrome a besoin de user namespaces que le
# profil seccomp par défaut de Docker interdit ; c'est le conteneur durci
# (non-root, sans capabilities, rootfs en lecture seule) qui sert d'isolation.
exec /usr/bin/google-chrome-stable \
  --no-sandbox \
  --disable-dev-shm-usage \
  --window-size=1280,900 \
  --window-position=0,0 \
  "$@"
