FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends age sqlite3 openssl shellcheck \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/image-tools --no-audit --no-fund --save-exact sharp@0.34.5
WORKDIR /workspace
