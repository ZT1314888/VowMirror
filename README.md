# VowMirror

婚礼双人 AI 换装项目，当前提供双人合照上传预览、固定套装选择、婚纱画面左右选择、可选场地上传、生成结果预览与下载。生成请求连接 Phase 3 双人 API；真实模型调用仍需单独授权。

GoFrame 后端使用 GPT Image `POST /v1/images/edits` 多文件编辑协议，服务端固定 `chuanapi`／`gpt-image-2.5-flare`，按顺序发送完整四／五图；每次一张 `1536×1024` PNG、`quality=medium`。Gemini 实现已移除。无付费测试只证明请求契约、安全和页面生命周期，不证明供应商支持、真实质量、速度或费用。

## 启动

只需要 Docker Desktop 的 Linux 引擎和 Compose，不需要安装 Go、GoFrame CLI 或 Node。

1. 复制根 `.env.example` 为 `.env`，设置一个 32–512 字符的 `TRYON_API_KEYS`。无真实模型调用指令时，模型字段保持空；生成接口会明确返回配置错误。
2. 在仓库根执行：

```sh
docker compose up -d --build web backend
```

打开 [http://localhost:3000](http://localhost:3000)。前端仅绑定本机回环，后端 8000 不映射宿主机。页面使用后端访问 Token 读取套装并提交生成；可选择只在本机保存 Token，
照片和结果不会持久化。缺失或无效访问 Token 会使后端明确启动失败；真实模型字段未配置时，生成接口明确失败，不调用其他供应商。

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

开发命令与故障定位见 [Docker 开发说明](docs/DOCKER_DEVELOPMENT.md)；实现边界见 [当前架构](docs/Project_Architecture_Blueprint.md)；阶段、输入缺口和本轮证据见
[长期计划](docs/plan/2026-11-05-wedding-project-roadmap.md)。

`POST /api/tryon/couple` 需要 Token，仅接受合照、套装编号、婚纱画面左右及互斥场地模式。页面可保留原背景或上传场地图；合照与场地图均校验真实格式、完整解码、8 MiB、256–8192 边长和 2000
万像素，替换／清除／切换会释放场地预览，刷新不恢复。固定场馆按唯一清单编号读取；当前 `venues: []`、目录为空，页面不显示该选项。本批九张私有场地图不作为内置场馆。

服务端从唯一清单读取素材，运行时只读挂载 30 个套装目录与固定场馆目录；私有人像和场地接收目录不会挂入应用。缺图明确失败；没有模型设置界面、素材后台或历史存储。本轮仅做单实例开发与验证，真实模型调用仍需单独授权。后续顺序为 Phase 7 实测 → Phase 8 正式界面 → 独立服务器公开上线交付；公开网页仍需有效访问 Token 才能生成，不增加账号、支付或历史图库。

Phase 7 验收通过：唯一校验器 `scripts/phase7-evaluation.mjs` 返回 5 组可判定／4 组合格、`phase8Ready=true`，真实取消专项通过。G1 第二次及 G3、G4、G5 六项评分全部通过；G2 最快诊断图六项评分全部通过，仅使该组可判定，诊断批次与正式三次尝试分开，不计入正式合格组数。模板、逐次授权、评分及完整证据见 [Phase 7 执行说明](docs/plan/2026-11-18-phase7-gpt-image.md)。Phase 8 与公开部署尚未开始。

生成接口已统一为 POST SSE：真实阶段状态、10 秒心跳和唯一结果／错误终态；浏览器从准备到解码可查看限时 90 秒，后端处理／模型请求 85 秒，服务端写入及 Nginx 代理读取 95 秒。心跳不延长预算，取消会清理读流、结果 URL 与并发资源；供应商图片 SSE 能力仍未验证，本轮不发送预览流参数。

[LICENSE](LICENSE) 的原有 MIT 声明保持不变；继承代码和移除素材的边界见 [代码来源](docs/CODE_PROVENANCE.md)。旧图片许可不能作为新婚礼素材授权依据。
