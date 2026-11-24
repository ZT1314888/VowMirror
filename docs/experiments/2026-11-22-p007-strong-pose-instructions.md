# P007 预设姿势与专用强指令验证方案

历史实验归档，来源为 `test/pose-reference-upstream-validation` 与 `test/p007-strong-pose-instructions` 工作树。
以下状态、结果与计划保留归档时的原文含义；实验代码未合入产品，本文不代表新的实施或付费调用授权。
代码路径均指实验工作树中的文件；图片和完整原始证据继续保存在 Git 忽略目录。

当前状态：仅提出方案，未实施、未发起模型请求。建议真实调用总预算为九次，仍须获得明确授权。
本次只验证 P007，不扩展其他姿势、30 条模板库或正式界面，不提交、推送或部署。

## 目标与现有证据

判断：使用同一张 P007 线稿时，显式绑定姿势规格及肢体结构的文字指令，是否改善动作、支撑和腿脚质量。

[上一组对照](2026-11-22-p007-result-diagnostics.md)使用相同提示词，五图文字组与六图 P007 组均完成托抱。
六图组有明确第三足端；五图组裙摆遮挡腿脚，不能据此判断完整肢体结构正确。
该组只检验公共文字下的加图效果，没有比较公共文字和新的专用强指令。
[此前六图试验](2026-11-22-p007-prompt-retry.md)使用过明确以线稿为动作依据的文字，单张结果符合主动作及方向。
这些结果作为历史证据保留，不加入新试验的次数或成功率分母。

目前接口传入图片与文字，没有提交骨架坐标或关节约束参数。
更明确的文字仍需模型遵循，不能预先承诺消除多肢或变形。

## 三组设计与不变量

| 组别 | 图片输入 | 提示词 | 用途 |
| --- | --- | --- | --- |
| A：文字基线 | 合照、婚纱、男装、鞋履、上传场地，共五图 | 现有 P007 公共文字，保持原文 | 基线 |
| B：公共文字加图 | A 的五图加 P007，共六图 | 与 A 逐字相同 | 复核增加线稿的影响 |
| C：专用强指令加图 | 与 B 完全相同的六图 | 相同基础文字及 P007 主动作，替换姿势指导并追加结构约束 | 检验专用强指令包 |

主要比较 B/C，回答同一组图片下强化指令是否改善效果。
A/C 比较两套实际使用方案的整体效果，A/B 复核公共文字下的加图影响。
C 包含姿势绑定、肢体数量和连接关系等一组改动，不能将结果归因于其中某一句话。

全场固定当前合照、W001、上传场地和 P007；不得换照片、重编码、换套装、调整场景或图片顺序。
前五图的原始字节、MIME 和顺序在 A/B/C 间一致，B/C 第六图也一致。
请求配置保持 `gpt-image-2.5-flare`、单张 `1536×1024` PNG、`medium`，后端期限 85 秒、脚本期限 95 秒。
A/B 公共提示词 SHA-256 保持 `29b1a915c20737d7423abb9d2bc0eeae36ab517bc0b27997258492babc0bfda3`。
保留现有所有模型结果接受／拒绝条件、诊断原因码及用户错误文案。
没有已验证的共同随机种子，不能把小样本差异视为确定因果关系。

## C 组提示词改法

基础身份、服装、场地和 P007 主动作沿用共享构造，删除 C 组的条件式线稿指导句，替换为专用姿势段。
参考图序号由实际引用列表计算，不将第六张硬编码成通用规则。
本次固定上传场地，所以 P007 为第六图。

候选新增／替换段如下；这是待验证内容，不是已经成功实测的提示词：

```text
Use reference {pose_reference_index} as the required specification for the two-person pose. Match its relative body arrangement, joint connections, limb bend directions, and supporting contact relationships. Adapt the overall scale and placement to the landscape scene while preserving natural body proportions.

The standing menswear wearer supports the wedding-dress wearer with one arm at the back and the other beneath both knees. Follow the line drawing's contact relationships. The carried person's head remains on the right, with both bent legs extending toward the left.

There are exactly two people. Each person has exactly two arms, two hands, two legs, and two feet. Preserve exactly two coherent hip–knee–ankle–foot chains for the carried person, including where fabric covers them. Do not create disconnected or duplicated limbs, a third foot, or an additional shoe beneath the skirt. Never duplicate a foot or shoe to satisfy a visibility or framing requirement.

The carried person's footwear forms one consistent matching pair, attached to their two feet. Reference 4 specifies the menswear wearer's shoe details. Let the wedding dress drape naturally around the two actual leg forms without creating an extra limb.

Use the pose reference only for pose and contact relationships. Preserve identities and appearance from reference 1, garments and specified footwear from references 2–4, and the venue from reference 5. Do not copy the line drawing's identities, clothing, footwear, or background.
```

这段强调线稿中的角色、方向、托背托膝、关节连接及双足数量。
它不指定新的女鞋图片、鞋色或款式，不增加第七张输入，也不要求复制线稿中的赤脚。
完整提示词仍需检查内部一致性，避免重复或互相冲突的指令；不得通过隐藏腿脚来宣称结构修复成功。

## 实现范围

收到实施指令后，先检查并备份现有改动和历史证据，继续使用已存在的实验工作树。
Phase 8 主工作区保持原状，不使用 stash，不覆盖既有草稿。

| 文件 | 拟改动 |
| --- | --- |
| couple.go（实验工作树 `backend/internal/logic/tryon/couple.go`） | 在唯一提示词构造中增加 P007 专用 profile，共享基础文字和主动作，集中定义新增结构约束 |
| 服务配置（实验工作树 `backend/internal/cmd/couple.go`） | 接受受控的 `p007-strong` 实验模式，限定 W001、上传场地及必须提供 P007；未知模式明确失败 |
| 实验脚本（实验工作树 `scripts/pose-evaluation.mjs`） | 增加三组日程及九次全局上限，按固定组别选择本机实例，复用同一请求构造和结果记录实现 |
| 传输测试（实验工作树 `backend/internal/logic/tryon/protocol_test.go`） | 实际核验 A/B/C 的图片、参数、完整提示词和源文件摘要 |
| 脚本测试（实验工作树 `tests/pose-evaluation.test.mjs`） | 核验日程、令牌、次数、失败记录、停止规则和诊断传播 |
| `.env.example` | 仅补充实验模式说明，凭据字段仍为空 |

root `compose.yaml` 继续作为唯一容器入口，使用同一份代码和构建产物启动两个独立实验项目。
A/B 实例采用现有 `p007-ablation` profile；C 实例采用 `p007-strong` profile。
两个实例的模型配置及输出参数一致，各有独立用量卷，端口仅绑定本机并在启动前检查冲突。
运行过程中不切换 profile、不重建镜像、不修改代码、提示词或参数。
浏览器及业务请求体不开放任意提示词、profile、模型配置或素材路径。

## 调用预算与日程

建议三个重复区组，每个区组各执行 A、B、C 一次，共九次全新请求。
不是先执行九次再自动扩大样本；失败和超时也消耗一次预算，不补跑。

从两套位置平衡顺序中随机选一套，再随机区组顺序，执行前保存锁定日程：

| 方案 | 区组 1 | 区组 2 | 区组 3 |
| --- | --- | --- | --- |
| 正向 | A → B → C | B → C → A | C → A → B |
| 反向 | A → C → B | C → B → A | B → A → C |

每组在三个执行位置各出现一次；该设计未完整消除前序调用及时间变化的影响。
全场串行执行，不并发调用模型。

- 九枚新临时令牌，各自每日模型尝试上限为一次，脚本另设已使用令牌集合及九次全局硬上限。
- 六枚令牌仅授权 A/B 实例，三枚仅授权 C 实例；两套令牌清单必须互斥。
- 每次请求先计入脚本次数；失败或超时先记录，再继续下一项预定日程，不重试该项。
- 供应商鉴权或限流阻塞时，记录当前结果并停止两个实例的全部后续调用。
- 付费前启动、健康、配置、输入或摘要检查失败，必须停止，不能通过实际调用试探配置。

当前方案不授权上述调用。获得包含预算与停止规则的明确真实调用指令后才执行。
实施代码的指令本身不代表已授权付费调用、提交或推送。

## 无付费验证

按定向行为测试、格式／静态检查、全量测试与构建、浏览器烟测的顺序执行。
所有 Go 操作在 Docker 中完成，执行前确认引擎可用；编译准备在测试计时前完成。
Go 测试使用不超过 60 秒的外层硬期限，沿用 58 秒外层、55 秒包内期限。

1. 检查 A/B 提示词逐字一致，C 仅有预定的姿势指令差异；C 缺少 P007 时明确拒绝。
2. 受控 TLS 核验原始输入字节、MIME、顺序和模型输出参数，确认 B/C 使用同一张 P007。
3. 核验三组完整提示词及覆盖构造、配置、传输、SSE 和脚本的源文件摘要，拒绝过期证据。
4. 核验九次硬上限、九枚令牌互斥绑定、非法日程零请求、普通失败继续及鉴权限流停止。
5. 核验受控原因从适配器经 SSE 到 JSONL，缺失或未分类诊断不记为通过，禁止写入敏感数据。
6. 运行 Docker 全量 Go 测试、格式、`vet`、Node 检查及应用构建。
7. 离线 Chromium 回放真实处理器的受控错误 SSE，确认普通界面仍显示原错误文案，并实际调用 MCP 浏览器。

测试环境使用空模型配置及受控响应，不计为真实模型效果验证。
完成上述检查后锁定代码、提示词、图片摘要、日程及实例配置，才能进入已授权的真实调用。

## 视觉验收与选择规则

先将输出匿名编号并打乱顺序，主代理与只读复核分别目检，再揭示组别并比较。
两次目检结论不同且无法凭可见证据解决时，保留争议，不强行记为通过。

| 维度 | 通过要求 |
| --- | --- |
| 动作 | 一人站立托抱，另一人双腿离地，主要关系符合 P007 |
| 方向 | 被抱者头右、弯腿向左 |
| 接触 | 背侧与膝下支撑合理，无明显悬空、穿透或错误抓握 |
| 肢体 | 关键腿脚结构可判定，未见额外、断裂、脱离或重复的肢体及足端 |
| 人物外观 | 可见五官、发型等整体接近当前合照，没有明显混合或替换外观 |
| 服装鞋履 | 主要服装对应 W001，男鞋对应参考，女鞋为一致的一双，衣物随动作自然变形 |
| 构图场地 | 人物完整入框，主要场地元素保留，没有通过裁切隐藏关键异常 |

每项记录通过、不通过或不可判定。遮挡导致无法核验的腿脚及接触必须记为不可判定，不算通过。
严格可用图必须有效交付、主要动作及方向通过、关键肢体和接触可判定且通过，并无其他明显质量退化。
各组严格可用率均以计划中的全部三次为分母；接口成功率、不可判定数及完整 B/C 配对数另报。
如果提前停止，未执行数量及停止原因单列，不能解释为已发送的模型失败。

预设探索性选择门槛：三个区组均完成且三个 B/C 配对都可比较，
C 至少两张严格可用、比 B 至少多一张，C 所有已交付图均无关键额外肢体异常，
且人物外观和服装没有明显退化，才将 C 记为本样本支持进一步评测的候选。
该门槛不构成稳定成功率、通用姿势控制或生产验收通过的证明。

如果 A 的严格可用数量达到或高于 C，文字基线继续作为主方案，C 仅保留为后续实验候选。
只有 C 也比 A 至少多一张严格可用图，并满足上述质量条件，才记录为本样本支持带图强指令组合的探索信号。
无论结果如何，都不自动修改正式流程或启动下一轮付费验证。

未达到门槛、遮挡较多、各组相近或配对不完整时，报告结论不足，保留文字基线及实验分支。
不能把某一张最好看的图当作获胜依据，也不能因 C 更遮腿而认定修复了变形。
两实例连接池不同且没有共同随机种子，耗时只作描述记录，不据此解释强指令的速度收益。
实际费用未提供时明确记为未知，不根据图片数量或耗时估计计费。

## 交付与清理

交付匿名报告、九项日程及执行记录、三组完整提示词与摘要、私有成片和盲评对照图。
请求记录包含区组、组别、状态、耗时、受控诊断及摘要，不保存响应体、照片、Base64、凭据或地址。
成片及完整本机证据仅保存在 Git 忽略目录，应用服务器不持久化照片或结果。

保留已有工作区改动、全部历史报告及结果，不用新摘要覆盖实际调用时的历史证据。
完成后清理并核验两个真实请求项目及验证项目的临时容器、网络和专属用量卷，保留共享缓存和本机证据。
检查本轮修改的 Markdown、既有本地链接、差异及凭据模式；暂存区保持为空。
真实调用、提交、推送和上线均不会因本方案的存在而自动执行。
