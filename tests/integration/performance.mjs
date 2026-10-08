import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DistributedRuntime } from '../../server/distributed.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { config, question } from '../web/fixtures.mjs';
import { MATCH_UPSERT, matchValues } from '../../server/storage.mjs';
for(const key of ['TEST_DATABASE_URL','TEST_REDIS_URL'])if(!process.env[key]||!['localhost','127.0.0.1'].includes(new URL(process.env[key]).hostname))throw new Error('Use isolated loopback test services.');
const rows=Array.from({length:10},(_,i)=>({...question,id:'performance_'+i})),bank=new QuestionBank('',rows);
const runtime=await DistributedRuntime.open(bank,{...config,databaseUrl:process.env.TEST_DATABASE_URL,redisUrl:process.env.TEST_REDIS_URL,redisPrefix:'performance:'+crypto.randomUUID()+':'},{worker:false});
try{
 if(Number((await runtime.pool.query('SELECT count(*) FROM study_matches')).rows[0].count))throw new Error('Performance seed requires an empty disposable database.');
 let id;await runtime.transaction(async client=>{
  for(let i=0;i<1000;i++){
   const createdAt=new Date(Date.now()-i*60000).toISOString();id=crypto.randomUUID();
   const match={id,ownerId:'primary',tokenHash:'benchmark-fixture',revision:12,status:'finished',index:9,createdAt,finishedAt:createdAt,name:'测试',
    settings:{mode:'practice',demo:false,modules:['数量关系'],count:10,images:'text',source:'all'},questionIds:rows.map(q=>q.id),questionFingerprints:rows.map(q=>bank.fingerprints.get(q.id)),
    rounds:rows.map((_,j)=>({phase:'revealed',humanChoice:j<7?'D':'A',humanCorrect:j<7,humanMs:30000,submittedAt:createdAt,completedAt:createdAt,explanation:''}))};
   await client.query(MATCH_UPSERT,matchValues(match));
  }
  await client.query('UPDATE study_state SET revision=revision+1 WHERE id=1');
 });
 const start=performance.now();const stats=await runtime.cached('dashboard',({learning})=>learning.dashboard('primary'));const coldMs=performance.now()-start;
 assert.equal(stats.summary.answered,10000);assert.equal(stats.summary.correct,7000);assert.equal(stats.summary.accuracy,70);
 const warm=[];for(let i=0;i<30;i++){const start=performance.now();await runtime.cached('dashboard',()=>{throw new Error('Cache miss');});warm.push(performance.now()-start);}warm.sort((a,b)=>a-b);
 const one=performance.now();const size=await runtime.run(({service})=>service.matches.size,{matchId:id,readOnly:true});const matchMs=performance.now()-one;assert.equal(size,1);
 const report={sessions:1000,completedAnswers:10000,expectedAccuracy:70,coldDashboardMs:Number(coldMs.toFixed(2)),cachedDashboardMedianMs:Number(warm[15].toFixed(2)),cachedDashboardP95Ms:Number(warm[28].toFixed(2)),singleMatchReadMs:Number(matchMs.toFixed(2)),singleMatchLoadedRecords:size};
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await runtime.close();}
