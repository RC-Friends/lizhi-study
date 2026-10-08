import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
const { values } = parseArgs({ options: { env: { type:'string', default:'.env.stack' }, output: { type:'string', default:'deploy/local/kubernetes' },
  'backend-image': { type:'string' }, 'frontend-image': { type:'string' } } });
if (!values['backend-image'] || !values['frontend-image']) throw new Error('请通过 --backend-image 和 --frontend-image 指定两个已构建的镜像。');
const env = parseEnv(fs.readFileSync(values.env,'utf8')), out = path.resolve(values.output);
if (fs.existsSync(out)) throw new Error('输出目录已存在，拒绝覆盖已有部署和密钥文件。');
for (const name of ['SITE_PASSWORD','JWT_SECRET','DATABASE_URL','POSTGRES_PASSWORD','REDIS_URL','REDIS_PASSWORD','QUESTION_RESOURCE_VERSION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','SEAWEEDFS_CONFIG_FILE']) if (!env[name]) throw new Error(`配置缺少 ${name}`);
const secret = (name, data) => ({ apiVersion:'v1',kind:'Secret',metadata:{name,namespace:'xingce'},type:'Opaque',stringData:data });
const backendKeys = ['SITE_PASSWORD','JWT_SECRET','JWT_TTL_DAYS','LEARNER_NAME','PUBLIC_URL','DATABASE_URL','REDIS_URL','REDIS_PREFIX','QUESTION_RESOURCE_VERSION','S3_BUCKET','S3_REGION','S3_PREFIX','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'];
const backendEnv = Object.fromEntries(Object.entries(env).filter(([key])=>backendKeys.includes(key) || /^(LLM_|JEV_|VISION_)/.test(key)));
const secrets = {apiVersion:'v1',kind:'List',items:[secret('xingce-backend',backendEnv),secret('xingce-postgres',{POSTGRES_PASSWORD:env.POSTGRES_PASSWORD}),secret('xingce-redis',{REDIS_PASSWORD:env.REDIS_PASSWORD}),secret('xingce-s3',{'s3.json':fs.readFileSync(env.SEAWEEDFS_CONFIG_FILE,'utf8')})]};
const app = JSON.parse(fs.readFileSync('deploy/kubernetes/app.json','utf8'));
for (const item of app.items) if(item.kind==='Deployment') item.spec.template.spec.containers[0].image=values[item.metadata.name+'-image'];
fs.mkdirSync(out,{recursive:true,mode:0o700});
for(const [name,body] of Object.entries({'secrets.json':secrets,'app.json':app})) fs.writeFileSync(path.join(out,name),JSON.stringify(body,null,2)+'\n',{mode:0o600});
for(const name of ['data.json','namespace.json']) fs.copyFileSync(path.join('deploy/kubernetes',name),path.join(out,name));
console.log(`已生成 ${values.output}；包含实际密钥，只保留在本地。尚未连接或修改任何集群。`);
