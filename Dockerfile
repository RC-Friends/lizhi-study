FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 STORAGE_DRIVER=postgres RESOURCE_DRIVER=s3 SERVE_FRONTEND=false
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY scripts/import-legacy.mjs scripts/package-resources.mjs scripts/upload-resources.mjs ./scripts/
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3210/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/index.mjs"]
