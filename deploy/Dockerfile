# Realtime game server image. Run from repo root:
#   docker build -f deploy/Dockerfile -t agiwar-server .
FROM node:22-slim
WORKDIR /app

# install only server deps
COPY package.json ./
COPY server/package.json ./server/
RUN npm install --omit=dev --workspace @agiwar/server || npm install --omit=dev --prefix server

# source (server + shared types it imports)
COPY shared ./shared
COPY server ./server

ENV NODE_ENV=production
ENV PORT=8787
ENV AWS_REGION=us-west-2
ENV BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6
EXPOSE 8787
CMD ["npx", "tsx", "server/src/index.ts"]
