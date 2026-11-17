# Docker 开发说明

Docker Desktop 使用 Linux 引擎；根 `compose.yaml` 是唯一入口。Go、GoFrame CLI、Node 均不安装到宿主机。入口为 `http://localhost:3000`，只绑定本机回环。

## 首次启动

复制根 `.env.example` 为 `.env`，填入随机后端访问 Token（32–512 字符）。模型字段保持空。本地文件已被 Git 和 Docker 忽略；不存在第二份 backend 环境模板或真实 config.yaml 加载路径。

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

浏览器打开入口，看到“服务连接正常”。`GET /api/health` 仅返回存活信息，不需 Token、不调用模型。缺失／非法 Token 使后端启动报错；模型字段为空时健康／目录仍可运行，生成返回 `503 MODEL_CONFIGURATION_INVALID`。

不要公开输出 `docker compose config` 的完整结果，它会展开运行时环境变量。只用 `--quiet` 核查配置。

## 检查与构建

```sh
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser
```

`tools-node` 通过 `sh` 执行只读挂载的当前工作树脚本，无需因脚本变更重建镜像，也不依赖检出文件的执行位；CI 与本地运行同一脚本。Go 脚本先准备依赖和编译，再执行外层硬期限测试、gofmt 检查、vet、`/tmp/vowmirror` 构建。全量测试终止上限 60 秒，源码挂载只读；依赖和编译缓存分别在 `vowmirror-foundation-go-mod`、`vowmirror-foundation-go-build` 命名卷，工具退出后不丢缓存。

`tools-go` 镜像只将只读源码挂载根 `/workspace` 声明为 Git 可信目录，保留 Go 的 VCS 信息采集。这样 Linux 宿主机与容器的 UID 不同时仍可读取仓库状态；其他目录继续使用 Git 默认的所有权校验。修改源码挂载位置时，应同步调整这个唯一可信路径。

定向测试也必须保留外层期限：

```sh
docker compose run --rm -T tools-go timeout -s TERM -k 2s 58s go test -count=1 -timeout=55s ./internal/imagevalidate ./internal/cmd
docker compose run --rm -T tools-node node --test tests/image-core.test.mjs tests/wedding-assets.test.mjs
docker compose run --rm -T tools-go go vet ./...
docker compose run --rm -T tools-go go build -o /tmp/vowmirror .
```

工具默认只读源码；需要格式化时显式挂载当前仓库为可写，再在容器执行 gofmt，不改变默认检查挂载规则。编辑源码后重建受影响应用镜像并重跑检查。CI 使用与本地相同脚本，运行时只注入临时访问 Token，不注入模型 Key。

## 服务与配置

| 项 | 边界 |
|---|---|
| web | Nginx 8080，仅宿主机 `127.0.0.1:3000` 映射；白名单静态路径 |
| backend | GoFrame 固定 8000，非 root 运行，只在容器网络访问 |
| tools-go / tools-node | tools profile，无自动应用启动；源码只读 |
| tools-browser | 固定版本 Playwright／Chromium，真实访问 web 和 backend；不调用模型 |
| `TRYON_API_KEYS` | 必需；逗号分隔，每个 32–512 字符，运行时注入 backend 和 tools profile 的浏览器烟测容器；不进入页面、镜像或日志 |
| `MODEL_PROVIDER/NAME/BASE_URL/API_KEY` | 服务端生成配置；已闭合 `gemini`／`gemini-3.1-flash-image` 四／五图映射；Base URL 必须为 HTTPS API 根地址，例如 `https://generativelanguage.googleapis.com/v1beta`。真实模型调用须单独指令，验证时保持空 |
| 配置模板 | 只复制 `backend/manifest/config/config.example.yaml`，显式读取；不加载本地真实配置 |

构建上下文使用允许清单，排除 `.git`、`.local`、文档、环境文件、真实配置、密钥、日志和产物。静态镜像只含入口和运行模块，不含源仓库、草稿、测试或旧图库。后端运行镜像包含二进制、系统证书、配置模板和唯一素材清单，不包含服装、姿势或私有图片；Go 仅存在构建／工具镜像。

根 Compose 将 `W001`–`W030` 套装目录与 `venues/` 固定场馆目录只读挂载到后端；`private/` 与 `poses/` 不挂入应用。全新检出时 Compose 可建立空目录，健康和目录正常，生成读取缺失套装图片会明确返回 `OUTFIT_UNAVAILABLE`。Phase 5 唯一清单含 `venues: []`，没有场馆照片时页面不显示选项；未来只通过清单的 V001–V999 编号读取 `venues/Vxxx/` 路径，未知编号 `UNKNOWN_VENUE`、缺图／损坏 `VENUE_UNAVAILABLE`。场馆实图被 Git 和 Docker 构建上下文忽略，九张私有场地图不会自动加入；不创建假图片，不要求私有素材进入 CI。清单之外的文件不能由客户端指定读取。Nginx 关闭请求和响应代理缓冲及响应临时文件，人物上传与结果不落盘。

生成请求上限 24 MiB。Nginx `/api/` 在传输边界拦截超限请求，返回 JSON `41301 / REQUEST_TOO_LARGE`；响应头与正文带同一服务器请求 ID，保留安全响应头并禁止缓存，未鉴权超限请求也返回 413。后端保留相同上限以约束分块读取和直接访问，但关闭 GoFrame 默认的 8 MiB 隐式限制。代理层必须就地拒绝：仅关闭代理预检会使后端在上传尚未结束时提前断开，实测被 Nginx 转换为 502；两层错误契约由真实入口回归约束，代理不执行图片或模型校验。单图 8 MiB、256–8192 边长、2000 万像素；四／五图原始字节合计上限 14 MiB，序列化后完整模型请求不得超过 20,000,000 字节。后者按 Gemini 官方内联请求 20 MB 限制执行，含 Base64、文本和 JSON，原图总量是更保守的本地约束。输出仅接受一张完整解码的横版 PNG／JPEG／WebP；上游 JSON 上限 12 MiB，结果图片仍受单图限制。无自动重试或切模型；只接收内联结果，URL 结果明确失败，不发额外下载请求。

处理上下文限时 55 秒，覆盖请求体解析后的剩余处理时间并传播到模型请求；服务端上传读取最多 55 秒、写响应最多 60 秒。浏览器提交到可查看的 60 秒完整交互由 Phase 4 实现，真实供应商时延留在后续单独授权实测。所有准入后退出均释放并发；未接入额度扣减或费用拦截。

Node 与 Go 使用同一组素材清单契约用例；数组允许重排，但必须完整覆盖 30 套服装与 30 个 `unverified` 姿势，`venues` 为必填数组且当前为空。Phase 5 浏览器烟测覆盖场地上传真实三格式解码、尺寸／非空校验、预览替换清除、场地切换、迟到解码隔离、生成编辑锁定与刷新不恢复。Node 标准检查校验 fixture 和真实清单的结构，不要求私有图片进入 CI。已有本地素材时，另运行文件检查：

```sh
docker compose run --rm -T tools-node node scripts/verify-wedding-assets.mjs assets/wedding/manifest.json --check-files
```

目录 `GET /api/catalog/outfits` 无 Token／错误 Token 返回 401，有效 Token 返回 200 且仅返回清单元数据。浏览器烟测缺少 Token 时显式失败，并检查素材文件不对外暴露。每次修改后端或打包清单，先重建 web/backend 镜像、重新创建容器，再运行烟测，避免旧镜像造成假通过。

本地另有两张合照与九张场地图时，通过同一 Node 工具执行完整解码、真实格式／尺寸、字节数和 SHA-256 检查：

```sh
docker compose build tools-node
docker compose run --rm -T tools-node node scripts/verify-private-intake.mjs assets/wedding/private/intake.json
```

解码器固定为工具镜像内的 `sharp@0.34.5`，不加入应用镜像。私有目录的 `intake.json` 为唯一接收清单，包含匿名编号、角色、相对路径和校验值；文件缺失或不一致显式失败，不纳入缺少私有照片的 CI 默认检查。私有照片与清单被 Git 和 Docker 构建上下文排除，工具仅通过只读源码挂载读取，不对外提供访问。

## 故障定位与停止

```sh
docker version
docker compose ps
docker compose logs backend
docker compose logs web
docker compose down
```

无法连接 Linux daemon 时先启动 Docker Desktop；Token 配置错误按启动错误修正 `.env` 并重新创建 backend。页面连接失败会显示原因，可重新检查；不自动模拟成功。
停止不会删除源码或命名缓存卷。`tools-browser` 只有真实页面和健康调用通过才算烟测，应用启动不代表验收。

本轮验证与阶段门槛见 [长期计划](plan/2026-11-05-wedding-project-roadmap.md)。
