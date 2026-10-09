# 题库导入标准与接口

对外导入格式是 **UTF-8 JSON，`schemaVersion: "1.0"`**。它比内部 JSONL 简短：输入题干、选项、正确答案、解析和图片相对路径，工具会生成完整内部记录、图片标签、内容摘要和版本清单。

- [JSON Schema](../schema/question-import.schema.json)：机器可读的输入约束。
- [完整范例](../examples/question-bank/questions.json)：一题纯文字、一题图形推理、一题带材料图的资料分析。
- [示例图片](../examples/question-bank/images/)：自编测试素材，和 JSON 一起保存在仓库中。
- [HTTP OpenAPI](../schema/question-import.openapi.json)：接口定义。
- [内部记录 Schema](../schema/question.schema.json)：打包后的 `questions.jsonl` 格式。

## 最小示例

```json
{
  "schemaVersion": "1.0",
  "bankId": "my-practice",
  "questions": [
    {
      "id": "arithmetic-001",
      "module": "数量关系",
      "stem": "一本练习册 12 元，两本共多少元？",
      "options": {"A": "12 元", "B": "18 元", "C": "20 元", "D": "24 元"},
      "answer": "D",
      "analysis": "12 × 2 = 24 元，因此选 D。"
    }
  ]
}
```

`bankId` 是题库命名空间，`id` 是该命名空间内稳定的题目编号。工具使用两者生成内部 `xc_…` ID。不要把导入日期或随机数用作同一道题每次变化的 ID。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 固定 `"1.0"` |
| `bankId` | 是 | 1—64 位字母、数字、下划线、短横线，以字母或数字开头 |
| `questions` | 是 | 1—20000 道题的数组；一次导入文件最多 64 MiB |
| `questions[].id` | 是 | 1—128 位字母、数字、点、下划线、短横线；同一文件内不重复 |
| `module` | 是 | 政治理论、常识判断、言语理解、数量关系、判断推理、资料分析之一 |
| `submodule` | 否 | 例如“数学运算”“图形推理” |
| `stem` | 是 | 题干，非空纯文本 |
| `material` | 否 | 共用材料；同一材料的多题分别填写材料内容和图片引用 |
| `options` | 是 | 从 A 连续排列的 2—6 个选项，例如 `{"A":"…","B":"…"}` |
| `answer` | 是 | 一个选项字母，必须存在于 `options`；当前导入只支持单选题 |
| `analysis` | 是 | 非空解析文本；答案和解析由提供者负责校对 |
| `images` | 否 | 图片引用数组，见下节 |
| `source.type` | 否 | `真题` 或 `模拟题`，默认 `模拟题` |
| `source.title` | 否 | 原试卷或资料名称 |
| `source.url` | 否 | 不含凭证的 HTTP(S) 来源链接；仅作来源记录，不会抓取此 URL |
| `source.year` | 否 | 年份整数或 `null` |
| `source.province` | 否 | 地区文字 |
| `tags` | 否 | 自定义标签；`has_image` 由工具按实际图片自动维护 |
| `knowledgePoints` | 否 | 知识点文字数组 |

所有正文按纯文本处理，换行保留，HTML 会转义。需要公式时可使用文本表达式，或把公式图片放入对应位置。这里的标准 JSON 与内部 JSONL 是两层格式，不要把它们直接互换。

## 图片

```text
my-bank/
  questions.json
  images/
    diagram.png
    option-a.jpg
```

在题目中写：

```json
"images": [
  {"path": "images/diagram.png", "role": "stem"},
  {"path": "images/option-a.jpg", "role": "option_A", "kind": "image"}
]
```

`path` 相对输入 JSON 所在目录。禁止绝对路径、网址、Base64、`..`、反斜杠和指向目录外的符号链接。图片支持 PNG、JPEG、WebP、GIF、BMP；每张最多 16 MiB、4000 万像素、任一边长最多 16000。会检查文件格式、扩展名、尺寸和摘要；图片解码显示效果仍可通过本地预览确认。

`role` 可为 `stem`、`material`、`analysis`、`option_A` 至 `option_F`。选项图片须对应实际存在的选项；纯图片选项的文本可以是空字符串。`kind` 默认为 `image`，公式图片可用 `formula`。同一字段的图片按数组顺序放在文本后面。

打包后，JSONL 只保存 `assets/images/<摘要前两位>/<完整 SHA-256>.<扩展名>` 相对路径。图片文件单独放在同一资源包，再上传到 SeaweedFS，不会把图片转成 Base64 写进题库文件。相同图片在一个版本中仅保存一份。

## 命令行：校验、打包和增量合并

```bash
npm ci
npm run questions:import -- --input=examples/question-bank/questions.json --check
npm run questions:import -- --input=examples/question-bank/questions.json \
  --output=artifacts/example-bank-v1
```

资源包包括 `questions.jsonl`、`assets/images/…`、`manifest.json`。输出目录必须不存在，避免覆盖已有资源。

已有正式题库时，**使用当前完整资源包作为 `--base`**：

```bash
npm run questions:import -- --input=my-bank/questions.json \
  --base=artifacts/current-bank --output=artifacts/next-bank
```

合并保留原题记录和 ID。重复导入相同内容会复用；同一 ID 内容不同会报错，需要给修订题一个新 ID。这样原试卷、错题本和笔记仍然对应原来的题目。新增试卷使用更新后的题库；正在做的试卷题目顺序和答案不变。

`--check` 不写资源包，会校验结构、图片文件和合并冲突。发生错误时退出码为 1，输出带 `issues[].path` 的 JSON。它不会连接数据库、S3 或模型。

## 启用管理 API

命令行导入使用以下三个**独立的管理员变量**；网页管理面板也可用超级管理员 JWT 调用同一套接口：

```dotenv
QUESTION_IMPORT_TOKEN=
QUESTION_IMPORT_S3_ACCESS_KEY_ID=
QUESTION_IMPORT_S3_SECRET_ACCESS_KEY=
```

令牌至少 32 字节，不能复用考生口令、超级管理员口令或 JWT 签名密钥。可以用 `openssl rand -hex 32` 生成并保存到受保护的本地配置。后两个变量使用资源 bucket 的 Read/Write 发布凭证；`stack:prepare` 生成的 `deploy/local/seaweedfs-publisher.json` 已包含这种身份。日常读取仍使用原来的只读 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`。

把这些变量添加到 `.env.stack`；Kubernetes 渲染器会把它们放入后端 Secret。`QUESTION_IMPORT_TOKEN` 和 `SUPERADMIN_PASSWORD` 都未配置时接口返回 404；只启用登录身份时可以获取 Schema 和校验 JSON，上传需要发布凭证，在线启用需要 PostgreSQL + Redis + SeaweedFS。

管理令牌仅供维护者使用。不要发给备考用户、存入浏览器 localStorage 或写到 `VITE_*`。考生 JWT 与游客身份均不能导入题库。

## 上传后直接在线生效

把令牌放入权限 0600 的本地纯文本文件，或设置 `QUESTION_IMPORT_TOKEN` 环境变量：

```bash
npm run questions:publish -- --source=artifacts/next-bank \
  --url=https://study.example.com --token-file=deploy/local/import-token
```

工具最多并行上传两个文件，所有文件写入和核验完成后才发布 manifest，并原子更新 PostgreSQL 中的当前版本。成功响应示例：

```json
{
  "published": true,
  "active": true,
  "restartRequired": false,
  "version": "完整的64位版本摘要",
  "questions": 100,
  "usableQuestions": 100,
  "images": 20,
  "reused": false
}
```

**不需要重启后端或修改 `.env.stack` 的版本号。** 数据库版本指针优先于环境中的初始版本；重启不会退回旧题库。每个后端在事务内核对指针，竞态时重试；缓存键含版本和数据修订号。学习中心会自动更新模块题量，组卷页面会重新统计可用题数。

导入只能增加题目或复用完全相同的原题。若有人基于过期题库同时发布，后提交的版本缺少已新增题目时会返回 409，应拉取最新完整资源包重新合并。旧资源版本不自动删除，供历史核对和备份使用。

上传失败可重跑同一命令，完全相同的对象会复用；不同内容绝不覆盖。缺文件、摘要不符、图片引用不一致时不会启用。manifest 已发布但数据库切换失败时，GET 会显示 `published: true, active: false`；重试发布即可再次尝试启用。

HTTP 客户端只接受 HTTPS 或 loopback HTTP，也不跟随重定向，以免转发管理令牌。局域网 HTTP 站点可经 SSH/Kubernetes 本地端口转发后使用 `--url=http://127.0.0.1:3210`。

## HTTP 接口

所有接口以 `/api/admin/question-bank` 开头，并使用 `Authorization: Bearer <QUESTION_IMPORT_TOKEN>`，或由网页发送超级管理员 JWT。不接受 URL 查询参数中的令牌；考生 JWT 不可使用。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /schema` | 无 | 标准导入 JSON Schema |
| `POST /validate` | `application/json`，标准导入 JSON | 结构校验和模块统计；`imageFilesChecked: false`，不读取客户端本地文件 |
| `PUT /releases/{version}/files?path=…` | `application/octet-stream`，单个原始文件 | 201 新文件，200 相同文件复用，返回大小与 SHA-256 |
| `POST /releases/{version}/publish` | `application/json`，完整 `manifest.json` | 校验、发布并在线启用；201 新发布，200 重复发布 |
| `GET /releases/{version}` | 无 | 是否已发布、是否当前生效、题目和图片数；不返回答案库 |

示例校验：

```bash
curl --fail-with-body https://study.example.com/api/admin/question-bank/validate \
  -H "Authorization: Bearer $QUESTION_IMPORT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/question-bank/questions.json
```

上传接口中的 `version` 来自 `manifest.version`，`path` 必须为 `questions.jsonl` 或内容摘要命名的图片路径。请使用打包工具生成 manifest，不要自己猜版本号。版本摘要为 manifest 的 `files` 数组按原有顺序经 JavaScript `JSON.stringify` 后的 UTF-8 字节 SHA-256；每个文件的内容摘要和字节数都会再次验证。

限制：JSONL 最多 128 MiB、50000 条内部记录；manifest 最多 4 MiB；资源包最多 20000 个文件、总共 512 MiB。大请求只对鉴权后的导入路径开放，普通学习 API 仍保持 24 KiB 限制。校验在工作线程中执行，文件核验使用有限并发，不占用数据库事务等待网络上传。

常见状态码：400 请求格式错误；401 管理令牌无效；404 接口关闭或版本尚未发布；409 与当前题库冲突；413 请求过大；415 文件上传媒体类型错误；422 题目或图片校验失败；429 并发或频率限制；503 存储、数据库、配置或校验服务暂不可用。

```json
{"error":{"code":"invalid_question_import","message":"题库校验未通过，请根据 issues 修正后重试。","issues":[{"path":"/questions/0/answer","message":"答案不在选项中。"}]}}
```

生产导入只使用你有权使用的题目。仓库中的自编范例用于演示和测试，不应替代正式题库。
