# VowMirror

婚礼双人 AI 换装项目，当前已完成旧产品清理与 Docker 开发基础。现在提供中文开发入口和健康检查；新人照片上传、固定套装、双人生成与下载尚未实现。

保留 GoFrame 后端、三类云端图像协议和有效图片／安全测试。保留协议代码不代表已经验证任何模型的婚礼多图能力、效果、速度或费用。

## 启动

只需要 Docker Desktop 的 Linux 引擎和 Compose，不需要安装 Go、GoFrame CLI 或 Node。

1. 复制根 `.env.example` 为 `.env`，设置一个 32–512 字符的 `TRYON_API_KEYS`。模型配置字段保持空。
2. 在仓库根执行：

```sh
docker compose up -d --build web backend
```

打开 [http://localhost:3000](http://localhost:3000)。前端仅绑定本机回环，后端 8000 不映射宿主机。缺失或无效访问 Token 会使后端明确启动失败；健康检查本身不需要 Token，不调用模型。

## 验证

```sh
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser node tests/smoke.mjs --stage foundation
```

Go 检查含全量测试、格式检查、vet 和构建；整条测试的外层硬期限不超过 60 秒。缓存位于 Docker 命名卷，构建产物位于容器临时目录。工具服务不会随应用启动。

开发命令与故障定位见 [Docker 开发说明](docs/DOCKER_DEVELOPMENT.md)；实现边界见 [当前架构](docs/Project_Architecture_Blueprint.md)；阶段、输入缺口和本轮证据见 [长期计划](docs/plan/2026-11-05-wedding-project-roadmap.md)。

当前没有生成 API、模型设置界面、素材后台或历史存储。后续真实素材与模型实测按阶段门槛推进，付费调用必须单独授权。本项目目前面向内部单实例开发与验证。

[LICENSE](LICENSE) 的原有 MIT 声明保持不变；继承代码和移除素材的边界见 [代码来源](docs/CODE_PROVENANCE.md)。旧图片许可不能作为新婚礼素材授权依据。
