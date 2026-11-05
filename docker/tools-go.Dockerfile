FROM golang:1.25-bookworm
WORKDIR /opt/dependencies
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY docker/check-go.sh /tools/check-go.sh
# The read-only checkout can be owned by a different host UID.
RUN chmod +x /tools/check-go.sh \
    && git config --system --add safe.directory /workspace
WORKDIR /workspace/backend
