FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY docker/snapshot-usage.sh /usr/local/bin/snapshot-usage
RUN chmod 755 /usr/local/bin/snapshot-usage && mkdir -p /usage && chown 65532:65532 /usage
# Match the backend ledger owner, including any SQLite WAL/SHM metadata it creates.
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/snapshot-usage"]
