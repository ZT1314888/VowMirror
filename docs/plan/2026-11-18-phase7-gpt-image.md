# Phase 7：GPT Image 实施与评测

更新日期：2026-11-19。分支 `feat/wedding-phase-7-model-evaluation` 从 Phase 6 的 `36a92a6` 继续；五份既有草稿已备份到 Git／Docker 忽略的 `.local/phase7-pre-gpt-image/`，并记录 SHA-256。原 `.gitignore` 改动保留，Node 检查、评测脚本与路线图草稿在原位置整合。本文件不代表真实模型调用授权。

当前实测：G1 第二次、G3、G4、G5 六项评分均通过；G2 并行诊断最快图六项评分均通过，单独作为 G2 可判定证据，不改变正式尝试次数和正式合格组数。G2 前两次正式调用成功但未按指定侧别穿衣，第三次 **85064ms** 超时；G2 并行诊断三条 API 调用均成功，耗时 **53300ms**、**52823ms**、**47975ms**，供应商未返回型号与请求 ID。真实取消专项通过，受控 90 秒异常验证证据有效。唯一报告校验为 **5 组可判定／4 组合格**，`phase8Ready=true`。

## 当前实现

唯一生成实现为 GPT Image 多文件编辑：`POST /v1/images/edits`，服务端固定 `chuanapi`／`gpt-image-2.5-flare`。有序文件为合照、婚纱、男装、男鞋特写、可选场地图，字段均为 `image[]`，每份携带真实 MIME；提示词对应角色顺序。输出固定 `n=1`、`size=1536x1024`、`quality=medium`、`output_format=png`。不丢图、不重试、不切模型或出口；第三方不支持完整协议时明确失败。

仅接收一张内联 `b64_json`，完整解码校验 PNG 和实际尺寸；不下载结果 URL。HTTPS、Bearer Key、拒绝重定向、单图／参考图总量／请求和响应上限保留。供应商正文、Key 与配置不返回或写日志。对外请求字段不变，响应只追加可选 `provider_model`、`provider_request_id`；原 `model`、`request_id` 仍是请求型号及应用请求标识。供应商声明别名与日期快照区分记录，不提供则明确缺失，声明其他模型则拒绝结果。

页面计时从提交准备开始，直到图片成功解码并进入可见渲染帧；浏览器端到端硬期限为 90 秒，后端请求上下文、模型 HTTP 请求与读取最多 85 秒，服务端写入和 Nginx 代理读取期限为 95 秒。解码中取消／超时能释放 Object URL 并恢复控件；迟到网络或解码不能恢复旧结果或覆盖新请求。照片及结果不持久化，刷新不恢复。

官方协议参考：[图片编辑 API](https://developers.openai.com/api/reference/resources/images/methods/edit)。该文档不能证明第三方出口兼容性或真实效果。

## 评测唯一规则与报告

所有报告结构和通过规则由 [phase7-evaluation.mjs](../../scripts/phase7-evaluation.mjs) 的 `PHASE7_POLICY`／`evaluateReport` 消费。本文描述操作流程，不另写判定计算器。报告保存在忽略的 `.local/phase7/`，只含匿名元数据；不保存人物图片、结果、Token、原始指令／网络正文或私人路径。`diagnosticBatches` 保存不计入正式 attempts 的诊断调用及独立六项评分；已评分诊断图可使对应组可判定，但不计正式合格组或尝试次数。

模板：`node scripts/phase7-evaluation.mjs --template`；校验：`node scripts/phase7-evaluation.mjs .local/phase7/report.json`。也可通过根 Compose 的 `tools-node` 执行。模板允许空尝试、待评分和未完成专项，返回 blocked，不把未完成视为非法，也不生成成功记录。

| 组别 | 合照 | 套装 | 婚纱画面侧 | 场地 |
| --- | --- | --- | --- | --- |
| G1 | C001 | W001 | 左 | 原背景 |
| G2 | C002 | W002 | 左 | 上传 S004 |
| G3 | C001 | W003 | 右 | 原背景 |
| G4 | C002 | W004 | 右 | 上传 S006 |
| G5 | C001 | W005 | 左 | 上传 S001 |

每条 `attempts` 记录含顺序编号 `number`、逐次 `authorization: {reference, approvedAt}`（匿名 `chat-YYYY-MM-DD-…` 指令引用及 ISO 时间）、`outcome`、完整 `durationMs`、应用 `requestId`、供应商 `providerRequestId`、`providerModel` 和 `providerModelStatus`。供应商标识未获得时显式填 null；型号状态分别为 `not_provided`、`reported_alias`、`reported_snapshot`，不得把请求别名伪装成返回快照。

成功但待评分时 `outputReviewed:false`、`assessment:null`，由用户在当前页面逐项确认后改为 true 并填六项布尔评分：`identity`、`outfit`、`shoes`、`noMix`、`fullBody`、`scene`。任一项失败不合格，C001 输入鞋履裁切不能豁免生成鞋履要求。每组最多三次，首次合格立即停止；后续尝试必须重新收到明确手动指令，不自动触发。

`outcome` 为 `success`、`provider_error`、`timeout` 或 `cancelled`。失败没有人工图像评分。超时／取消另填 `resourcesReleased` 和 `lateResponse:{observation,isolated}`：observation 为 `observed`、`not_observed` 或 `unobservable`；只有观察到迟到结果时 isolated 才能填布尔，否则必须为 null，避免把不可观察冒充已隔离。

独立 `cancellation` 专项复用 G1 输入，使用单独指令，编号为 1、不计入质量尝试；除通用尝试字段外含 `inputCaseId:"G1"`、`browserStopped`、`backendCancelled`、`resourcesReleased`。仅验证浏览器停止展示、后端取消传播及本地并发释放；不能据此声称供应商停止计算或计费。

`controlledValidation` 记录完整 90000ms 期限、超时／迟到隔离／本地资源释放布尔证据和匿名 `evidenceId`。`naturalProviderTimeout` 用相同三态描述自然供应商超时；未观察不单独阻塞阶段通过。最终五组都须可人工判定、至少四组在次数和完整耗时限制内全部质量达标，并通过受控异常与真实取消专项；缺样本、未评分或协议／质量／时延失败均保留 blocked，不推进 Phase 8。

## 无付费验证

复用 [现有隔离验收入口](../../scripts/verify-phase6.ps1)，参数 `-Stage phase7`：

```powershell
pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase7 -ColdBuild
```

全部 Go 依赖、格式化、测试、vet 和构建均在 Docker。测试计时前准备编译，整条后端测试使用 58 秒外层期限及 2 秒终止宽限。普通测试和 CI 使用空模型配置、internal 网络和非人物 PNG／JPEG／WebP 夹具；浏览器生成响应受控，未拦截生成会立即失败。新增解码失败、等待解码中的取消与超时、旧解码覆盖新请求检查，以及实际等待完整 90 秒的浏览器超时。通过标准要求实际调用浏览器 MCP，单纯启动服务不算证据。

历史 Phase 3／6 记录保留原意，不改写为 GPT Image 实测证据。

### 改造前验证记录（60 秒历史基线）

| 检查 | 本轮证据 |
| --- | --- |
| 完整隔离入口 | `-Stage phase7` 退出 0，13 项检查；`.local/phase7/phase7-7135ea368fca43988c66ecc0381f34a1/summary.json` 记录两个 internal 网络、空模型配置、真实模型调用 0、资源清理通过 |
| 最终冷构建复验 | `-Stage phase7 -ColdBuild` 退出 0，13 项检查全部通过；最终证据 `.local/phase7/phase7-ea8e0e1cc0e347619dacf98955ecf679/summary.json`，五类镜像禁用构建缓存重建，覆盖最终供应商快照标注和授权校验；完整超时实际观察为 60443ms，受控响应与解码迟到隔离通过，模型调用 0、清理通过 |
| 后端与构建 | 全量 Go 测试、gofmt、vet、构建及五类受影响镜像构建通过；图片编辑协议覆盖完整四／五图顺序、真实 MIME、固定输出、单次请求、错误／损坏／超限／多图／URL 拒绝、模型声明、HTTPS、重定向、取消及 HTTP 并发名额释放 |
| Node 与边界 | 图片、素材与评测测试通过，真实清单／夹具清单、全部路线图任务 ID、源码清理、文档链接与镜像边界检查通过；浏览器边界测试证实未受控生成被拦截，控制台各级敏感标记检查通过 |
| 完整 Chromium（改造前 60 秒历史基线）| 四种视口、合照／场地、目录互斥、生成锁、预览下载、手动重试与刷新隐私通过；结果真实解码、解码失败、取消／超时的迟到解码、旧解码不覆盖新请求及 Object URL 释放通过；完整实际超时等待观测为 60326ms（含自动化点击和观察开销），页面配置期限为 60000ms |
| 浏览器 MCP | 实际访问本机 `127.0.0.1:3007` 的空模型预览，健康 200，375／768／1024／1440 均无横向溢出，空场馆隐藏、照片／结果和 localStorage／sessionStorage 为空；窗口保留。internal 验收网络不开放宿主机端口，未将其连接失败计作通过 |
| 草稿与隐私 | 五份草稿备份哈希一致；原 `.gitignore` 改动保留；修改与新增文件无凭据高危模式、私人绝对路径、乱码或私有图片／产物，暂存区为空；未提交、推送、合并或公开部署 |

失败未计作通过：首次 Go 格式化沿用只读工具挂载而失败，改为仓库内独立写入挂载后完成；早期取消用例存在输入夹具准备占用短期限的窗口，准备移出计时、按上游到达触发取消后，定向与全量测试通过。首次完整浏览器验收发现旧受控结果用非横版夹具却声明横版尺寸；新解码校验正确拒绝，改为浏览器实际生成的非人物 `1536×1024` PNG 后完整入口通过。文档管道曾丢失中文编码，已用 UTF-8 重写并逐文件扫描通过，原草稿备份不受影响。

最后补充的供应商型号缺失标注及授权引用敏感模式检查已随最终冷构建复验通过。之后 G2 并行诊断、G3–G5 单次直接 API 调用、真实取消专项及人工评分均已记入唯一匿名报告；最终校验为 `status=passed`、5 组可判定、4 组合格、`phase8Ready=true`。

### G1 第 1 次真实调用（2026-11-18）

在单独指令 `chat-2026-11-18-G1-1` 下，于 `2026-11-18T12:21:43.377Z` 通过实际浏览器页面提交一次：C001＋W001、婚纱画面左侧、保留原背景。调用前核验私有接收清单哈希与真实解码，四张参考图合计 854475 字节。页面未保存访问 Token；没有自动重试、切换型号或出口，也未执行其余组或真实取消专项。

本次返回 `504 / GENERATION_TIMEOUT`，应用请求标识为 `18e92315e38a8d424faad81ed41b700b`；从提交到观察到失败为 55030ms。已证实触发后端 55 秒期限，没有可显示或下载的图片，不能进行人工质量评分。没有取得供应商返回型号、快照或请求标识，也不能据此判断供应商是否继续计算或计费；迟到供应商结果记为不可观察，自然供应商超时仍记为未观察。

页面控件已恢复，结果及下载链接为空。使用同一访问主体发送必定在图片校验阶段拒绝的无效输入探针，返回 `422 / UNSUPPORTED_IMAGE_TYPE`，而非并发限制，证实本地并发名额可重新获取；该探针在模型工厂之前返回，不触发额外模型调用。G1 第 1 次已记录为 timeout、未评分、本地资源释放通过；匿名报告及调用记录只保存上述元数据，不保存人物照片、结果图片、访问 Token 或原始网络正文。阶段继续 blocked，后续真实尝试须另行取得手动指令。

## 后续边界

交付顺序为 **Phase 7 实测 → Phase 8 正式界面 → 独立服务器公开上线交付**。本轮不做正式页面改版或服务器部署。将来网页公众可访问，生成仍需有效访问 Token，Token 线下分发，不新增邀请码兑换、账号、支付或历史图库。域名与 HTTPS、可信来源、代理、限流和并发、运行时密钥、日志隐私、部署及回滚在上线阶段核查。

真实调用须逐次指令；提交、推送、合并与公开部署也分别另行授权。


### Phase 7 阶段观测与 SSE 期限（2026-11-18）

生成路由继续使用 POST /api/tryon/couple、原 JSON 请求和 Bearer 鉴权；成功及开流后的业务失败统一通过 SSE status、heartbeat 与唯一 `result`／`error` 终态返回。鉴权、请求大小和严格 JSON 失败仍在开流前返回原 HTTP 错误。前端以有界解析器消费 UTF-8 流，事件上限 12 MiB、整流上限 13 MiB；不自动重连、重提或回退 JSON。

服务端通过注入的观测器和 httptrace 记录输入、图片校验、素材准备、请求组装、DNS、TCP、TLS、上传、首字节、响应读取及结果校验。复用连接未发生的 DNS/TLS 不记录为零耗时。请求边界日志只输出请求 ID、阶段耗时、状态码、错误类别和字节数，不记录 URL、IP、凭据、图片或正文。状态文字只随真实阶段变化，心跳不表达进度、不重置期限。浏览器 90 秒期限从提交准备开始；服务端请求上下文／模型调用 85 秒，服务端写入与 Nginx 代理读取 95 秒。既有 60 秒浏览器记录和 55 秒 G1 第一次调用只作为历史证据保留，不计为本次 90 秒验收。

万川（`chuanapi`）图片 SSE 兼容性为**未验证**。本轮 SSE 仅位于浏览器与 Go 之间，供应商仍使用完整四／五图 multipart 编辑请求和最终 JSON 回包；不发送 `stream` 或 `partial_images`，不伪造预览，不通过自动降级或重试探测能力。保持 `gpt-image-2.5-flare`、单张 `1536×1024` PNG、medium。在本次 SSE 改造完成时，G1 第一次 55 秒超时仍占一次尝试，下一次 G1 为第二次（后续执行见下文）；真实调用、提交、推送、合并及部署仍逐项另行授权。

### 本轮 SSE 与 90 秒无付费验收

| 检查 | 本轮结果与证据 |
| --- | --- |
| 草稿与匿名记录 | 修改前备份至忽略目录 `.local/phase7-sse-prework-20261118`；草稿整合回原文件，历史 G1 第一次 55030ms 超时及全部真实尝试数据逐项比对未变 |
| 定向与全量 Go | Docker 内 cmd／tryon 定向测试及全量测试、gofmt、vet、构建通过；真实 HTTP 提前发送状态及心跳、唯一终态、Write／ShortWrite／Flush 错误、断连传播与退出前并发释放通过；DNS/TCP/TLS 首次执行及复用连接阶段缺席、响应头元数据在后续失败时保留通过 |
| Node | 图片 7 项、SSE 解析器 11 项、素材 84 项、评测 28 项通过；包含逐字节 UTF-8、CRLF 实际字节数、无换行超限、挂起读取取消、异常流与无 JSON 成功回退；清单、项目结构和文档链接通过 |
| 隔离 Compose | `pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase7` 退出 0，共 13 项检查；`.local/phase7/phase7-8c579d1fe5dd478392240fbbf53a30a8/summary.json` 记录五类镜像构建、两个 internal 网络、四项模型配置为空、模型调用 0、清理通过；本次使用构建缓存 |
| 完整 90 秒 | 同一运行 `12.log` 记录实际观察 90142ms、8 次连续心跳；心跳不改变提示，仅超时更新一次状态；读取取消、Abort、迟到终态拒绝、迟到解码隔离和手动重试通过。该期限夹具为浏览器内存流，真实 HTTP 刷新／取消由 Go 测试另行验证，均不证明真实模型效果或时延 |
| 真实浏览器 MCP | 对独立空模型预览实际 navigate／evaluate／resize；健康 200，经过 Nginx 的 SSE 业务错误终态为 `MODEL_CONFIGURATION_INVALID`、`http_status:503`；375／768／1024／1440 无溢出，空场馆隐藏，照片／结果／浏览器存储均为空，窗口保留 |
| 冷构建限制 | 首次 `-ColdBuild` 在依赖下载失败，未计通过；证据 `.local/phase7/phase7-17168a0303754412a73b457e1f0c5e77/02.log`，Go 模块代理流错误、Debian 软件源连接失败；后续使用已有缓存重新构建及完整隔离验收通过 |
| 最终审查 | 独立只读审查未发现阻塞；`git diff --check` 通过，41 个修改／新增文本文件无高危凭据模式、私人绝对路径、乱码替换符或异常控制字符；暂存区为空 |

新受控证据另记于忽略目录 `.local/phase7/sse-90s-validation.json`；匿名报告仅将 `controlledValidation` 更新为本轮 90000ms 证据，历史真实尝试不改写。真实评测仍为五组 0 可判定／0 合格，取消专项尚未执行，Phase 7 真实模型验收继续 blocked；本轮不发付费请求、不推进 Phase 8、不提交或推送。

### G1 第 2 次真实调用（2026-11-18）

收到单独指令 `chat-2026-11-18-G1-2` 后，将真实本地运行容器从旧 55 秒 JSON 版本更新到已验收的 90 秒 SSE 版本；模型、出口与访问配置均沿用原环境，不修改凭据。私有接收清单摘要及完整解码核验通过后，于 `2026-11-18T15:53:25.954Z` 从实际页面提交一次 C001／W001、婚纱画面左侧、保留原背景的四图请求。浏览器实际生成请求计数为 1，没有自动重试、切模型或新增质量尝试。

本次应用请求标识为 `18e92ea370423ce81ee10756c0ee9761`。请求在 1289ms 完成上游上传，55150ms 收到上游首字节和 HTTP 200；响应体读取 14635ms，69901ms 完成服务端结果图片校验。浏览器在 **70172ms** 完成解码并进入可见渲染帧，实际 PNG 尺寸为 **1536×1024**，预览可见、下载链接可用、控件恢复。以上均为本次实测，不据此补写第一次调用缺失的阶段时序。供应商没有返回型号、日期快照或请求标识，匿名报告如实记录 `not_provided`，不以请求别名代替真实版本。

同一访问主体的额外无效输入探针在模型工厂之前返回 SSE `INVALID_IMAGE_BASE64`、原错误状态 422，证实并发名额已释放且不增加模型调用。Token 不保存到浏览器存储、界面输入已清空；人物照片与结果仅保留于当次浏览器预览／客户端主动下载，未写入应用服务器或评测报告。匿名材料为忽略目录中的 `G1-2-call.json`、`G1-2-browser-evidence.json`、`G1-2-diagnostics.json`；更新前报告另存 `G1-2-report-before.json`，第一次 55030ms 超时逐项保持不变。

调用结束时，唯一评测校验器接受第二次 `success` 记录；当时为 `outputReviewed:false`、`assessment:null`，没有代替用户判断人物、服装、鞋、不混穿、全身或场地质量。该时点五组为 0 可判定／0 合格、真实取消未执行，Phase 7 为 blocked。后续人工确认记录见下文，任何新增真实调用仍需另行指令；本次调用无提交、推送、合并或部署。

### G1 人工确认与收尾进度（2026-11-19）

按用户已确认并批准的收尾计划，将 G1 第二次 `outputReviewed` 更新为 true，六项 `identity`、`outfit`、`shoes`、`noMix`、`fullBody`、`scene` 全部记录为 true。评分按主要特征准确判断，允许合理光影、姿态及透视变化；要求人物身份与角色正确，服装和鞋款关键特征准确、不混穿，双人头到脚完整且鞋履可辨，场地符合所选模式。原始 **70172ms**、请求标识、供应商版本缺失状态和第一次 **55030ms** 超时均保留，没有新增 G1 调用。

通过根 Compose 工具运行唯一报告校验器，最终返回 `status=passed`、`adjudicableGroups=5`、`qualifiedGroups=4`、`phase8Ready=true`。G2 最快诊断图单独完成人工评分，诊断条目使 G2 可判定；诊断批次保持独立，不占正式三次尝试、不增加正式合格组数。G3–G5 各一次 API 成功结果和六项评分全部通过。真实取消专项使用独立 G1 API 请求，在 `waiting_upstream_response` 阶段由 Chrome 原生 Fetch 中止；浏览器得到 AbortError，后端匿名日志记录 `client_cancelled` 和上游 `cancelled`，随后同主体无效图片探针返回 422 `INVALID_IMAGE_BASE64`、未调用模型，确认本地并发槽位已释放。受控异常证据有效。模型结果评分之外未发起真实重试；未提交、推送、合并或部署。

### 本轮冷构建与实际浏览器证据（2026-11-19）

本轮仅补齐验证和文档，没有证据要求修改业务代码。以下是当前源码的重新执行结果；前述依赖下载失败、缓存构建、旧期限与评分前记录均保留其历史范围。

| 检查 | 本轮证据 |
| --- | --- |
| 现场保护 | 继续使用 `feat/wedding-phase-7-model-evaluation`，HEAD 为 Phase 6 的 `36a92a6`；49 份源码、草稿及匿名 JSON 备份至忽略目录 `.local/phase7-closeout-prework-20261119-104432`，逐文件 SHA-256 一致，清单记录原路径为整合去向；未复制真实凭据或人物图片，未使用 stash |
| 私有输入与固定素材 | 根 Compose `tools-node` 重新验证 2 张合照、9 张场地图的完整解码、真实格式、尺寸、字节数与接收摘要；固定素材清单文件检查通过；W001–W005 的 15 张参考图用同一工具镜像完整解码，单图及五组总量均在边界内；匿名元数据见 `.local/phase7/closeout-input-evidence.json` |
| 实际运行版本 | 运行时模型、HTTPS 出口和访问配置合规，容器配置与 Compose 一致；只输出合规状态。实际页面脚本与源码 SHA-256 相同，运行后端二进制与按当前源码重建的二进制 SHA-256 相同；浏览器 90000ms、后端 85 秒、代理读取 95 秒生效，私有目录及真实配置未挂入应用 |
| 完整冷构建 | 唯一入口 `pwsh -NoProfile -File scripts/verify-phase6.ps1 -Stage phase7 -ColdBuild` 退出 0，13 项检查通过；证据 `.local/phase7/phase7-e1ba115953094c3aac359179f104049f/summary.json`；五类镜像均 `--no-cache` 重建、独立项目及全新 Go 缓存、四项模型配置为空、两个运行网络均 internal、真实模型调用 0 |
| 测试与构建 | Go 全量测试在 58 秒外层硬期限内通过，gofmt／vet／构建通过；Node、镜像内容边界、HTTP 鉴权／请求体上限／无效输入与空模型契约、完整 Chromium 烟测通过 |
| 完整 90 秒 | 冷构建同次 `12.log` 实际等待 **90040ms**，8 次心跳、超时状态仅更新一次、读取取消及 Abort、迟到终态与解码隔离、URL 释放和手动重试通过；此项使用浏览器内存流夹具，不证明真实供应商时延、取消或停止计费 |
| 清理 | 冷构建脚本确认验收容器、卷、网络无遗留后写入 `cleanup=passed`；本机用于继续评测的应用与独立空模型浏览器预览不属于该已清理的验收项目 |
| 实际浏览器 MCP | 实际 navigate／run_code：空模型预览健康 200、目录未鉴权 401、无效图片 SSE 终态 `INVALID_IMAGE_BASE64`／422、有效非人物输入的空模型错误 503；受控单次 SSE 结果实际解码为 `1536×1024`，预览和下载事件通过；375／768／1024／1440 无溢出，空场馆隐藏，刷新后照片、结果、下载链接及浏览器存储为空；匿名证据 `.local/phase7/closeout-browser-evidence.json` |

匿名报告的 `controlledValidation.evidenceId` 已指向上述本轮冷构建；历史 SSE 验收 JSON 与两次 G1 调用原始记录未改写。在该次无付费收尾验证完成时，G1 已合格停测，G2–G5 及真实取消尚未获得后续调用指令，也没有新增付费请求；不声称真实取消传播、供应商停止计算或停止计费已经验证。当时下一步依赖 G2 第一次的单独调用指令，收到后只执行该次并保留预览等待六项人工评分；后续执行见下文。阶段继续 blocked，不进入 Phase 8；未提交、推送、合并或部署。

### G2 第 1 次真实调用（2026-11-19）

收到单独指令 `chat-2026-11-19-G2-1` 后，将两条重复授权消息视为同一次授权，只执行 G2 一次。复核运行配置、私有接收摘要与完整解码、W002 三张参考图后，于 `2026-11-19T03:11:47.096Z` 从实际浏览器页面提交 C002＋W002、婚纱画面左侧、上传 S004 的五图请求，参考图原字节合计 **1199466**。出站请求中的合照和场地图 SHA-256 与接收清单一致；生成请求计数为 **1**，没有自动重试、切模型或触发其他组／取消专项。

应用请求标识为 `18e953a7e8b860416ce91c0827288353`。上游上传在 **1868ms** 完成，**39240ms** 收到首字节及 HTTP 200，响应体读取 **1015ms**，服务端在 **40389ms** 完成结果图片校验；浏览器在 **43337ms** 完成解码并进入可见渲染帧，实际为 **1536×1024 PNG**，预览可见、下载链接可用、控件恢复。供应商未提供返回型号、日期快照或请求标识，报告明确记为 `not_provided` 与 null，不将请求别名视为实际版本。

同一访问主体的独立无效图片探针在模型工厂之前返回 SSE `INVALID_IMAGE_BASE64`／422，证明本地并发名额可重新获取，不增加模型调用。Token 未保存到浏览器存储，界面输入已清空；照片和结果保留于当次浏览器预览，未保存到应用服务器、日志或 Git。匿名材料为忽略目录中的 `G2-1-call.json`、`G2-1-browser-evidence.json`、`G2-1-diagnostics.json`；更新前报告备份为 `G2-1-report-before.json`，G1 两次尝试与已确认评分保持不变。

G2 第一次记录为 `success`、`outputReviewed:false`、`assessment:null`。成功出图不代替身份、服装、鞋履、不混穿、全身及场地六项人工评分；本次预览保留，等待用户确认后再处理下一组。当前仍为 1 组可判定／1 组合格、`phase8Ready=false`；未提交、推送、合并或部署。

收到新指令后，使用 G2 第三次也是最后一次机会测试更明确的侧别映射，输入仍为 C002＋W002、左侧、S004。提示要求以参考 1 确定身份与原左右位置，保留双方身份和站位；只按界面选定侧分配婚纱，不按性别或常规婚礼角色推断，并明确允许男性穿婚纱／女性穿男装。于 `2026-11-19T06:36:44.232Z` 从实际页面提交一次，出站 C002 与 S004 哈希与清单一致，五张输入共 **1199466** 字节。请求标识 `18e95ed71218a19db8dcdf83bc168d12`；上传在 **3946ms** 完成，之后停留于 `waiting_upstream_response`，后端在 **85064ms** 返回 `504 / GENERATION_TIMEOUT`。供应商响应状态为 0、响应字节为 0，没有图片，无法评价新提示的图像效果；供应商是否继续处理或计费不可观察。无效输入探针于模型工厂前返回 `INVALID_IMAGE_BASE64`／422，确认本地并发名额释放，没有增加模型调用。该次实际提示原文保存在 `.local/phase7/G2-3-prompt.txt`，SHA-256 为 `d2016b950abf858d342831b78a5632b659ae8663e3c47cd15a1948c490740a77`；调用与诊断记录在同目录 `G2-3-call.json`、`G2-3-browser-evidence.json`、`G2-3-diagnostics.json`。最终隔离冷构建使用同一修改后代码通过 13 项检查，证据 `.local/phase7/phase7-d3388240810c4a94b838fee2168075f5/summary.json`，90 秒浏览器期限实测 **90436ms**、清理通过。该无付费验收不能弥补本次付费请求超时或代替真实角色映射结果。G2 已达到三次上限，未自动重试；G3–G5 和真实取消未执行，阶段仍 blocked。

本次重测使用的完整提示词（英文原文）：

> Create exactly one landscape full-body wedding photograph of the same two people from reference 1 (couple). Reference 1 defines each person's identity and viewer-left/viewer-right position. Preserve both identities, faces, natural proportions, and original left/right positions; do not swap or move the people across sides. Assign clothing by the selected side only, regardless of gender or conventional wedding roles: the person on the viewer's left in reference 1 must wear only the wedding dress from reference 2 (dress). The other person must wear only the menswear, including shoes, from reference 3 (menswear), with shoe details from reference 4 (shoes_detail). This assignment may intentionally put a man in the wedding dress or a woman in menswear. Do not infer clothing from gender or the original outfits, and do not mix garments. Show both people from head to toe, including complete shoes, without cropping. Use reference 5 only for the venue; preserve its architecture, stage and decorations without replacing the people.

提示词实现将原合照中的左右身份与生成站位绑定，再按所选位置分配婚纱；不通过女性身份推断穿衣者。界面选项现标注“原合照哪一侧的人穿婚纱”，说明服装按原图左右分配并保留站位。后端定向测试覆盖左右两侧和性别无关的服装指派。第三次未收到图像，尚无证据说明这一提示能否实现男性穿婚纱。

### 三并行接口诊断（2026-11-19）

用户在正式 G2 三次尝试完成后另行明确要求三条并行调用、呈现最快结果。本批作为额外诊断单独记录，正式报告不增加第四至第六次尝试，也不将最快样本写成 Phase 7 已通过。单实例全局并发为 2、每主体为 1，最终使用三个根 Compose 隔离实例各处理一条直接 API 请求；未修改生产并发配置。三个请求均为 C002＋W002、原合照左侧、S004，沿用第三次的相同明确提示词，SHA-256 为 `d2016b950abf858d342831b78a5632b659ae8663e3c47cd15a1948c490740a77`。从浏览器准备切换为宿主机直接 HTTP 后，三次 POST 在 16ms 内启动，没有自动重试。该批次现已通过 `diagnosticBatches` 纳入唯一报告，并保持与正式 `attempts` 分离。

| 诊断请求 | 完整 API 返回耗时 | 上游首字节 | 结果 |
| --- | --- | --- | --- |
| parallel-01 | 53300ms | 50522ms | 1536×1024 PNG |
| parallel-02 | 52823ms | 50228ms | 1536×1024 PNG |
| parallel-03 | 47975ms | 46091ms | 1536×1024 PNG，最快 |

每个实例的后端完成日志均唯一对应请求 ID、上游 HTTP 200 及 `validating_result` 完成；没有并发拒绝。上述时间为直接 API 请求至收到完整终态，未包含页面解码或人工评分，不能替代正式评测的可查看耗时。最快结果可视观察为左侧男性穿婚纱、右侧女性穿男装，左右服装指派目标已在这一诊断样本中实现；六项质量仍需用户确认，不因此宣称所有结果均合格。供应商三次均未返回版本和请求标识，不捏造具体版本。

本批证明同一后端实现和提示词可以收到成功上游响应、校验结果并返回图片；历史单次 85 秒超时仍只能确定为等待上游响应时到期，不能据本批成功精确归因历史超时。匿名时序见 `.local/phase7/upstream-parallel-diagnostic-results.json`；最快图片仅作为本机客户端查看文件留在忽略目录，不写入应用服务器或日志。三组临时 Compose 容器和网络已清理，主应用保留。没有修改正式报告和评分，没有提交、推送或部署。

本次五图不包含姿势库图片，提示词没有指定库中姿势；姿态由模型基于上述参考图生成。未对结果与姿势库逐图比对，不能据外观相似认定采用了某张姿势图。

### G3–G5 单次直接 API 与真实取消专项（2026-11-19）

用户分别授权 G3、G4、G5 各一次真实生成及 G1 取消专项一次。三组经固定私有素材清单校验输入字节后，由本地 Node 执行器直接 POST `/api/tryon/couple`，没有通过页面提交或 Playwright；每个请求只执行一次。返回图片仅保存到 Git 忽略目录供人工评分。

| 项目 | 结果 | 耗时 | 应用 request ID | 供应商型号／请求 ID |
| --- | --- | --- | --- | --- |
| G3 第 1 次 | 成功，`1536×1024` PNG | 45616ms | `18e968ab61b4c66a4abd910dcc8ad44a` | 未提供／未提供 |
| G4 第 1 次 | 成功，`1536×1024` PNG | 56212ms | `18e968bfb4063fccfb8b5d770c776887` | 未提供／未提供 |
| G5 第 1 次 | 成功，`1536×1024` PNG | 47790ms | `18e968e464a2d208e833eb1f8e8ee493` | 未提供／未提供 |
| G1 取消专项 | 浏览器 AbortError；后端 `client_cancelled`／上游 `cancelled`；无图片 | 2119ms | `18e9695abf5e982abcd803c877eb5233` | 未提供／未提供 |

取消专项通过 Chrome 原生 Fetch 与既有 SSE reader 直连 API。请求进入 `waiting_upstream_response` 后浏览器 abort，SSE reader 释放锁；后端结构化日志没有上游响应字节，并记录客户端取消。随后用同一访问主体发送无效图片探针，SSE 返回 `422 / INVALID_IMAGE_BASE64`，后端记录 `upstream_request_bytes=0`，证明验证前取得并释放本地并发槽位，未再调用模型。该证据不表示供应商停止计算或停止计费。匿名结果与校验元数据只进入忽略的 `.local/phase7/report.json`；所有成功图像待用户完成六项人工评分。

浏览器工具自动生成的一份本地无障碍快照曾包含后端访问 Token，最终敏感扫描发现后已原位清除该值并复扫通过；该文件被 Git 忽略，模型 Key 未进入快照。后续在 Token 仍位于页面时仅使用返回匿名元数据的 `run_code` 轮询，清空 Token 后才调用会自动生成快照的等待／页面工具，避免再次记录密码输入值。匿名处置记录为 `.local/phase7/G2-1-browser-artifact-privacy.json`。

### 最终验收与提交前复核（2026-11-19）

用户确认 G2 最快诊断图及 G3、G4、G5 六项评分全部为 true。结合既有 G1 第二次评分，唯一报告为 5 组可判定／4 组合格、`phase8Ready=true`；G2 诊断批次仍与正式三次分开，只补充可判定证据。真实取消专项已通过。README、当前架构及路线图同步此结论，较早的调用段落保留当时状态。

提交前修正评测器误读不存在的 outcome 字段而遗漏待评分尝试的问题，统一使用已计算的 pending 状态；非法诊断数组和缺失组记录返回明确结构错误，不抛未处理异常。新增待评分重试与非法结构回归，评测器 30 项测试通过，真实报告重新校验仍为 passed。G2 已评分诊断补充可判定的既定规则保持不变。

本轮 `-Stage phase7` 隔离验收通过 13 项检查，证据为 `.local/phase7/phase7-7330d05310d14c6693ecac0d562ae5c8/summary.json`：使用构建缓存及全新 Go 缓存卷，Go 全量测试／格式／vet／构建、五类镜像构建、镜像隐私边界、HTTP 验收与 Chromium 烟测均通过；90 秒期限实测 90184ms，8 次心跳未延长预算，资源清理通过。评测器修正后再次运行完整 Compose Node 检查通过。模型配置为空、两个 internal 网络，真实模型调用为 0。

Playwright MCP 另实际访问本机主应用页面和健康接口：健康 200、SSE 模块加载、生成控件存在、结果为空且无横向溢出；未提交生成请求，窗口保留。待交付内容仅为 Phase 7，不包含私有报告、照片、结果、凭据或本地备份；Phase 8、合并及公开部署未执行。
