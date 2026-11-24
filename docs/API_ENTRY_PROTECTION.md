# API 入口限流

入口由 [Nginx 配置](../docker/nginx.conf) 按连接来源 IP 限流，后端继续按生成码限流。
错误生成码在后端鉴权时退出，因此由入口限流约束反复核验与生成请求；公开服装目录有独立限流区。

## 参数与作用范围

| 入口 | 每 IP 平均速率 | 空闲后连续放行数 | Nginx burst | Retry-After |
| --- | --- | --- | --- | --- |
| `/api/tryon/authorize` | 30 次／分钟 | 5 | 4 | 2 秒 |
| `/api/tryon/couple` | 20 次／分钟 | 4 | 3 | 3 秒 |
| `/api/catalog/outfits` | 120 次／分钟 | 20 | 19 | 1 秒 |

三个计数区相互独立，使用 `$binary_remote_addr`，各占 10 MiB 共享内存。`burst` 加上第一个请求即为连续放行数。
每条受限路由只挂载自己的一个 `limit_req`，共用 [代理片段](../docker/api-proxy.conf) 处理前缀、上传和响应边界。
片段显式去除 `/api/` 前缀；`Retry-After` 映射读取改写后的 `$uri`，查询参数仍不参与计数。
`nodelay` 使额度内请求立即通过，超限直接拒绝，不排队；持续请求只能按平均速率恢复额度。
带／不带末尾斜杠、不同查询参数共享计数。健康接口 `/api/health` 和静态资源不计入这些限流区。

只信任 Nginx 实际连接来源，不接受客户端声明的来源地址。转发时将 `X-Forwarded-For`、`X-Real-IP`
覆盖为连接来源，删除 `Forwarded`。当前未配置 CDN 或其他前置代理的真实 IP 信任；同一 NAT 出口共享额度。
使用根 Compose 从宿主机访问时，Nginx 看到的连接来源是 Docker 网桥网关，因此本机所有客户端共用一个桶；
公开上线若增加前置代理，必须先配置真实 IP 信任，否则所有访客也会合并计数。
这项入口限制不构成完整 DDoS 防护。

## 错误与后端边界

入口拒绝返回 HTTP 429、业务码 `42901`、`data.error_code: RATE_LIMITED`，并携带表中的 `Retry-After`、
`Cache-Control: no-store` 和安全响应头。`X-Request-ID` 与正文 `data.request_id` 使用相同的服务器生成值，
不采用客户端提交的请求 ID。前端沿用“请求过于频繁，请稍后再试”，不归类为生成码错误或人脸错误。

入口拒绝不会进入后端，不调用模型、不增加尝试或成功计数。已通过入口的请求仍依次经过鉴权、按生成码限流、
上传与业务校验。核验和生成共用每码默认 10 次／分钟、burst 3 的后端桶；目录无需生成码。
后端 429 保留自己的等待时间，Nginx 不截取或改写上游错误与 SSE。

[后端模板](../backend/manifest/config/config.example.yaml) 显式指定 `maxHeaderBytes: 10240`，
与 GoFrame 原有 10 KiB 默认值相同。Go 的请求头解析允许预读余量，因此 10 KiB 是配置上限，
不能描述成精确的线上字节切断点。测试沿真实启动配置路径断言字段明确存在且为 10240，
再验证 1 KiB 请求头返回 200、16 KiB 返回 431；即使框架默认值不变，删除字段也必须失败。

现有 24 MiB 上传上限和超时策略保持不变。[启动代码](../backend/internal/cmd/cmd.go) 显式设置读取与写入期限，
分别使用 [业务常量](../backend/internal/logic/tryon/generator.go) 的 85 秒 `RequestTimeout`
和 95 秒 `StreamWriteTimeout`；业务处理也受前者约束。代理读取期限由 Nginx 的 `proxy_read_timeout 95s`
指定。这些数值已核实，无需向 YAML 重复添加。

## 交付归属

本项按独立 feature 交付。新增入口限流直接触发了 HTTP 验收脚本单次重试不足的问题，
因此有界重试修复属于入口保护的连带修复；保留现有实现，本轮不做可选的重试抽象。
完整 `-Stage phase8` 验收入口用于兼容性回归，不表示另行修复或重新划分 Phase 8。

## 调整与定向验证

入口策略以 Nginx 配置为唯一来源。调整对应 `limit_req_zone` 的 `rate`、`limit_req` 的 `burst`，
并同步更新 `entry_retry_after` 映射、本文参数和定向测试中的预期值。后端按码配置独立保留在后端模板中。
修改后先运行定向验证，再重建运行实例的 web 镜像并重新创建容器。

```powershell
pwsh -NoProfile -File scripts/verify-api-entry.ps1
```

需要显式切换构建下载代理时，在执行脚本的进程中设置 `GOPROXY`，例如 `https://goproxy.cn`；
脚本通过构建参数传入，不隐式回退。

[验证脚本](../scripts/verify-api-entry.ps1) 只使用根 [Compose](../compose.yaml)，排除真实 `.env`，
注入四个合成生成码并清空模型配置。使用独立项目、随机回环端口、全新用量卷和 Go 缓存卷；
根 Compose 先创建具名 peer、runner 等待容器。启动 Node 业务测试前，
检查 app/default 均为 internal，并检查 web、backend、peer、runner 各自仅连接本项目 app，
附件的网络 ID 必须与实际 app 网络 ID 相同；任一不符即失败并清理资源。
容器启动健康检查仍会访问健康接口，此处顺序约束针对验收业务流量。
`networks.json` 只记录角色、网络名／ID、Internal 和结果，不保存完整容器元数据、地址或环境。

[入口测试](../tests/api-entry-protection.mjs) 使用两个同时存在且来源 IP 不同的容器，
验证三个入口的连续放行数、响应契约、恢复、接口与来源隔离、伪造头、斜杠和查询参数、健康与静态资源排除，
以及限流前后的生成码／人脸错误分类、后端按码限流和 SQLite 尝试／成功计数零写入。
测试对突发请求耗时设上限，跨越补额周期会明确失败，不把时序不确定当作通过。

Go 仅运行相关 limiter、响应契约、人脸准入和请求头边界测试，整条测试命令使用 58 秒外层期限和 2 秒终止宽限。
同时检查相关 gofmt／vet、应用镜像构建和 `nginx -t`；不运行全量测试或完整浏览器烟测，不调用真实模型。
证据写入 Git 与 Docker 忽略的 `.local/api-entry/`；脚本退出时清理本次容器、网络、专用镜像标签及用量／缓存卷。

## 历史验证记录（2026-11-23）

2026-11-23，从已交付提交 `2b2fc1f` 建立独立分支 `feat/api-entry-protection`，保留原工作区改动。
通过实例为 `entry-426b65eeca494e8f96380bc5d250dd35`，证据位于其同名 `.local/api-entry/` 子目录。

| 检查 | 结果 |
| --- | --- |
| 定向 Go 测试 | security、middleware、cmd、tryon 四包所选测试通过；包含 10 KiB 请求头边界 |
| 格式与静态检查 | 新增 Go 测试 gofmt、相关包 vet、Node 语法检查通过 |
| 构建与 Nginx | tools-go、tools-browser、web、backend 构建及 `nginx -t` 通过 |
| 真实 HTTP 入口 | 5／4／20 突发、429 契约、恢复、三个桶隔离及两个同时存活来源隔离通过 |
| 输入与分类 | 伪造来源头、斜杠／重复斜杠／转义字符／查询参数、大小写未匹配路径、健康与静态资源排除通过 |
| 后端与计费边界 | 后端按码共桶、不同码隔离、限流前后人脸错误分类通过；SQLite 尝试与成功记录均为空 |
| 清理 | 专用容器、网络、卷及镜像标签清理完成，资源检查通过 |

首次官方 Go 代理依赖下载返回 `unexpected EOF`，显式指定 `GOPROXY=https://goproxy.cn` 后构建通过。
验收过程中修正了验证脚本的网络数组表达式和空模型错误的前端分类预期，最终脚本整次执行退出码为 0。
本轮只证明入口与既有本地边界；未运行全量测试、完整浏览器烟测或真实模型评测，未提交、推送或公开部署。

### 全量验收入口补跑与修复

后续按 [长期计划](plan/2026-11-05-wedding-project-roadmap.md) 的验收入口补跑 `pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase8`。
首次失败于 `tests/http-acceptance.mjs:121`：入口与后端按码限流是两套独立预算，
一次被入口拒绝的请求仍可能随后被后端按码拒绝，而原 `post()` 只重试一次，因此第二次人脸校验请求返回 429。

当时隔离复现观察到入口 429 的 JSON 键序为 `code,message,data`，后端为 `code,data,message`；
这是当时的格式观察，键序不作为后续来源归因依据。归因依据是两套独立预算的限流行为，
以及真实序列中入口拒绝的重试又命中后端，Nginx 日志记录 `limiting requests, excess: 3.9xx by zone "couple_entry"`。
无重试对照脚本在该断言处失败，按需重试脚本通过，证明不是时序偶发。

修复只改验收脚本的重试边界：`tests/http-acceptance.mjs` 的 `post()` 与新增 `authorize()` 改为最多四次请求，
即首次请求加最多三次重试。每次 429 仍校验必须带 `Retry-After`、值为 1–60 秒整数和 `RATE_LIMITED`，并按其等待；
超出预算即明确失败，不吞错、不无限重试。Nginx 参数与后端限流均未改动。

补跑通过实例为 `phase8-915bbd7760ba4d08af7a15e2032ab946`，证据位于 `.local/phase8/` 同名子目录。

| 检查 | 结果 |
| --- | --- |
| 全量 Go 测试与 vet | `tools-go` 全量测试、gofmt、vet 与构建通过 |
| Node 检查 | 语法、单元测试、素材清单与项目结构／文档链接检查通过 |
| 镜像边界 | web／backend 源码与运行边界检查通过 |
| 真实 HTTP 验收 | 25 MiB 超限 413 契约、鉴权、空模型、人脸与输入分类、按码限流通过 |
| 完整浏览器烟测 | 375／768／1024／1440 无溢出，请柬、目录、生成锁定、取消、超时、手动重试通过，页面错误为 0 |
| 重启与持久化 | 后端重启后用量卷可写，重新授权通过 |
| 人脸闸门 | 单人拒绝与双人重试的真实 SSE 通过 |
| 离线与清理 | 两个网络均为 internal，模型配置为空，真实模型调用 0，资源清理通过 |

`summary.json` 记录 19 项检查、`result: passed`、`cleanup: passed`。失败运行不写摘要，已作为阻塞记录。
本轮仍未提交、推送、调用真实模型或公开部署。

上述历史网络证据仅覆盖两个网络的 Internal 属性，不追认本次新增的四角色实际附件与网络 ID 检查。

## 审查修复记录（2026-11-24）

原 `feat/api-entry-protection` 的七份草稿已按文件哈希备份并整合到独立 worktree，
开发分支为 `feat/api-entry-protection-review`，起始提交仍为 `2b2fc1f`；原工作区与草稿保持原状。
备份及整合清单位于 Git／Docker 忽略的 `.local/api-entry-backups/`，新验收证据单独记录，沿用独立 feature 归属。

本次备份清单位于共享仓库根目录的 `.local/api-entry-backups/review-20261124-153303/integration.json`。
四个行为文件（模板、Nginx、HTTP 验收重试和入口测试）沿用草稿，本轮只增强请求头测试、验证脚本与本文。

| 检查 | 本轮结果与证据 |
| --- | --- |
| 请求头正向 | 定向 Go 测试通过：显式字段为 10240，1 KiB 返回 200，16 KiB 返回 431 |
| 请求头负向 | 临时配置副本删除字段／改为 32768 均在明确字段断言处失败，退出码均为 1；资源清理通过 |
| 网络正向 | 四角色唯一 app 附件与 ID 一致，app/default 均为 internal；`networks.json` 结果为 passed |
| 网络负向 | 等待中的 runner 增加额外 internal 网络后被拒绝，Node 业务测试未启动，失败路径和额外网络清理通过 |
| 定向检查 | 相关 Go 测试、gofmt／vet、两份 Node 语法检查、应用构建和 `nginx -t` 通过 |
| 入口 HTTP | 5／4／20 突发、429 契约、恢复、独立桶／来源、错误分类与用量零写入通过 |
| 完整兼容性回归 | 原入口 `-Stage phase8` 的 19 项检查通过，含全量 Go／Node、真实 HTTP、浏览器、重启、人脸 SSE 和清理 |

入口通过实例为 `entry-e64b5d3cefa14dc7b2cdf3e23a39bfcd`，证据位于新 worktree 的
`.local/api-entry/` 同名目录。网络负向实例为 `entry-67146d282f704f9f8b9dad86358c89c7`，
对应验证包装器为 `.local/review-validation/extra-network-640a6c6181784684943730b6da9ec6f3/`。
请求头负向证据位于 `.local/review-validation/header-negative-a70bf24fc0a94f2c9eb9f810dc0df3ab/`，
临时副本与包装器均留在忽略目录，不增加正式代码的测试开关。

完整回归实例为 `phase8-3a27041525c54c0e8b19a91cacec0544`，证据位于 `.local/phase8/` 同名目录，
`summary.json` 记录 `checks: 19`、`result: passed`、`cleanup: passed` 和 `realModelCalls: 0`。
运行前确认宿主 3006 端口可用，沿用原验收脚本；375／768／1024／1440 浏览器流程通过，页面错误为空。
额外 MCP 导航因共享浏览器配置被占用而未完成，未关闭或重启其他会话的浏览器；上述浏览器通过证据来自本轮专用 Docker 实例。
历史日志未用于本次验收，原 API 草稿哈希复核未变；模型配置始终为空，未提交、推送或公开部署。

## 主工作区整合记录（2026-11-24）

按用户确认整合到主工作区当前分支 `fix/gallery-image-fit-and-generation-wait`，保留未提交状态，未切换 `main`。
整合前备份 82 个已有文件；清单位于 `.local/api-entry-integration/integration-20261124T081705135Z/`。
唯一重叠的 Nginx 文件保留原静态缓存、音频及服装预览规则，源 review worktree 未修改。
其他会话继续修改的页面和测试文件单独保留并记录，不将它们误称为哈希未变。

首次入口验证实例 `entry-5a9302e1d04e41e1943c86b015be3b9b` 在第二轮核验突发中放行 6 次，预期为 5 次；
带时间及状态输出的诊断实例 `entry-600203da163f4dc497dcf4c587b335a8` 未重现，不能把复跑通过当成失败已解决。
Nginx 1.28 的[官方限流模块源码][nginx-limit-source]
显示多个 `limit_req` 的前置区存在检查与记账分离的窗口。该机制与现象相符，本次失败的完整归因仍有限制。

整合时收敛为每路由一个区，删除不再需要的条件 key 映射，保持速率、突发数、429 契约和原测试断言。
共享代理片段由 [web 镜像](../docker/web.Dockerfile) 显式复制，保留原代理和 SSE 边界。
中间验证暴露了嵌套 location 无法继承完整路径改写的问题，已改为顶层路由显式包含同一片段；
失败实例 `entry-187224021d6545fc9cd26a86562bc0a9`、`entry-373cc7606c2d43afa5f5abc031416354`
及对应完整回归失败记录保留，不计入通过证据。

| 整合后检查 | 结果 |
| --- | --- |
| 原入口专项 | `entry-3a9906679d0a4378a92806a7ac206036` 整次通过并清理，含路径、429、SSE、网络附件、用量零写入 |
| Go／Node／构建 | 最新完整回归的全量 Go 测试、gofmt、vet、Node 检查、构建和镜像边界通过 |
| 完整 Phase 8 | `phase8-5e9811836e8f4349b349835e1404f6c3` 在浏览器滚动条点击断言失败，预期 W017、实际 W002；未验收通过 |
| 补跑真实 HTTP | `entry-22b8f17c53954f52be2daef577258af8/19.log` 的三个 413 场景、鉴权、空模型和输入分类通过 |
| 补跑重启 | 同实例 `22.log` 的后端重启、可写用量卷及重新授权通过 |
| 独立真实浏览器 | `entry-browser-f2b61f4d832d48c6ab47a18c6f981f92` 的单人拒绝、更换照片、双人重试及真实 SSE 通过并清理 |

入口和 HTTP 证据位于主工作区 `.local/api-entry/`，完整回归位于 `.local/phase8/`；
独立浏览器证据位于 `.local/api-entry-integration/`。补跑包装器最初把四码配置交给要求两码的人脸测试，
因此在输入契约处失败；该记录保留，浏览器通过仅来自独立两码实例，不把整个包装器描述为通过。
完整回归的滚动条失败仍是未完成项，未改动或放宽其他会话的页面／测试断言。

独立浏览器临时包装器清理时误删了默认 Go 缓存卷；已修正专用卷参数，并从工具镜像恢复依赖、通过 Docker 内
`go build` 重建缓存。应用容器和业务用量卷未删除，恢复记录为 `.local/api-entry-integration/cache-restore.json`。
源 review worktree 保持原状，主工作区仍为未提交改动，未推送、调用真实模型或公开部署。

[nginx-limit-source]: https://github.com/nginx/nginx/blob/release-1.28.0/src/http/modules/ngx_http_limit_req_module.c
