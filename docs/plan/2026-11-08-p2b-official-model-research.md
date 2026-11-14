# P2-B 官方模型资料与文档候选

## 当前验收口径（2026-11-14）

本轮仅核对官方公开文档，未调用模型。输入为合照、婚纱、男装、男鞋特写四张必填图，可选一张场地图，最多五张；不实现左右肖像。Phase 2 只确认文档支持的候选，不以真实角色保真、时延或请求取消实测作为前置依赖。取消费用、汇率、额度统计及预算拦截，真实模型调用仍需单独指令。

### 四／五图、横版与结果格式

以下为 2026-11-14 实际读取官方页面的结果。输入数量上限只证明能提交参考图，不证明模型稳定利用全部角色。

| 型号 | 官方状态／参考图数量 | 横版规格 | 输出格式 | 文档候选判断 |
|---|---|---|---|---|
| `gemini-3.1-flash-image` | Stable；最多 14 张，对象图最多 10、人物图最多 4 | 0.5K／1K／2K／4K，支持横版比例 | PNG／JPEG，Base64 图片数据 | 纳入文档候选；多人合照及服装图分类和保真待实测 |
| `doubao-seedream-5-0-flash-260915` | 当前模型列表存在；最多 10 张参考图 | 1K／1.5K／2K，支持指定横版宽高，如 1280×720 | PNG／JPEG | 纳入文档候选 |
| `doubao-seedream-5-0-pro-260628` | 当前模型列表存在；最多 10 张参考图 | 1K／1.5K／2K，支持指定横版宽高，如 1280×720 | PNG／JPEG | 纳入文档候选 |
| `gpt-image-2`，快照 `gpt-image-2-2026-04-21` | 官方模型页及快照均标 Deprecated；仍列 images/edits 支持，最多 16 图 | 支持 1536×1024 及自定义如 1536×864；宽高须为 16 的倍数且满足文档比例／像素上限 | PNG／JPEG／WebP | 保留能力核对，标注弃用，不列为当前首测候选或自动替换成新型号 |

文档候选集合为 Gemini 3.1 Flash Image 与 Seedream 5.0 Flash／Pro；本轮不指定首测型号，不按未验证的效果、时延或费用排序。实际账号可用性、完整角色映射、真实格式回包、保真与时延须在后续各自阶段核验，文档不能代替运行结果。旧稿称 `gpt-image-2` 为“现役”，本次已据当前官方页面纠正。

### 本轮官方来源

- OpenAI 模型及弃用状态：<https://developers.openai.com/api/docs/models/gpt-image-2>
- OpenAI Images API 输入图上限、尺寸和输出格式：<https://developers.openai.com/api/docs/api-reference/images>
- Google 型号、Stable 状态及尺寸：<https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image>
- Google 多图细分限制及输出示例：<https://ai.google.dev/gemini-api/docs/image-generation>
- 火山方舟当前模型列表（页面更新日期 2026-11-13）：<https://ark.volcengine.com/region:cn-beijing/docs/model-list>
- 火山方舟图片生成教程与型号对照：<https://docs.volcengine.com/docs/82379/1824692>

按 `search-routing` 与 `openai-docs` 读取官方来源。AnySearch 实际读取 OpenAI／Google；火山页面提取失败后改由 Exa `web_fetch_exa` 读取上述官方列表与教程，未启动 Exa `agent_run` 或真实图像模型请求。

P2-B1/B2 完成官方来源及能力核对；B3/B4 完成文档候选集合与弃用状态记录；B5 明确取消费用前置门槛，保真、时延及调用指令留到后续；B6 保持继承协议未接入生成业务路由。以上只完成 Phase 2 文档验收。

## 2026-11-08 历史调研（保留当时原义）

以下内容记录 2026-11-08 的资料与旧验收判断，不代表本轮重新核实历史价格、下线日期或旧阻塞。旧七图、费用核算和排序前置要求已由上方 2026-11-14 口径取代；历史中的“Phase 3 不能进入”描述仅为当时判断，不再作为当前门槛。

记录日期：2026-11-08。全部条目为**官方公开资料检索**，**非真实效果/性能验收**：本轮未调用任何模型、未发生任何付费请求、未取得任何生成图片。所有链接均为厂商官方文档，查阅日期均为 2026-11-08；版本/快照以官方页面当日内容为准。

本记录只整理官方文档能证明的边界。**不构成选型结论：除已下线模型按官方公告排除外，没有任何模型被批准、排除或排序定案**，首测模型选择由主代理在 P2-B5 费用上界核算完成后决策。

## 官方文档不证明的事项（对所有现役候选一致）

- **婚礼角色参考质量**：官方文档描述参考图数量与输入输出格式上限，不含婚礼换装、双人合照、婚纱/男装/男鞋多图保真的任何实测效果证据。
- **60 秒在线时延与取消**：官方文档未提供“在线生成请求可在 60 秒内完成并支持请求级取消”的证明；OpenAI/Google 批量通道为小时级，火山方舟图片 API 文档未见请求级取消或异步任务机制，均不能证明满足 D17 的在线硬期限。
- **完整可核算价格**：计价单位不一致（token 与按张），输入图计费、汇率、失败请求是否计费均未取得完整官方规则，P2-B5 的 100 元上界**无法在本轮完成核算**。

## P2-B1 候选与版本记录

| 厂商 | 模型/快照 | 官方页面状态 | 备注 |
|---|---|---|---|
| OpenAI | `gpt-image-2`（snapshot `gpt-image-2-2026-04-21`） | 现役，images/edit 端点支持 | 计价单位：美元/每百万 token |
| Google | `gemini-3.1-flash-image`（Nano Banana 2） | stable | 计价单位：美元/每百万输出 token（官方给每张等效价） |
| ByteDance（火山方舟） | `doubao-seedream-5-0-flash-260915` | 现役候选 | 计价单位：人民币/张 |
| ByteDance（火山方舟） | `doubao-seedream-5-0-pro-260628` | 现役候选 | 计价单位：人民币/张，按像素分档 |
| ByteDance（火山方舟） | `doubao-seedream-3-0-t2i-250415` | **已下线（2026-05-11 EOS）** | **排除候选** |
| ByteDance（火山方舟） | `doubao-seededit-3-0-i2i-250628` | **已下线（2026-03-31 EOS）** | **排除候选** |

## P2-B1/B2 逐模型能力边界与计价

### OpenAI `gpt-image-2`

- edits 端点支持多输入图，**最多 16 张输入图**（覆盖本项目最多 7 张参考的需求数量）。
- 输出支持**横版自定义尺寸**，格式 PNG/JPEG/WebP。
- 计价（官方页，美元）：输出图片 $30/1M tokens、输入图 $8/1M tokens、文本 $5/1M tokens。按张换算需依赖分辨率与 token 计算规则，本轮未核算。
- Batch 端点官方标注支持，但**文档未明确此模型的批量图像端点可用性**；Batch 约 24 小时可取消，**不能满足 60 秒在线请求取消证明**。在线 images 端点的请求级取消行为官方文档未见明确说明。
- 官方文档不证明：婚礼多图保真、在线时延、失败请求计费规则。

来源（查阅日期均为 2026-11-08）：

- <https://developers.openai.com/api/docs/models/gpt-image-2>
- <https://developers.openai.com/api/docs/guides/image-generation>
- <https://developers.openai.com/api/docs/api-reference/images>
- <https://developers.openai.com/api/docs/pricing>
- <https://developers.openai.com/api/docs/guides/batch>

### Google `gemini-3.1-flash-image`（Nano Banana 2）

- 官方页面标注 stable；支持**最多 14 张参考图，其中人物图最多 4 张、对象图最多 10 张**，多轮编辑。
- 本项目每请求最多 3 张人物图（合照＋左右肖像），按官方字面限制初判不超上限；但**人物/对象如何分类、多人合照是否按多人物计数，官方文档未明确，未经实测**，不能据此判定可用。
- 支持**横版比例**与 0.5K/1K/2K/4K 分辨率；输出 PNG/JPEG（Base64）。
- 计价（官方页，美元）：输出图片 $60/1M tokens，官方给每张等效价 $0.045（0.5K）/ $0.067（1K）/ $0.101（2K）/ $0.151（4K）。**输入图价格未在本轮官方页面取得**，是 P2-B5 核算缺口。
- Batch API 官方标注 supported，24–48 小时可取消，**非 60 秒在线取消**。在线 generateContent 的请求级取消行为文档未见明确说明。
- 官方文档不证明：婚礼多图保真、在线时延、失败请求计费规则。

来源（查阅日期均为 2026-11-08）：

- <https://ai.google.dev/gemini-api/docs/image-generation>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image>
- <https://ai.google.dev/gemini-api/docs/pricing>
- <https://ai.google.dev/gemini-api/docs/batch-api>

### ByteDance（火山方舟）Seedream

- **`doubao-seedream-3-0-t2i-250415` 已于 2026-05-11 EOS（停止服务）；`doubao-seededit-3-0-i2i-250628` 已于 2026-03-31 EOS，二者分别按官方下线公告列为排除候选**，均不参与后续排序。
- 现役候选：`doubao-seedream-5-0-flash-260915`、`doubao-seedream-5-0-pro-260628`；支持图生图/多图融合，**最多 10 张参考图**（覆盖最多 7 张的需求数量）；横版可调 size；输出 png/jpeg。
- 计价（官方页，人民币/张）：Flash 输出 0.12 元/张、输入图免费；Pro 输出 ≤2.61MP 0.30 元/张、超过 2.61MP 0.60 元/张，输入图首张免费、第 2 张起 0.02 元/张。官方说明因审核等原因未成功输出的图片不计费；其他失败/超时路径是否计费仍需核实。
- 官方图片 API 文档**未见请求级取消或异步任务机制**，无 60 秒取消证据。
- 官方文档不证明：婚礼多图保真、在线时延、失败请求计费规则。

来源（查阅日期均为 2026-11-08）：

- <https://docs.volcengine.com/docs/ark/model-deprecation-notice>
- <https://docs.volcengine.com/docs/ark/image-generation-tutorial>
- <https://docs.volcengine.com/docs/ark/model-pricing>

## P2-B2 七图参考能力对照（官方字面值，未实测）

每请求参考图：合照（必填）、婚纱、男装、男鞋特写（必填），可选左右肖像与场地，最多 7 张。

| 模型 | 参考图上限 | 官方细分限制 | 横版输出 | 输出 MIME | 取消证据 |
|---|---|---|---|---|---|
| gpt-image-2 | 16（edits 输入图） | 文档未列细分 | 支持（自定义尺寸） | PNG/JPEG/WebP | 仅 Batch 约限 24h；在线取消未见说明 |
| gemini-3.1-flash-image | 14 | 人物图 ≤4、对象图 ≤10 | 支持（比例） | PNG/JPEG | Batch 24–48h；在线取消未见说明 |
| seedream 5.0（flash/pro） | 10 | 文档未列细分 | 支持（可调 size） | PNG/JPEG | 官方图片 API 文档未见取消/异步任务 |

对照结论：按官方字面数量，三家现役候选都不因参考图数量不足被排除；但数量上限不证明多图在婚礼场景下的角色保真与稳定性。

## P2-B3 排除记录

- **已排除**：`doubao-seedream-3-0-t2i-250415`（2026-05-11 EOS）与 `doubao-seededit-3-0-i2i-250628`（2026-03-31 EOS），依据官方下线公告。
- 本轮未排除任何现役模型：官方文档显示三者的参考图数量均不少于 7 张。排除现役模型或确定首测模型需要 P2-B5 费用核算与真实调用验证，本轮不做。

## P2-B4 排序依据现状：不定案

P2-B4 要求"按完整能力、可核算价格、时延证据排序"。当前：

- **能力**：三家官方字面能力覆盖参考图数量、横版、输出格式需求，但均无婚礼多图保真与时延证据，"时延证据"维度为空。
- **价格**：计价单位不同（token vs 按张），OpenAI/Gemini 需按分辨率与 token 规则换算并叠加汇率；输入图计费未完整取得。**"可核算价格"维度不成立**。
- 结论：**不产生排序，不指定首测模型**；任何现役模型都不因本记录获得已批准地位。

## P2-B5 费用上界缺口清单（100 元上限无法核算的原因）

1. OpenAI 输入图按 token 计费，单张换算取决于分辨率与官方 token 计算规则，未核算。
2. Gemini 输入图价格未在本轮官方页面取得。
3. Seedream 5.0 Flash 输入图官方标为免费；Pro 为首张免费、第 2 张起 0.02 元/张。具体计费口径已记录，但请求组合/接口实际账单仍需核实。
4. 美元→人民币汇率及取价日期未确定。
5. 失败计费规则只有部分证据：火山方舟说明因审核等原因未成功输出不计费；OpenAI、Google 的失败/超时计费和火山其他失败路径仍未核实。
6. 在线端点真实时延未知，无法估算重试放大成本。

以上任一项未补齐前，P2-B5 不能通过，Phase 3 不能进入。本记录与 P2-A2 校验器（`scripts/verify-wedding-assets.mjs`）均不代替素材授权、真实效果或费用验收。
