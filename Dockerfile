# syntax=docker/dockerfile:1.7

# --- deps: prod deps only
FROM node:26-slim AS deps
WORKDIR /app
COPY package*.json ./
# If you need private npm, we'll mount a secret in the next RUN:
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev

# --- build: compile TS
FROM node:26-slim AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
COPY tsconfig.json ./
# If you keep a separate tsconfig for build, we’ll add it below.
# For now your script uses tsconfig.build.json — we’ll add that file too.
COPY tsconfig.build.json ./
COPY src ./src
RUN npm run build  # -> dist/

# --- runtime: small & clean
FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist        ./dist
EXPOSE 3000
CMD ["node","dist/index.js"]
