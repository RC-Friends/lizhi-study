# 部署与数据维护

此仓库提供通用的 Docker Compose 与 Kubernetes 范例，不包含实际服务器、镜像仓库、内网地址、用户密码或集群访问凭证。生成配置只写到被 Git 忽略的 `.env.*` 与 `deploy/local/`；准备和渲染命令不会连接集群。

## Docker Compose

先按 [README](../README.md) 生成资源包，再执行：

```bash
npm run stack:prepare -- --bundle=artifacts/resources-v1
```

生成 `.env.stack`、`deploy/local/seaweedfs-s3.json` 与 `deploy/local/seaweedfs-publisher.json`，权限为 0600。前两者供容器启动使用，发布凭证只用于上传，不传入正常运行的后端。已有文件不会覆盖。

按需编辑 `.env.stack` 的 `SITE_PASSWORD`、`APP_BIND`、`APP_PORT`、模型设置及 `PUBLIC_URL`，然后：

```bash
docker compose --env-file .env.stack build
docker compose --env-file .env.stack up -d --wait database redis seaweedfs
docker compose --env-file .env.stack run --rm --no-deps -T \
  -v "$PWD/artifacts/resources-v1:/bundle:ro" backend \
  node scripts/upload-resources.mjs --source=/bundle --credentials-stdin \
  < deploy/local/seaweedfs-publisher.json
docker compose --env-file .env.stack up -d --wait --scale backend=2
docker compose --env-file .env.stack ps
```

只有 frontend 发布端口，默认 `127.0.0.1:3210`。backend 不发布端口、无本地数据卷，可以扩容。数据库、Redis 与 SeaweedFS 只在 Compose 网络内开放。Redis 使用密码和 AOF；SeaweedFS 禁止匿名读取，应用身份只有 bucket 读取权限。

SeaweedFS 启动时把只读挂载的 0600 配置复制到容器内存文件系统，设置为服务用户专属读取，再通过官方入口降权运行。因此主机用户 UID 不必与容器相同，也不需要放宽主机密钥文件权限；这份临时配置不会写入数据卷。

对外访问时可以在主机使用 [Caddy 范例](../deploy/Caddyfile) 配置域名与 HTTPS，代理到 frontend。`PUBLIC_URL` 应设置为最终 HTTPS 站点地址。Nginx 会保留 Host、关闭 SSE 缓冲，并重新解析后端服务 DNS；连接重建可落到任意副本。仅在明确的代理边界内设置 `TRUST_PROXY`，不要对直接暴露的后端设置无限信任。

`docker compose down` 不删除命名数据卷；不要把 `down -v` 当成普通重启。修改 `.env.stack` 的数据库密码不会自动修改已有 PostgreSQL 卷中的账户密码，需要另行完成数据库账户变更。保存好配置与三个数据卷的备份。

## Kubernetes

范例位于 `deploy/kubernetes/`，使用 Kubernetes 原生 JSON 清单（`kubectl` 同时支持 JSON 与 YAML）。数据服务各一个副本、独立 PVC；后端默认两个副本；frontend Service 类型为 LoadBalancer。未指定存储类、外部 IP、域名、节点或镜像拉取凭证。集群需要默认 StorageClass；LoadBalancer 需要由目标环境提供实现，否则可以临时 port-forward 访问。

先构建并将两个镜像发布到自己选择的仓库；下面的域名只作占位。推送与部署应在准备正式环境时自行执行：

```bash
docker build -t registry.example.com/study/backend:v1 .
docker build -f Dockerfile.frontend -t registry.example.com/study/frontend:v1 .
docker push registry.example.com/study/backend:v1
docker push registry.example.com/study/frontend:v1
node scripts/render-k8s.mjs --env=.env.stack \
  --backend-image=registry.example.com/study/backend:v1 \
  --frontend-image=registry.example.com/study/frontend:v1
```

渲染结果在 `deploy/local/kubernetes/`，其中 `secrets.json` 含真实凭证，不能提交 Git。清单中的服务名与 `.env.stack` 生成的 PostgreSQL、Redis 地址一致，不需要任何现有内网服务。私有镜像仓库的 `imagePullSecrets` 由目标环境自行配置。

确认选中目标 Kubernetes context 后，先部署数据服务：

```bash
kubectl apply -f deploy/local/kubernetes/namespace.json
kubectl apply -f deploy/local/kubernetes/secrets.json
kubectl apply -f deploy/local/kubernetes/data.json
kubectl -n xingce rollout status deployment/database
kubectl -n xingce rollout status deployment/redis
kubectl -n xingce rollout status deployment/seaweedfs
kubectl -n xingce port-forward service/seaweedfs 18333:8333
```

在另一个终端发布题库。端口转发只绑定本机；凭证从本地文件读取：

```bash
S3_ENDPOINT=http://127.0.0.1:18333 node --env-file=.env.stack \
  scripts/upload-resources.mjs --source=artifacts/resources-v1 --credentials-stdin \
  < deploy/local/seaweedfs-publisher.json
kubectl apply -f deploy/local/kubernetes/app.json
kubectl -n xingce rollout status deployment/backend
kubectl -n xingce rollout status deployment/frontend
kubectl -n xingce get service frontend
```

只在受信任的局域网使用 HTTP LoadBalancer；公网使用已有 HTTPS 入口或 TLS 终结代理。临时预览可运行 `kubectl -n xingce port-forward service/frontend 3210:80`。这些命令都是范例，本地准备不会执行它们。

SeaweedFS 使用 headless Service，单容器 `weed mini` 可通过 Pod 地址访问自己的内部组件。PVC 配置未绑定特定供应商；数据库和对象存储使用 Recreate 策略，避免两个单实例进程同时访问同一数据卷。五服务方案是易部署的单机数据服务布局，后端多副本不等于 PostgreSQL、Redis 或 SeaweedFS 高可用。

## 资源版本与发布

结构化题目只保存 `assets/images/...` 形式的相对图片路径。上传器会验证本地 manifest、文件大小与 SHA-256，上传并读取验证所有对象，最后才发布 manifest。相同版本重复上传复用相同内容；同一路径已存在不同内容时拒绝覆盖。

题库与图像位于 `question-resources/<完整版本摘要>/` 下。将 manifest 的版本写入 `QUESTION_RESOURCE_VERSION`，运行时只读取该版本。后端公开题图代理不公开 `questions.jsonl` 或 manifest，因此不能直接下载答案库。

升级题库时保留旧资源版本，先上传新版本并检查所有历史题目 ID 与内容指纹兼容。由于不同副本不可同时使用互不兼容的题库，资源切换应先停止后端，更新统一配置，再启动所有副本。仅更新应用代码且数据库兼容时可以滚动更新。

## 旧记录迁移

先停止旧应用写入并复制完整运行数据目录，保留原始备份。迁移程序默认只校验，不写数据库；遇到损坏文件、缺题或题目内容改变会停止，不会静默丢弃。

```bash
docker compose --env-file .env.stack run --rm --no-deps \
  -v "$PWD/backups/legacy-runtime:/legacy:ro" backend \
  node scripts/import-legacy.mjs --source=/legacy
```

确认校验结果后添加 `--apply` 执行导入。应在启动新后端之前导入一个独立、空的数据库。重复导入同一备份会返回已导入；目标包含其他记录时拒绝覆盖。不要把旧单进程 PostgreSQL 后端与新分布式后端同时指向同一数据库。

## 备份与恢复

PostgreSQL 备份包含练习、笔记、档案、任务及导入记录；SeaweedFS 数据卷包含题库和题图；Redis 仅承载临时数据与限流，但保留其卷可以避免重启清空限流窗口。

```bash
mkdir -p backups
docker compose --env-file .env.stack exec -T database \
  pg_dump -U xingce -d xingce -Fc > backups/study.dump
```

对 SeaweedFS 使用停写后的卷快照或完整卷备份，连同对应资源 manifest、`.env.stack` 和 S3 配置单独加密保存。恢复演练应使用新的数据卷和独立服务栈；数据库恢复后必须使用兼容的题库版本。不要在正常重启或升级中删除卷。

## 验收范围

单元测试覆盖封存与判分、权限、计时、组卷、笔记、模型工具协议及资源校验。真实 PostgreSQL/Redis 测试覆盖跨实例提交与 SSE、陪练任务去重、共享限流、事务回滚、实例替换和任务中断恢复。SeaweedFS 测试覆盖禁止匿名读取、读取凭证权限、上传完整性、损坏对象、HTTP 题图和模型图片输入。

完整容器栈通过 Playwright 点击桌面与手机界面验证。Kubernetes 清单在本地校验；目标集群的存储类、镜像拉取和 LoadBalancer 能力应在正式部署时确认。
