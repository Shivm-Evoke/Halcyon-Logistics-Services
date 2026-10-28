# One container: the Express API, the risk model and the inbound gateway, also serving the built React site.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim
# psql loads the dataset into an empty database on first start
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json server/
RUN npm --prefix server ci --omit=dev
COPY server/ server/
COPY db/ db/
COPY ingest/ ingest/
COPY --from=web /web/dist web/dist
ENV NODE_ENV=production INBOX_WATCH=0 PORT=4000
EXPOSE 4000
CMD ["bash", "server/scripts/start.sh"]
