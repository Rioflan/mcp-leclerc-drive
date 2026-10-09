# Service web : interface + planificateur + ntfy. Aucune dépendance npm
# d'exécution ; image finale distroless (ni shell ni gestionnaire de paquets).
# Mise à jour des digests : docker buildx imagetools inspect <image>

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS test
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY test/ ./test/
RUN npm test \
 && mkdir -p /out/data \
 && chown 65532:65532 /out/data

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
WORKDIR /app
COPY --from=test /app/package.json ./
COPY --from=test /app/src/ ./src/
COPY --from=test /app/public/ ./public/
# Répertoire de données appartenant à l'utilisateur nonroot (65532) : un volume
# nommé monté ici en hérite.
COPY --from=test --chown=65532:65532 /out/data /data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
USER 65532:65532
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "src/healthcheck.mjs"]

CMD ["src/main.mjs"]
