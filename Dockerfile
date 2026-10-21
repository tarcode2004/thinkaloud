# ThinkAloud production image. Builds of uploaded apps run in sibling Docker
# containers (mount /var/run/docker.sock) or locally with BUILD_MODE=local.
FROM node:22-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git docker.io && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY probe/package.json probe/
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production DATA_DIR=/data PORT=4000 APP_HOST_PORT=4001
VOLUME /data
EXPOSE 4000 4001
CMD ["npm", "start"]
