FROM golang:1.25-bookworm
WORKDIR /opt/dependencies
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY docker/check-go.sh /tools/check-go.sh
RUN chmod +x /tools/check-go.sh
WORKDIR /workspace/backend
