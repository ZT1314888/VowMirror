# CLAUDE.md

本项目的范围、安全、验证和 Git 规范统一维护在 [AGENTS.md](AGENTS.md)。

@AGENTS.md

只使用根 Compose 开发与检查，不使用宿主机 Go／GoFrame CLI：
```sh
docker compose up -d --build web backend
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser node tests/smoke.mjs --stage foundation
```

首次启动先按 [Docker 开发说明](docs/DOCKER_DEVELOPMENT.md) 配置根 `.env` 的后端访问 Token；模型字段保持空。
源码现状见 [当前架构](docs/Project_Architecture_Blueprint.md)，阶段门槛和验证记录见 [长期计划](docs/plan/2026-11-05-wedding-project-roadmap.md)。旧单人业务和旧图库已经移除。
