# Docker 开发说明

Docker Desktop 使用 Linux 引擎；根 `compose.yaml` 是唯一入口。Go、GoFrame CLI、Node 均不安装到宿主机。入口为 `http://localhost:3000`，只绑定本机回环。

## 首次启动

复制根 `.env.example` 为 `.env`，用密码学随机源生成 256 位生成码并配置 `TRYON_API_KEYS`；管理员在线下发放，多个码用逗号分隔。模型字段保持空。本地文件已被 Git 和
Docker 忽略；不存在第二份 backend 环境模板或真实 config.yaml
加载路径。

PowerShell 可用以下命令建立开发 Token，仅在 `.env` 不存在时执行，不输出 Token：

```powershell
if (Test-Path -LiteralPath .env) { throw '.env 已存在，请保留现有配置' }
$tokenBytes = New-Object byte[] 32
$tokenGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$tokenGenerator.GetBytes($tokenBytes)
$tokenGenerator.Dispose()
$accessToken = [BitConverter]::ToString($tokenBytes).Replace('-', '').ToLowerInvariant()
$template = [System.IO.File]::ReadAllText((Join-Path (Get-Location).Path '.env.example'))
[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path '.env'), $template.Replace('TRYON_API_KEYS=', 'TRYON_API_KEYS=' + $accessToken), (New-Object System.Text.UTF8Encoding $false))
```

```sh
docker compose config --quiet
docker compose up -d --build --wait web backend
docker compose ps
```

浏览器打开入口，看到“服务连接正常”。`GET /api/health` 仅返回存活信息，不需 Token、不调用模型。缺失／非法 Token 使后端启动报错；模型字段为空时健康／目录仍可运行，生成返回
`503 MODEL_CONFIGURATION_INVALID`。

不要公开输出 `docker compose config` 的完整结果，它会展开运行时环境变量。只用 `--quiet` 核查配置。

## 检查与构建

Phase 6 的无付费完整验收在 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-phase6.ps1 -ColdBuild
```

脚本仍只使用根 Compose，`--env-file .env.example` 排除真实 `.env`，清空模型配置并生成仅本次有效的合成访问 Token；使用独立项目、3006 端口及全新 Go 缓存卷，不替换 3000
端口的开发应用。`-ColdBuild` 为五类镜像执行 `--no-cache`，重新下载 Go／Node 工具依赖；基础镜像层仍由 Docker 本地存储提供，不清除其他项目缓存。Go 测试编译准备在计时前进行，全量测试仍保留 58
秒加 2 秒终止宽限的外层硬期限。

验收时两个运行网络均为 `internal`，工具测试只访问回环 TLS 替身，应用模型配置必须为空；镜像构建阶段可联网下载依赖。脚本实际核查网络属性、运行环境、已跟踪源码图片清单、静态 Web 与后端 `/app` 镜像文件及元数据、
应用日志，并运行完整 Chromium 流程；单独核查 `/assets/wedding/private/` 不可见、受控线稿只读挂载，
不将宿主机素材挂载误记为镜像内容。任何命令失败立即报错。证据保存在
Git／Docker 均忽略的 `.local/phase6/`，最后清理本次容器和独立缓存卷。缺图／上游／无效结果／短父期限的 HTTP 测试与浏览器受控取消／60 秒时钟测试分别证明后端错误链路和前端状态，不证明真实供应商的效果或时延。

根 Compose 的 `VOWMIRROR_WEB_PORT`、`VOWMIRROR_GO_MOD_VOLUME`、`VOWMIRROR_GO_BUILD_VOLUME`、`VOWMIRROR_ACCEPTANCE_OFFLINE`
只供上述验收进程临时覆盖，日常默认仍是 3000、原命名缓存及可联网模型出口。它们不构成另一份环境模板；唯一模板仍为根 `.env.example`。

```sh
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser
```

`tools-node` 通过 `sh` 执行只读挂载的当前工作树脚本，无需因脚本变更重建镜像，也不依赖检出文件的执行位；CI 与本地运行同一脚本。Go 脚本先准备依赖和编译，再执行外层硬期限测试、gofmt 检查、vet、
`/tmp/vowmirror` 构建。全量测试终止上限 60 秒，默认源码挂载只读；只有依赖编辑和格式化任务临时设置 `VOWMIRROR_SOURCE_MODE=rw`，完成后恢复默认。依赖和编译缓存分别在
`vowmirror-foundation-go-mod`、`vowmirror-foundation-go-build` 命名卷，
工具退出后不丢缓存。

`tools-go` 镜像只将只读源码挂载根 `/workspace` 声明为 Git 可信目录，保留 Go 的 VCS 信息采集。这样 Linux 宿主机与容器的 UID 不同时仍可读取仓库状态；其他目录继续使用
Git 默认的所有权校验。修改源码挂载位置时，应同步调整这个唯一可信路径。

定向测试也必须保留外层期限：

```sh
docker compose run --rm -T tools-go timeout -s TERM -k 2s 58s go test -count=1 -timeout=55s ./internal/imagevalidate ./internal/cmd
docker compose run --rm -T tools-node node --test tests/image-core.test.mjs tests/wedding-assets.test.mjs
docker compose run --rm -T tools-go go vet ./...
docker compose run --rm -T tools-go go build -o /tmp/vowmirror .
```

工具默认只读源码；需要格式化时显式挂载当前仓库为可写，再在容器执行 gofmt，不改变默认检查挂载规则。编辑源码后重建受影响应用镜像并重跑检查。CI 使用与本地相同脚本，运行时只注入临时访问 Token，不注入模型 Key。

普通 `tools-browser` 不发送真实生成接口请求：首次导航前安装默认拦截，未受控请求中止并使检查失败；具体交互由各场景响应接管。控制台在导航前监听全部级别，从同一集合派生预期 error 检查，并扫描访问
Token、照片、场地图和结果夹具；泄露错误只报告类别。

Phase 6 完整验收运行 `pwsh -NoProfile -File scripts/verify-phase6.ps1 -ColdBuild`；Phase 7 和 Phase 8 分别传入
`-Stage phase7`、`-Stage phase8`。脚本确认后端四项模型字段为空、两个网络均为 internal 后，运行
`tests/browser-safety.test.mjs`、`tests/http-acceptance.mjs` 和默认烟测；HTTP 模块包含真实生成接口的超限、鉴权、空配置和输入错误探针，不应单独对日常服务运行。
边界回归通过本地计数代理执行完整烟测，代理拒绝转发生成；另向页面注入未受控请求，要求烟测失败且代理生成计数仍为零。真实 Chromium 逐级验证 log／info／warn／error／debug 的敏感检查与普通诊断日志。

## 服务与配置

| 项 | 边界 |
| --- | --- |
| web | Nginx 8080，仅宿主机 `127.0.0.1:3000` 映射；白名单静态路径 |
| backend | GoFrame 固定 8000，非 root 运行，只在容器网络访问 |
| tools-go / tools-node | tools profile，无自动应用启动；源码只读 |
| tools-browser | 固定版本 Playwright／Chromium，真实访问 web 和 backend；不调用模型 |
| `TRYON_API_KEYS` | 必需；逗号分隔，每个 32–512 字符，运行时注入 backend 和 tools profile 的浏览器烟测容器；不进入页面、镜像或日志 |
| `MODEL_PROVIDER/NAME/BASE_URL/API_KEY` | 服务端生成配置；实现 `chuanapi`／`gpt-image-2.5-flare` 四至六图编辑映射；Base URL 必须为以 `/v1` 结尾的 HTTPS API 根地址，例如 `https://model.example/v1`。真实模型调用须单独指令，验证时保持空 |
| 配置模板 | 只复制 `backend/manifest/config/config.example.yaml`，显式读取；不加载本地真实配置 |

构建上下文使用允许清单，排除 `.git`、`.local`、文档、环境文件、真实配置、密钥、日志和产物。静态镜像只含入口和运行模块，不含源仓库、草稿、测试或旧图库。后端运行镜像包含二进制、系统证书、配置模板和唯一素材清单，不包含服装、
姿势或私有图片；Go 仅存在构建／工具镜像。

根 Compose 将 `W001`–`W030` 套装、`venues/` 固定场馆与 `poses/` 线稿目录只读挂载到后端；`private/` 不挂入应用。
全新检出时 Compose 可建立空目录，健康和目录正常；缺失套装返回 `OUTFIT_UNAVAILABLE`，选中混合路线却缺线稿返回 `POSE_UNAVAILABLE`。
唯一清单含 `venues: []`，没有场馆照片时页面不显示选项；未来只通过清单的 V001–V999 编号读取 `venues/Vxxx/`
路径，未知编号 `UNKNOWN_VENUE`、缺图／损坏 `VENUE_UNAVAILABLE`。场馆实图被 Git 和 Docker 构建上下文忽略，九张私有场地图不会自动加入；不创建假图片，不要求私有素材进入 CI。
清单之外的文件不能由客户端指定读取。Nginx 关闭请求和响应代理缓冲及响应临时文件，人物上传与结果不落盘。

生成请求上限 24 MiB。Nginx `/api/` 在传输边界拦截超限请求，返回 JSON `41301 / REQUEST_TOO_LARGE`；响应头与正文带同一服务器请求 ID，保留安全响应头并禁止缓存，未鉴权超限请求也返回
413。后端保留相同上限以约束分块读取和直接访问，但关闭 GoFrame 默认的 8 MiB 隐式限制。代理层必须就地拒绝：仅关闭代理预检会使后端在上传尚未结束时提前断开，实测被 Nginx 转换为 502；两层错误契约由真实入口回归约束，
代理不执行图片或模型校验。单图 8 MiB、256–8192 边长、2000 万像素；四至六图原始字节合计上限 14 MiB，序列化后完整模型请求不得超过 20,000,000 字节。这两个总量是本地内存边界，不是
GPT Image 官方上限。请求使用 multipart、各文件真实 MIME 和 Bearer Key；输出仅接受一张完整解码的 `1536×1024` PNG；上游 JSON 上限 12 MiB，结果图片仍受单图限
制。无自动重试或切模型；只接收内联结果，URL
结果明确失败，不发额外下载请求。

请求上下文和模型 HTTP 请求最多 85 秒，覆盖输入读取、图片校验、素材准备和上游调用；服务端写入与 Nginx 代理读取期限为 95 秒。浏览器从提交准备计时，图片成功解码并进入可见渲染帧后才完成，90 秒硬期限覆
盖全部过程；阶段状态以真实观测更新，心跳不代表进度也不延长期限。取消／超时释放结果 URL 和并发资源，迟到结果不能恢复。真实供应商时延留在后续单独授权实测。所有准入后退出均释放并发。每码最多五次成功；唯一 SQLite
账本记录完整码哈希与成功／每日尝试计数，写账失败明确失败。模型提交前记录每日尝试，默认每码每天 10 次、按 UTC 换日；`TRYON_DAILY_ATTEMPT_LIMIT` 可按预算调整。确认成功前取消或超时不扣成
功数，确认并写账后断线仍计数。

Node 与 Go 使用同一组版本 2 素材清单契约用例；数组允许重排，但必须完整覆盖 30 套服装与 28 个 `unverified` 姿势，`venues` 为必填数组且当前为空。
姿势的发送方式、动作描述以清单为唯一来源；当前从全部 28 个条目随机抽取，详见[姿势方案](plan/2026-11-22-random-pose-catalog.md)。
浏览器烟测覆盖场地上传真实三格式解码、
尺寸／非空校验、预览替换清除、场地切换、迟到解码隔离、生成编辑锁定与刷新不恢复。Node 标准检查校验 fixture 和真实清单的结构，不要求私有图片进入 CI。已有本地素材时，另运行文件检查：

```sh
docker compose run --rm -T tools-node node scripts/verify-wedding-assets.mjs assets/wedding/manifest.json --check-files
```

目录 `GET /api/catalog/outfits` 公开返回版本、套装编号／名称和场馆编号／名称，不含素材路径、姿势清单或服装映射；无 Token、错误 Token 均可读取。生成
`POST /api/tryon/couple` 仍以有效 Token 鉴权，浏览器烟测验证无／错误 Token 均为 401，并检查素材文件不对外暴露。
每次修改后端或打包清单，先重建 web/backend 镜像、重新创建容器，再运行烟测，避免旧镜像造成假通过。

本地另有两张合照与九张场地图时，通过同一 Node 工具执行完整解码、真实格式／尺寸、字节数和 SHA-256 检查：

```sh
docker compose build tools-node
docker compose run --rm -T tools-node node scripts/verify-private-intake.mjs assets/wedding/private/intake.json
```

解码器固定为工具镜像内的 `sharp@0.34.5`，不加入应用镜像。私有目录的 `intake.json` 为唯一接收清单，包含匿名编号、角色、相对路径和校验值；文件缺失或不一致显式失败，不纳入缺少私有照片的 CI 默认检查。
私有照片与清单被 Git 和 Docker 构建上下文排除，工具仅通过只读源码挂载读取，不对外提供访问。

## 故障定位与停止

```sh
docker version
docker compose ps
docker compose logs backend
docker compose logs web
docker compose down
```

无法连接 Linux daemon 时先启动 Docker Desktop；Token 配置错误按启动错误修正 `.env` 并重新创建 backend。页面连接失败会显示原因，可重新检查；不自动模拟成功。
停止和回滚必须保留后端 `usage` 命名卷，不能对日常项目执行 `docker compose down --volumes`；该卷是生成码余额的唯一来源。隔离验收拥有独立项目名，其清理只删除本轮专用卷。
`tools-browser` 只有真实页面和健康调用通过才算烟测，应用启动不代表验收。

本轮验证与阶段门槛见 [长期计划](plan/2026-11-05-wedding-project-roadmap.md)。

## Phase 7 无付费回归与实测边界

Phase 7 回归可运行 `pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase7 -ColdBuild`；不带 Stage 时仍运行历史 Phase
6 范围。当前 CI 使用 Phase 8 参数。空模型配置、独立 internal 网络和非人物夹具保持不变。Phase 7 浏览器新增解码失败、等待解码时取消／超时、迟到解码与一次完整 90 秒实际等待；完整入口清理
成功才记录摘要。

## Phase 8 正式界面无付费验收

运行 `pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase8 -ColdBuild`。此阶段验证请柬键盘入口、减少动态效果、公开目录字段范围、四步必填
定位、每次生成码预检、错误码零照片上传、弹窗键盘焦点／关闭／重复确认、取消预检后的迟到响应隔离、图片预览和生成状态；生成请求由浏览器受控响应接管，本地 TLS 上游测试验证真实 HTTP 与账本，不调用真实模型。375／
768／1024／1440 截图写入本轮 `screenshots/`。证据写入忽略的 `.local/phase8/`，具体结果见
[Phase 8 验收记录](plan/2026-11-19-phase8-ui.md)。

供应商回包若包含 `model`，仅允许请求别名或其合法日期快照；缺失时不捏造版本。`X-Request-ID`／回包 `request_id` 为可选供应商标识，冲突或非法标识明确失败；API 原有 `model`／
`request_id` 始终表示请求型号／应用请求标识。额外返回字段为可选 `provider_model`／`provider_request_id`。仅接受 `data[0].b64_json`，URL、不完整四／
五图协议、声明其他模型或固定输出不符均明确失败，不自动重试、切模型或切出口。

真实五组与取消专项须逐次取得指令；本轮隔离验证不读取真实 `.env`、不发模型请求。详见 [Phase 7 执行说明](plan/2026-11-18-phase7-gpt-image.md)。

构建默认使用官方 Go 代理；若网络返回明确下载错误，可以显式设置进程变量 `GOPROXY=https://goproxy.cn` 后运行完整验收，脚本会通过构建参数传入，不会静默改用其他来源。应用运行不读取此变量。截
图通过工具容器唯一可写的 `/evidence` 挂载写入；源码仍默认只读，公开样例必须通过精确文件清单、来源、SHA-256 与 JPEG 元数据检查。
