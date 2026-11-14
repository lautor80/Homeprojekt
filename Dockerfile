# ---------- Build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------- Laufzeit ----------
FROM node:22-bookworm-slim
# aktive Version (Uhrzeit und Kennung des Commits) – setzt die CI, angezeigt in der Kopfzeile neben dem Logo
ARG BUILD_SHA=
ARG BUILD_ZEIT=
ENV NODE_ENV=production \
    APP_ROOT=/app \
    PORT=8080 \
    PORTAL_VERSION_SHA=$BUILD_SHA \
    PORTAL_VERSION_ZEIT=$BUILD_ZEIT
WORKDIR /app
# Texterkennung für eingefügte Screenshots und PDFs (Euroflex: Kontaktdaten einfügen, #158) – läuft lokal im Container
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-deu poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/modules ./modules
# Sicherungsordner der Portal-Sicherung (Volume); nächtliche pg_dump-Sicherungen werden lesend eingebunden
RUN mkdir -p /app/data/sicherungen /app/data/backups && chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
