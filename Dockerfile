# Filament Library — no native modules, so the image stays small and builds fast.
# SQLite comes from Node's built-in node:sqlite, not a compiled dependency.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/filament.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# The DB lives on a volume; make it writable by the unprivileged runtime user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
