# 验收与发布

正式名称为「栗知自习室 / Lizhi Study」，仓库名与 npm 包名为 `lizhi-study`。为保证已有数据卷和浏览器登录态兼容，Compose 默认项目名、数据库名及浏览器存储键仍保留原有标识；应用不会因命名调整丢失历史数据。

## 持续集成

GitHub Actions 对 main 推送和 PR 执行两个独立任务：

- Node.js 24 单元测试、仓库敏感文件检查、前端构建，以及 Python 数据采集管线测试。
- 构建前后端 Docker 镜像，启动 PostgreSQL、Redis、SeaweedFS 和两个后端副本；测试事务、缓存版本与共享任务，再用 Chromium 点击桌面和手机界面，验证登录、图题、错题本、公开监督、并行答题、计时和报告。
- 使用本机合成模型接口，在浏览器配置 Embedding/Rerank、切换四种组合、完成知识库练习，并验证单边故障和双边超时的回退提示。

测试只使用随机生成的测试凭证、合成题库和演示模型，没有真实模型调用。测试端口随机分配并仅绑定 loopback。CI artifact 仅保存明确列出的浏览器截图和结果 JSON，保留 7 天，不上传整个工作目录或容器日志。所有第三方 Action 固定到提交 SHA，PR 任务仅有读取代码权限，不读取部署密钥。

本地复现：

```bash
npm ci
npm test
npm run build
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests -p 'test_*.py'
npx --no-install playwright-core install --with-deps chromium
npm run test:rag
npm run test:ci-stack
```

需要 Node.js 24、Python 3、Docker Engine 和 Docker Compose 2.24.4 或以上。测试使用全新项目名，最终只删除它创建的容器和数据卷，不读取 `.env.stack` 或已有 Compose 项目。

## 发布版本

采用 `v主版本.次版本.修订号` tag。先把功能和 CI 修改提交到 main，等 CI 通过，再准备版本提交：

```bash
npm version 0.4.0 --no-git-tag-version
# 在 CHANGELOG.md 添加对应版本说明。
git add package.json package-lock.json CHANGELOG.md
git commit -m 'chore: release v0.4.0'
git push origin main
# 确认这条提交对应的 main CI 已通过，再发布 tag。
git tag -a v0.4.0 -m 'Lizhi Study v0.4.0'
git push origin v0.4.0
```

Release workflow 验证 tag、package 版本、更新日志和提交标题严格匹配，然后重新执行完整 CI。通过后构建并推送两个 `linux/amd64` 镜像到 `ghcr.io/<owner>/<repo>-backend:<tag>` 与 `ghcr.io/<owner>/<repo>-frontend:<tag>`，附带源码仓库、版本和 commit 标签。其他架构可使用仓库中的 Dockerfile 自行构建。发布任务只使用 GitHub 自带的 `GITHUB_TOKEN`，分别授予镜像写入和 Release 写入权限，无需配置 Harbor、Kubernetes 或 SSH 凭证。

最后先创建草稿 Release，上传完成后再公开发布。附件包括：

- `*-source.tar.gz`：通过 `git archive` 生成的版本源码。
- `*-deploy.tar.gz`：Compose、Kubernetes 范例、配置生成与资源发布脚本，以及运行这些脚本所需的模块和依赖清单。使用已发布镜像启动，不在该包内本地构建镜像。
- `*-frontend.tar.gz`：前端静态产物。
- `images.json`：前后端版本 tag 和不可变镜像摘要。
- `SHA256SUMS`：以上附件的 SHA-256 校验值。

附件不包含题库、题图、模型密钥、用户口令或学习记录。CI/CD 只交付产物，不执行部署。后续选择升级现有实例时，需要另行准备资源版本、备份和环境配置。

## 使用发布镜像

按 [部署说明](DEPLOYMENT.md) 准备资源包和 `.env.stack`，把 `images.json` 中的两个 `image` 值分别写为 `BACKEND_IMAGE`、`FRONTEND_IMAGE`。使用摘要可以固定到本次发布的镜像内容。

如果仓库和包是私有的，先使用具有 `read:packages` 权限的凭证登录 GHCR；不要把凭证写入仓库或镜像。随后执行：

```bash
docker compose --env-file .env.stack pull
docker compose --env-file .env.stack up -d --wait database redis seaweedfs
docker compose --env-file .env.stack run --rm --no-deps -T \
  -v "$PWD/artifacts/resources-v1:/bundle:ro" backend \
  node scripts/upload-resources.mjs --source=/bundle --credentials-stdin \
  < deploy/local/seaweedfs-publisher.json
docker compose --env-file .env.stack up -d --wait --no-build --scale backend=2
```

Kubernetes 的 `render-k8s.mjs` 同样接受镜像摘要；私有镜像的 `imagePullSecrets` 由目标环境自行配置。升级前先核对当前数据库与题库的兼容性。
