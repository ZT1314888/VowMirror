# VowMirror

婚礼双人 AI 换装项目，当前提供中文开发入口、健康检查、固定套装目录和 Phase 3 双人生成 API。上传、生成和下载页面属于后续 Phase 4，当前页面仍只检查后端连接。

GoFrame 后端已实现 Gemini 3.1 Flash Image 的四／五图协议映射；OpenAI 兼容与豆包配置明确返回能力错误，旧双图传输实现已移除。模拟测试只证明请求契约和安全路径，未验证真实模型效果、速度或费用。

## 启动

只需要 Docker Desktop 的 Linux 引擎和 Compose，不需要安装 Go、GoFrame CLI 或 Node。

1. 复制根 `.env.example` 为 `.env`，设置一个 32–512 字符的 `TRYON_API_KEYS`。无真实模型调用指令时，模型字段保持空；生成接口会明确返回配置错误。
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

`POST /api/tryon/couple` 需要 Token，仅接受合照、套装编号、婚纱画面左右和原背景／上传场地模式。服务端从唯一清单读取服装，运行时只读挂载 30 个套装目录，私有人像和场地接收目录不会挂入应用。缺图明确失败；没有模型设置界面、素材后台或历史存储。真实模型调用必须单独授权，本项目面向内部单实例开发与验证。

[LICENSE](LICENSE) 的原有 MIT 声明保持不变；继承代码和移除素材的边界见 [代码来源](docs/CODE_PROVENANCE.md)。旧图片许可不能作为新婚礼素材授权依据。
