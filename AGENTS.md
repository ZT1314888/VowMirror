# AGENTS.md · VowMirror 协作规范

默认用中文沟通。明确实施指令直接完成授权范围；讨论性问题先核查、说明和给出判断，不自动修改。阶段通过必须有本轮证据，记录阻塞不得当作验收通过。

## 范围与隐私

- 当前项目为内部单实例婚礼工具，Phase 1 仅开发入口和健康检查。没有旧单人兼容入口、图库、浏览器模型配置、历史、ComfyUI 或素材后台。
- 未经单独指令，不实施后续 Phase、不付费调用模型、不提交／推送 Git、不公开部署。
- 真实 Key、Token、密码、私钥绝不进入 Git 或暂存区。唯一环境模板为根 `.env.example`，凭据字段必须为空；真实 `.env`、`config.yaml`、私有照片和本地备份必须被 Git 与 Docker 构建上下文忽略。
- 镜像只复制 `backend/manifest/config/config.example.yaml`。启动显式读取这一个模板，固定监听 `:8000`；不再搜索或回退到真实本地配置。模型 Key 只从 Docker 运行时环境注入，浏览器未来仅配置后端访问 Token。
- 不将真实姓名、私人邮箱、电话、私人 IP、个人绝对路径写入代码、文档、提交或 PR。保留 LICENSE 原有版权声明。
- 人物照片和生成结果不得在应用服务器持久化或写日志。未来仅当次预览下载，刷新不恢复照片／结果。
- 外部输入必须在边界校验。客户端不能指定模型出口或素材路径；远程模型使用 HTTPS，敏感请求拒绝重定向，素材必须来自固定清单。未闭合的保留协议不得接入业务路由。

## 实现与验证

先定位根因与不变量，结构性问题收敛到唯一实现，删除过期逻辑／兼容分支；不叠加绕过、静默回退、假成功或吞错。依赖通过参数／接口注入，业务不依赖隐式全局服务。保持小函数、浅嵌套、明确错误，禁止无消费者的占位目录。

所有 Go 依赖、格式化、测试、vet、构建均在 Docker 执行，不安装宿主机 Go 或 GoFrame CLI。根 `compose.yaml` 是运行、检查和 CI 的唯一入口，工具 profile 不随应用启动。

```sh
docker compose build tools-go tools-node tools-browser web backend
docker compose run --rm -T tools-go
docker compose run --rm -T tools-node
docker compose up -d web backend
docker compose run --rm -T tools-browser node tests/smoke.mjs --stage foundation
git diff --check
```

后端测试整条命令必须设置不超过 60 秒的外层硬期限，不能只使用按包的 Go `-timeout`。统一脚本使用 `timeout -s TERM -k 2s 58s go test -count=1 -timeout=55s ./...`；依赖和编译准备放在测试计时前。

验证顺序：定向行为测试 → 格式／lint／vet → 受影响构建 → 最小真实浏览器烟测。自有非人物 PNG/JPEG/WebP 夹具缺失必须失败；模拟不证明真实模型效果、速度或费用。Chrome MCP 验证必须实际调用浏览器工具，启动服务不算证据。

非平凡任务先列根因、文件、局部或结构性判断、方案和验证；独立只读调查可并行，代码编辑由主代理统一处理。删除前解析绝对目标并确认位于仓库内，保护既有修改与草稿。

## 提交前审查

只有获得提交指令才执行 commit。提交前检查 `git status` 和逐行 `git diff --cached`：无临时文件、日志、产物、真实配置、凭据或私人信息；扫描修改文件中的高危模式 `(sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9]{20,})`；全量 Docker Go 测试与 vet 必须通过。

最终 diff 检查症状补丁、重复逻辑、隐式回退、吞错、第二数据源、死代码、未说明行为、无效测试及安全回归。已有草稿先备份并记录整合去向，不丢弃用户内容。

提交使用 Conventional Commits：`fix:`、`feat:`、`docs:`、`test:`、`refactor:`、`chore:`。主分支为 `main`；开发分支从 main 建立，格式 `<type>/<kebab-case-topic>`。
