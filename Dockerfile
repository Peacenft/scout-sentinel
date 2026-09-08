FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY migrations ./migrations
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --create-home app
COPY --from=build --chown=app:app /app/package.json /app/package.json
COPY --from=production-dependencies --chown=app:app /app/node_modules /app/node_modules
COPY --from=build --chown=app:app /app/dist /app/dist
COPY --from=build --chown=app:app /app/migrations /app/migrations
USER app
EXPOSE 4100
CMD ["node", "dist/src/server.js"]
