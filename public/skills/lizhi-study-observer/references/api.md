# 游客查询接口 v1

基址：`__LIZHI_SITE_URL__`。网页版中的占位符按 SKILL.md 的站点规则解析。

全部接口匿名 GET；不发送 Authorization、Cookie 或考生口令。支持 HTTP 工具或命令行查询，不要求执行网页 JavaScript。无跨站浏览器 CORS 承诺。

## 区间统计

`GET /api/public/stats?from=2026-10-01&to=2026-10-07&module=all`

- `to` 默认站点当天；`from` 默认 `to` 前六天。起止日期均包含在内，格式 YYYY-MM-DD，起始不晚于结束、结束不晚于今天，最多 366 天。
- `module` 默认为 `all`，也可为政治理论、常识判断、言语理解、数量关系、判断推理、资料分析。其他参数会被拒绝。
- 日期按 Asia/Shanghai，根据人类提交时间归日；只统计最终已揭晓结果的正式作答。已提交但还在等 AI 的题暂不计入。重复作答重复计次数。
- 每 IP 每分钟最多 60 次。响应使用带数据修订号的服务端缓存，同一数据库快照计算；数据改变后切换缓存键。缓存最长 120 秒，`asOf` 是该快照的生成时间，不是最后一次作答时间。`dataRevision` 是不透明字符串；本地文件模式为 null。

主要字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 当前为 `1.0` |
| `timezone` / `asOf` | 站点时区 / 快照生成时间（ISO 8601） |
| `range` | 生效的 from、to、module、days、includesToday |
| `profile` | 公开昵称 nickname 与每日题量目标 dailyGoal |
| `summary` | 当前区间统计，见下表 |
| `previous` | 前一个等长日期区间、同模块 summary、正确率差 accuracyChangePoints（百分点；无样本为 null） |
| `activity[]` | 每个自然日的 date 和 summary 字段，未作答日也会出现 |
| `modules[]` | 六个模块的 name 和 summary 字段；设置模块筛选时，其他模块为零样本 |
| `duels[]` | llm、jev 两组同题人机结果，见下文 |
| `recent[]` | 当前区间最近五场，含 id、mode、区间内 summary 字段、lastAnsweredAt、相对网页链接 href |
| `lastAnsweredAt` | 当前区间最后一条公开作答的提交时间；无样本为 null |
| `scope` | revealedOnly=true、includesDemo=false、timing=parallel_complete_only、onlineStatusAvailable=false |
| `links` | 相对监督页、记录页和技能链接 |

每个 summary：`answered` 作答次数，`correct` 答对次数，`accuracy` 百分数（0—100，保留一位小数，无样本 null），`uniqueAnswered` 去重题数，`studyMs` 人类已交卷题累计用时（毫秒），`averageMs` 平均用时（毫秒、无样本 null），`sessions` 至少有一条区间内作答的练习场次数。按天或模块的去重题数、场次数不能直接相加当作总去重数、总场次数。

每组 duels：`answered` 同一批可比较对战题数，`humanCorrect` / `aiCorrect` 与各自的 `humanAccuracy` / `aiAccuracy`。`timing` 的 `compared` 是同时开始且双方计时完整的题数，`excluded` 是该组排除的题数；`humanMs` / `aiMs` 是可比较题的总用时，`humanAverageMs` / `aiAverageMs` 是对应平均值，无可比较题为 null。JEV 通常在人提交后开始，因而不进入此处同时开始的速度比较。自主练习不进入 duels。

示例命令（日期仅为示例，回答“今天”时须先确定站点日期）：

```bash
curl --fail --get '__LIZHI_SITE_URL__/api/public/stats' \
  --data-urlencode 'from=2026-10-01' --data-urlencode 'to=2026-10-07' \
  --data-urlencode 'module=数量关系'
```

## 累计概况

`GET /api/public/dashboard`

`summary` 包括 answered、correct、accuracy、uniqueAnswered、totalStudyMs、todayAnswered、todayCorrect、todayAccuracy、weekAnswered（本周一至今天）、streak、goalProgress、daysToExam。`activity` 是最近 28 个自然日，`modules` 是累计模块统计；`recent` 是最近有公开结果的场次，`updatedAt` 是最近公开场次的结果更新时间。不要将此接口的累计指标误当成区间指标。

## 场次与题目

`GET /api/public/history?page=1&pageSize=10` 返回 items、total、page、pageSize、pages。page 从 1 开始，pageSize 最大 100。记录按最近公开结果时间排序；不需要详情时不要逐场抓取。

`GET /api/public/matches/{id}` 返回该场已揭晓的 history、scores、settings 等。`originalStatus` 才是原场次状态；只读展示包装的 `status: finished` 不代表原场次已经结束。进行中场次只展示已揭晓的部分题。没有已揭晓题目的场次返回 404。

history 中的 humanChoice、humanCorrect、humanMs、aiChoice、aiCorrect、aiMs 是每题人机结果；自主练习的 AI 字段可为 null。`aiTimingIncomplete` 为 true 时不得比较该题 AI 用时。网页复盘地址为 `/#record/{id}`，只使用接口给出的真实 ID。

400 表示参数有误，404 表示记录不存在或暂无公开结果，429 表示限流，5xx 表示服务暂时失败。这些响应均不能解释为“做题数为零”。
