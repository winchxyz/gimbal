# The engine (serve) as one long-running container, for Railway or any Docker host (docs/deploy-railway.md).
# Secrets come from the host's variables, never from the image: .env and .keys/ are not copied in.
FROM node:24.16.0-slim

WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w shared

# Trader state, engine rules, strategy counters and the per-desk locks live here: mount a volume on /data.
ENV XDG_STATE_HOME=/data \
    GIMBAL_STATE_DIR=/data/gimbal

CMD ["node", "engine/src/cli/serve.ts"]
