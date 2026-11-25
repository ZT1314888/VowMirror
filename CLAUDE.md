# CLAUDE.md

本项目的范围、安全、验证和 Git 规范统一维护在 [AGENTS.md](AGENTS.md)。

@AGENTS.md

只使用根 Compose 开发与检查，不使用宿主机 Go／GoFrame CLI：

```sh
docker compose up -d --build web backend
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser node tests/smoke.mjs --stage phase7
```

首次启动按 [README.md](README.md) 配置根 `.env` 中的生成码；模型字段保持空。
`docs/` 仅保存本地开发记录，不纳入版本控制或项目检查。
