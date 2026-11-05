FROM node:22-bookworm-slim
COPY docker/check-node.sh /tools/check-node.sh
RUN chmod +x /tools/check-node.sh
WORKDIR /workspace
