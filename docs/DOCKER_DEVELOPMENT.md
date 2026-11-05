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

Go 脚本先准备依赖和编译，再执行外层硬期限测试、gofmt 检查、vet、`/tmp/vowmirror` 构建。全量测试终止上限 60 秒，源码挂载只读；依赖和编译缓存分别在 `vowmirror-foundation-go-mod`、`vowmirror-foundation-go-build` 命名卷，工具退出后不丢缓存。

定向测试也必须保留外层期限：

```sh
docker compose run --rm -T tools-go timeout -s TERM -k 2s 58s go test -count=1 -timeout=55s ./internal/imagevalidate ./internal/cmd
docker compose run --rm -T tools-node node --test tests/image-core.test.mjs
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
| `TRYON_API_KEYS` | 必需；逗号分隔，每个 32–512 字符，只运行时注入 backend |
| `MODEL_PROVIDER/NAME/BASE_URL/API_KEY` | 后续服务端模型预留，目前无消费者；保持空 |
| 配置模板 | 只复制 `backend/manifest/config/config.example.yaml`，显式读取；不加载本地真实配置 |

构建上下文使用允许清单，排除 `.git`、`.local`、文档、环境文件、真实配置、密钥、日志和产物。静态镜像只含入口和运行模块，不含源仓库、草稿、测试或旧图库。后端运行镜像只含二进制、系统证书和配置模板；Go 仅存在构建／工具镜像。

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
