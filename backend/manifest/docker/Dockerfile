FROM golang:1.25-bookworm AS builder
WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/main.go ./
COPY backend/internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -o /out/vowmirror .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /out/vowmirror /app/vowmirror
COPY backend/manifest/config/config.example.yaml manifest/config/config.example.yaml
USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["/app/vowmirror"]
