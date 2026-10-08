# 状态与接口设计

## 服务边界

浏览器只访问前端同源路径。Nginx 提供 React 构建产物，将 `/api/` 和 `/assets/images/` 转发到任意后端。后端镜像没有前端构建产物、题目文件、图片、运行记录或配置密钥，也不挂载应用数据卷。

PostgreSQL 是答题、笔记、档案和模型任务的唯一持久状态来源。每次 API 操作创建短生命周期的领域对象，从数据库读取最新状态，在短事务中校验和提交，再释放对象。模型请求和 SSE 连接不占用数据库事务。当前针对一个考生账户，事务级 advisory lock 串行化状态变更；可以运行多个后端实例，但没有将它定位为大型多租户服务。

Redis 保存全局限流计数、跨实例变更通知和带 TTL 的陪练流式文本。Pub/Sub 不保证离线补发，因此通知只负责触发读取，SSE 连接同时定期从 PostgreSQL 获取最新安全快照；重连也从快照恢复。无需粘性会话，不依赖实例内的业务缓存。

SeaweedFS 以私有 S3 bucket 保存 `question-resources/<version>/` 下的题库、题图和清单。后端启动时验证清单版本与题库 SHA-256；图片读取时验证长度和 SHA-256。内存中仅缓存只读题库和有限大小的题图。应用凭证不能上传，题库及标准答案没有公开下载路由。

## 答题与模型任务

创建多模态 LLM 对战时，同一事务写入题目与 queued 任务。每个后端都可作为任务执行者：在数据库事务中领取任务、记录唯一 worker 和租约，提交后才调用模型。所有副本共享模型并发额度，领取、重试与陪练预留次数均由数据库协调。

流式回调只更新当前任务允许修改的模型字段。它们会重新读取同一题的最新状态，因此不会覆盖人类在另一实例提交的答案。任务 ID 和 worker 检查隔离过期执行者；取消后到达的结果不能再次记分。模型必须提交可校验的 `submit_answer` 工具调用。

人类未提交前，安全快照隐藏模型解释、转写、选项和参考答案。人类提交后，可以看已完成的公开讲解和后续流式更新。只有双方提交都存在时，系统才读取参考答案进行判分。双方独立计时；自主练习支持暂停，结束时未揭晓的题目不进入双方正确率分母。

运行中任务定期续租。实例退出或租约到期后，任务被标记中断，保留人类答案，用户可手动重试。系统不会自动重新执行已经领取过的模型任务；这是一项保守的费用策略，不宣称外部模型请求具备 exactly-once 计费保证。尚未领取的 queued 任务仍可由另一实例执行。

已完成的公开讲解可供手动重试使用；隐藏模型续写上下文不会存入 PostgreSQL、Redis、日志或浏览器。陪练聊天只对登录考生开放，已完成消息保存在 PostgreSQL；中途刷新不会自动再次请求模型，流式临时文本一小时后过期。

## 登录与公开监督

口令由后端环境配置，JWT 由所有副本共享的签名密钥签发和校验。改变口令或 JWT 密钥会使旧登录失效。浏览器 localStorage 保持登录态，默认有效期 30 天，可配置。

游客只能读取公开档案、统计和已揭晓题目的历史记录；未完成的题目、实时作答、笔记、收藏、聊天、JWT 和模型凭证均不进入公开响应。公开监督意味着已完成练习的结果可被访客查看。

## 主要接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/login`、`GET /api/session` | 口令登录与会话恢复 |
| `GET /api/catalog` | 模块、题量与模型可用性 |
| `/api/public/dashboard`、`/api/public/history`、`/api/public/matches/:id` | 游客监督 |
| `/api/learning/dashboard`、`/api/learning/history`、`/api/learning/records/:id` | 私有学习中心 |
| `/api/learning/questions`、`PATCH /api/learning/questions/:id` | 错题、收藏、笔记和掌握标记 |
| `PATCH /api/learning/profile`、`POST /api/learning/availability` | 目标设置与组卷可用题量 |
| `POST /api/matches`、`GET /api/matches/:id` | 开始与恢复一场练习 |
| `POST /api/matches/:id/{answer,retry,next,finish,pause,resume}` | 提交、重试、切题和计时 |
| `GET /api/matches/:id/events` | 经过权限与封存规则处理的 SSE |
| `GET/POST /api/matches/:id/coach` | 交卷后的私有陪练 |
| `GET /api/health`、`GET /api/health/live` | 依赖就绪检查与进程存活检查 |

JEV 使用原生 `/systemone` Choice 接口。它的文本决策输入和可选视觉转写分别配置，模型不会收到参考答案、解析或人类选项。相关公开接口资料保存在 `docs/references/`。

## 统计刷新与缓存一致性

学习中心通过 `/api/learning/overview` 或 `/api/public/overview` 一次读取统计、历史、错题与收藏，避免四个请求跨越不同提交时刻。可见页面每三秒查询轻量版本号；有变化时更新整份快照，回到页面也会检查。旧页面请求、旧筛选结果和已离开的对战流不能覆盖当前状态。

PostgreSQL 在影响学习记录、档案或标记的同一事务内递增 `study_state.revision`。Redis 缓存键包含数据版本、题库版本、访问身份、请求参数与中国时区日期，有效期两分钟。读取版本与计算统计使用同一个 repeatable-read 快照；过期计算只能写入它自己的旧版本键。缓存 TTL 用于回收空间，不是允许旧数据滞留的时间。Redis 不可用时统计回到数据库，限流和新模型任务入口则保守失败。

模型文字增量不会反复作废学习统计缓存；单场状态和任务回写只查询对应 match，空闲 worker 不扫描答题历史。同一请求内复用作答索引，SSE 更新合并为约 150 ms 一批，慢连接超过缓冲阈值后重连获取最新快照。Redis 设置内存上限并禁止为了缓存而淘汰限流键。

一次本地性能验收使用 1,000 场、10,000 次模拟已完成作答：预设和实测总正确率均为 70%；领域层统计冷读约 375 ms，共享缓存读取中位数约 8 ms、P95 约 12 ms，读取指定一场约 9 ms且只加载一条记录。这是隔离环境的基准，不代表公网网络耗时或生产容量承诺。可用 `tests/integration/performance.mjs` 在独立空测试库复测。

缓存恢复设计参考 [Redis Pub/Sub 交付语义](https://redis.io/docs/latest/develop/pubsub/)；事务内协调参考 [PostgreSQL advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS)。
