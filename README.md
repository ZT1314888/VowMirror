# VowMirror

婚礼双人 AI 换装项目，提供请柬入口、公开造型目录、双人合照本机预览、可选场地上传和生成结果下载。目录浏览不需要生成码；每次提交前输入线下领取的生成码，预检通过才发送照片。每码累计可成功生成五张，SQLite 用量卷保留重启前额度；真实模型调用仍需单独授权。

GoFrame 后端使用 GPT Image `POST /v1/images/edits` 多文件编辑协议，服务端固定 `chuanapi`／`gpt-image-2.5-flare`，按顺序发送完整四／五图；每次一张 `1536×1024` PNG、`quality=medium`。Gemini 实现已移除。无付费测试只证明请求契约、安全和页面生命周期，不证明供应商支持、真实质量、速度或费用。

## 启动

只需要 Docker Desktop 的 Linux 引擎和 Compose，不需要安装 Go、GoFrame CLI 或 Node。

1. 复制根 `.env.example` 为 `.env`，用密码学随机源生成 256 位生成码（例如 64 位十六进制），通过 `TRYON_API_KEYS` 配置；多个码用逗号分隔。无真实模型调用指令时，模型字段保持空；生成接口会明确返回配置错误。
2. 在仓库根执行：

```sh
docker compose up -d --build web backend
```

打开 [http://localhost:3000](http://localhost:3000)。前端仅绑定本机回环，后端 8000 不映射宿主机。访客可直接浏览造型目录、上传并查看本机照片预览；点击生成先定位缺失或无效输入，全部有效才弹出生成码对话框。`POST /api/tryon/authorize` 只发送 Bearer 头；无效码可原地纠正，通过后才上传照片。生成、重新生成和手动重试均需重新输入码，使用后清空；关闭弹窗保留表单。没有访问设置、链接传码或记住码功能。照片发送至图像服务处理，应用仅在本次请求内使用，刷新不恢复照片或结果。缺失或无效访问 Token 会使后端明确启动失败；真实模型字段未配置时，生成接口明确失败，不调用其他供应商。

成功次数与每日尝试由同一个 SQLite 账本持久化，仅记录完整码哈希、累计成功数、UTC 日期及当日尝试数。每码并发固定为 1；结果完整校验并写账成功后才返回成功事件，确认前失败／取消／超时不扣成功次数。每日模型尝试默认每码 10 次，通过 `TRYON_DAILY_ATTEMPT_LIMIT` 调整，在组装完成、提交上游前记账；已确认的成功即使浏览器断线仍计数。部署或回滚必须保留 `<Compose项目名>_usage` 命名卷，禁止对日常应用执行 `down --volumes`。

示例主图与花卉图按 [公开素材清单](docs/PUBLIC_ASSETS.md) 同源托管，标明示例；尚无逐套授权缩略图的造型保留真实名称卡片。

## 验证

```sh
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser
```

Go 检查含全量测试、格式检查、vet 和构建；整条测试的外层硬期限不超过 60 秒。缓存位于 Docker 命名卷，构建产物位于容器临时目录。工具服务不会随应用启动。

普通 `tools-browser` 仅对真实页面、健康和目录执行读取，生成交互均在浏览器中受控拦截；未受控的生成请求会被阻断并使烟测失败。它不执行真实生成接口 HTTP 探针。

Phase 7 完整无付费验收：`pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase7 -ColdBuild`（Windows PowerShell 可用
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-phase6.ps1 -Stage phase7 -ColdBuild`）。使用独立 Compose 项目、全新缓存；
核实四项模型配置为空、两个运行网络均为 internal 后，执行浏览器边界回归、真实 HTTP 错误验收和完整浏览器烟测。CI 使用相同入口，证据留在忽略的 `.local/phase7/`；详细边界见 Docker 开发说明。

Phase 8 正式界面无付费验收使用同一入口，将 `phase7` 替换为 `phase8`：`pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase8 -ColdBuild`。浏览器检查请柬、真实目录、必填定位、生成码预检、错误码零照片上传、弹窗焦点和取消、生成状态及四种视口并留存截图；生成使用受控响应，本地 TLS 上游集成测试验证真实计账，不调用模型。证据留在忽略的 `.local/phase8/`。

开发命令与故障定位见 [Docker 开发说明](docs/DOCKER_DEVELOPMENT.md)；实现边界见 [当前架构](docs/Project_Architecture_Blueprint.md)；阶段、输入缺口和本轮证据见
[长期计划](docs/plan/2026-11-05-wedding-project-roadmap.md)。

`POST /api/tryon/couple` 需要 Token，仅接受合照、套装编号及互斥场地模式，婚纱穿着者由模型依据合照判断。页面可保留原背景或上传场地图；合照与场地图均校验真实格式、完整解码、8 MiB、256–8192 边长和 2000
万像素，替换／清除／切换会释放场地预览，刷新不恢复。固定场馆按唯一清单编号读取；当前 `venues: []`、目录为空，页面不显示该选项。本批九张私有场地图不作为内置场馆。

服务端从唯一清单读取素材，运行时只读挂载 30 个套装目录与固定场馆目录；私有人像和场地接收目录不会挂入应用。缺图明确失败；没有模型设置界面、素材后台或历史存储。本轮仅做单实例开发与验证，真实模型调用仍需单独授权。后续顺序为 Phase 7 实测 → Phase 8 正式界面 → 独立服务器公开上线交付；公开网页仍需有效且有剩余额度的生成码才能生成，不增加账号、支付或历史图库。

Phase 7 验收通过：唯一校验器 `scripts/phase7-evaluation.mjs` 返回 5 组可判定／4 组合格、`phase8Ready=true`，真实取消专项通过。G1 第二次及 G3、G4、G5 六项评分全部通过；G2 最快诊断图六项评分全部通过，仅使该组可判定，诊断批次与正式三次尝试分开，不计入正式合格组数。模板、逐次授权、评分及完整证据见 [Phase 7 执行说明](docs/plan/2026-11-18-phase7-gpt-image.md)。Phase 8 无付费验收记录见 [Phase 8 界面与验收](docs/plan/2026-11-19-phase8-ui.md)；公网部署仍是独立阶段。

生成接口已统一为 POST SSE：真实阶段状态、10 秒心跳和唯一结果／错误终态；浏览器从准备到解码可查看限时 90 秒，后端处理／模型请求 85 秒，服务端写入及 Nginx 代理读取 95 秒。心跳不延长预算，取消会清理读流、结果 URL 与并发资源；供应商图片 SSE 能力仍未验证，本轮不发送预览流参数。

[LICENSE](LICENSE) 的原有 MIT 声明保持不变；继承代码和移除素材的边界见 [代码来源](docs/CODE_PROVENANCE.md)。旧图片许可不能作为新婚礼素材授权依据。
