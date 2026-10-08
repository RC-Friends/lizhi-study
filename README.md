# 行测自习室

给备考朋友使用的刷题站：自主组卷、错题本、收藏和笔记、学习统计，以及与小栗或 JEV 对战。游客可以查看已完成的答题记录；考生使用口令登录，JWT 保存在浏览器本地。

人和多模态 LLM 同时开始答题。模型的讲解与选项在考生交卷前保持封存；双方交卷后比较答案、正确率和各自用时，确认后进入下一题。模型提供面向用户的公开解题说明，并用工具提交选项；不展示隐藏推理。JEV 使用原生结构化决策接口，图题可由独立视觉助手转写。

部署分成五个服务：

| 服务 | 内容 | 持久化 |
| --- | --- | --- |
| frontend | React 静态页面、Nginx API 与题图转发 | 无 |
| backend | API、JWT 验证、模型任务执行，可多副本 | 无本地数据卷 |
| database | PostgreSQL，答题记录、笔记、档案与任务 | 独立数据卷 |
| redis | 跨实例通知、全局限流、临时陪练流式内容 | 独立数据卷，AOF |
| seaweedfs | 私有 S3 题库、题图及版本清单 | 独立数据卷 |

代码、镜像与部署范例不依赖特定内网、仓库或集群。实际地址、密钥、口令与生成的部署文件只保留在被 Git 忽略的本地配置中。题库和题图不进入应用镜像。

## 启动

需要 Node.js 24、Python 3、Docker Engine 与 Docker Compose v2。已经有资源包时，可跳过下载与整理步骤。

```bash
npm ci
python3 -m pip install -r requirements.txt
python3 scripts/download_sources.py
python3 scripts/download_images.py
python3 scripts/build_dataset.py
python3 scripts/validate_dataset.py
npm run resources:pack -- --output=artifacts/resources-v1
npm run stack:prepare -- --bundle=artifacts/resources-v1
```

`stack:prepare` 生成随机登录口令、JWT 签名密钥、数据库与 Redis 密码，以及分开的 S3 读取/发布凭证。登录口令在 `.env.stack` 的 `SITE_PASSWORD`；可在首次启动前修改。已有配置不会被覆盖。

```bash
docker compose --env-file .env.stack build
docker compose --env-file .env.stack up -d --wait database redis seaweedfs
docker compose --env-file .env.stack run --rm --no-deps -T \
  -v "$PWD/artifacts/resources-v1:/bundle:ro" backend \
  node scripts/upload-resources.mjs --source=/bundle --credentials-stdin \
  < deploy/local/seaweedfs-publisher.json
docker compose --env-file .env.stack up -d --wait --scale backend=2
```

访问 `http://127.0.0.1:3210`。要从局域网访问，将 `.env.stack` 中 `APP_BIND` 改为 `0.0.0.0` 后重新执行最后一条命令。正式公网入口应配置 HTTPS。

五个服务默认各一个容器；上面的扩容命令启动两个后端容器，用于验证跨实例运行。前端是唯一发布主机端口的服务。

## 配置与部署

- [Docker Compose 与 Kubernetes 部署、资源发布、备份和迁移](docs/DEPLOYMENT.md)
- [状态、任务及接口设计](docs/PROTOTYPE.md)
- [配置字段](.env.example)
- [Kubernetes 数据服务范例](deploy/kubernetes/data.json)、[应用范例](deploy/kubernetes/app.json)
- [数据结构](SCHEMA.md)、[来源与许可](LICENSES.md)

在 `.env.stack` 中配置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。确认模型支持图像输入后再设置 `LLM_VISION=true`。不配置模型也能使用自主练习和明确标记的演示对战。模型密钥仅由后端读取。

## 开发与验证

```bash
npm test
npm run build
```

本地开发可在 `.env` 配置 `STORAGE_DRIVER=files`、`RESOURCE_DRIVER=files`，运行 `npm run dev` 启动 Vite 与开发后端。文件模式只为离线开发与旧记录迁移保留；容器生产后端强制使用 PostgreSQL 和 Redis。

`node tests/integration/performance.mjs` 可在独立空测试库测量一万次作答的统计和缓存耗时。

`npm run test:postgres`、`npm run test:seaweedfs`、`npm run test:distributed` 需要独立测试服务，使用各测试文件注明的 `TEST_*` 环境变量。`npm run test:stack` 使用 `E2E_BASE_URL`、`E2E_PASSWORD`、`BROWSER_PATH` 访问本机隔离的完整容器栈，真实点击桌面和手机界面；不会调用付费模型。测试输出位于被忽略的 `test-results/`。

数据采集脚本保留来源及固定版本，JSONL 中的图片字段使用相对路径。原始题目、图片和抓取产物不提交到 Git；需要在本地生成资源包并发布到 SeaweedFS。
