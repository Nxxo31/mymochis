FROM node:24-alpine AS webbuild
WORKDIR /app

# Las islas React (hero shader + motion) se compilan con Vite: public/build/
# esta gitignored, asi que el bundle SOLO existe si se construye aqui.
# Spec: PROJECT.md §21.11 Ola 2.
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY vite.config.ts tsconfig.json ./
RUN npm run build:web

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY --from=webbuild /app/public/build ./public/build

RUN mkdir -p /var/data/uploads && chown -R node:node /var/data

USER node

ENV NODE_ENV=production
ENV PORT=3737
ENV NEXOMOCHIS_DB_PATH=/var/data/mymochis.db
ENV NEXOMOCHIS_UPLOAD_DIR=/var/data/uploads

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3737)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
