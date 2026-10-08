import fs from 'node:fs';
const { version } = JSON.parse(fs.readFileSync('package.json'));
const changes = fs.readFileSync('CHANGELOG.md', 'utf8').split(`## [${version}]`)[1];
if (!changes) throw new Error('Missing changelog entry');
console.log(changes.split('\n## [')[0].replace(/^\s*—[^\n]*\n/, '').trim());
console.log('\n附带源码、Docker/Kubernetes 部署资料、前端静态包及 SHA-256 校验文件。`images.json` 列出 GHCR 前后端镜像的不可变摘要（linux/amd64）。私有仓库镜像需要对应的读取权限。\n\n题库和题图、配置密钥、学习记录独立管理，不在发布包中。CI 使用合成题目与演示模型；本次发布不会更新已有部署。');
