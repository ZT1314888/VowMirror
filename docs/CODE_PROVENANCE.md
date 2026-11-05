# 继承代码与素材边界

VowMirror 的继承代码来自项目早期的自主开发成果；根 [LICENSE](../LICENSE) 为 MIT 文本，版权人为 VowMirror contributors。

继承代码包括 GoFrame 启动与中间件、安全组件、图片校验、OpenAI 兼容／豆包／Gemini 图像协议、前端 MIME 与结果解析思路。GoFrame 与 Go 模块依赖仍由 [go.mod](../backend/go.mod) 和 go.sum 记录版本；依赖自身许可证不被项目许可证替代。

旧服装数据、完整图、缩略图、演示和历史图片已从工作树移除。旧文档同时存在“素材全量 MIT 开源”和“禁止打包再分发”的矛盾陈述，不能作为第三方素材再分发证据。

新婚礼 W001–W030、人物、场地素材尚未接入；每项必须另行确认真实文件、来源及许可，不能沿用旧图片授权声明。私人验证照片只放忽略目录或运行时挂载，不进入公开 Git。

[三格式测试夹具](../backend/internal/imagevalidate/testdata/README.md) 为本项目生成的非人物棋盘格，不是婚礼素材或真实生成成果。旧文档及用户草稿在修改前已逐字节备份到忽略的本地基线目录，修订去向和摘要见 [长期计划](plan/2026-11-05-wedding-project-roadmap.md)。
