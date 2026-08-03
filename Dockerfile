# Filament Library — no native modules, so the image stays small and builds fast.
# SQLite comes from Node's built-in node:sqlite, not a compiled dependency.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine

# su-exec lets the entrypoint fix up the data mount as root and then drop
# privileges before the app starts.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/filament.db \
    # A plain Linux bind mount, with no sync client touching it, is where WAL
    # works properly — so it's asked for here rather than defaulted to in the
    # code, which also has to run on a Windows folder that OneDrive is syncing.
    SQLITE_JOURNAL_MODE=WAL \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data && chown -R node:node /data /app

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Stays root only long enough for the entrypoint to chown the bind mount; the
# app itself runs as PUID:PGID (1000:1000 by default, matching the node user).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
