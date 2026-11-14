FROM node:22-bookworm-slim
RUN npm install --prefix /opt/image-tools --no-audit --no-fund --save-exact sharp@0.34.5
WORKDIR /workspace
