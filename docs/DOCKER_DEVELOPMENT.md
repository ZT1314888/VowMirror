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

浏览器打开入口，看到“后端连接正常”。`GET /api/health` 仅返回存活信息，不需 Token、不调用模型。缺失／非法 Token 使后端启动报错；无模型 Key 时基础仍可运行。当前没有任何生成路由。

不要公开输出 `docker compose config` 的完整结果，它会展开运行时环境变量。只用 `--quiet` 核查配置。

## 检查与构建

```sh
docker compose build tools-go tools-node tools-browser
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose run --rm -T tools-browser node tests/smoke.mjs --stage foundation
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
| `MODEL_PROVIDER/NAME/BASE_URL/API_KEY` | 后续服务端模型预留，目前无消费者；保持空 |
| 配置模板 | 只复制 `backend/manifest/config/config.example.yaml`，显式读取；不加载本地真实配置 |

构建上下文使用允许清单，排除 `.git`、`.local`、文档、环境文件、真实配置、密钥、日志和产物。静态镜像只含入口和运行模块，不含源仓库、草稿、测试或旧图库。后端运行镜像包含二进制、系统证书、配置模板和唯一素材清单，不包含服装、姿势或私有图片；Go 仅存在构建／工具镜像。

Node 与 Go 使用同一组素材清单契约用例；两个数组允许重排，但必须完整覆盖 30 套服装与 30 个 `unverified` 姿势。Node 标准检查校验 fixture 和真实清单的结构，不要求私有图片进入 CI。已有本地素材时，另运行文件检查：

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
