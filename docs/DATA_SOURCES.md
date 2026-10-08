# 题目来源与许可说明

采集来源及固定提交写在 [sources.json](../sources.json)。题目记录中的 `occurrences` 保留来源链接、试卷信息与原始文件位置；字段定义见 [question.schema.json](../schema/question.schema.json)。题目答案和解析沿用上游，未经逐题人工复核；发现题面与答案冲突时通过质量标记排除可识别的不一致题目。

| 来源 | 采集范围 | 上游仓库许可 |
| --- | --- | --- |
| [mpbfx/gongkao](https://github.com/mpbfx/gongkao) | 历年行测试卷快照 | [AGPL-3.0 原文](../data/raw/gongkao-LICENSE) |
| [fei98/civil-service-exam-prep](https://github.com/fei98/civil-service-exam-prep) | 自建模拟题，排除 AI 生成题和重复真题精选 | [MIT 原文](../data/raw/fei-LICENSE.txt) |

上述许可属于各自上游项目，不代表第三方题面、解析和图片统一获得再分发授权，也不构成本应用代码的许可证。本仓库目前尚未为应用代码指定开源许可证。

仓库和 Release 保留采集工具、来源定义与归属说明，不附带下载的题库、图片或使用者的学习记录。部署者自行准备有权使用的题库资源并发布到自己的 SeaweedFS。CI 使用项目内生成的合成题目，不依赖任何题库站点。
