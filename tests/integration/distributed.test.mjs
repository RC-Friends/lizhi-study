import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DistributedRuntime } from '../../server/distributed.mjs';
import { MatchService } from '../../server/matches.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { createApp } from '../../server/app.mjs';
import { runKnowledge } from '../../server/knowledge-runtime.mjs';
import { embeddingIndexKey } from '../../server/embeddings.mjs';
import { config, question, settings, result } from '../web/fixtures.mjs';

for (const name of ['TEST_DATABASE_URL','TEST_REDIS_URL']) {
  if (!process.env[name] || !['localhost','127.0.0.1'].includes(new URL(process.env[name]).hostname)) throw new Error('Use isolated loopback TEST_DATABASE_URL and TEST_REDIS_URL.');
}
const waitFor = async fn => { for (let i=0;i<150;i++) { const value=await fn(); if(value)return value; await delay(50); } throw new Error('Timed out'); };

test('two stateless backends share durable state, jobs and streams', async t => {
  const bank = new QuestionBank('', [question]);
  const configuration = { ...config, databaseUrl: process.env.TEST_DATABASE_URL, redisUrl: process.env.TEST_REDIS_URL,
    adminPassword: 'isolated-integration-admin-password',
    redisPrefix: 'integration:' + crypto.randomUUID() + ':', workerPollMs: 50, jobLeaseMs: 3000, serveFrontend: false };
  let calls = 0, coachCalls = 0;
  const gates = [];
  const provider = async (_q, _c, { signal, emit }) => {
    calls++; emit('explanation', { text: 'SEALED_EXPLANATION' });
    await new Promise((resolve,reject) => { gates.push(resolve); signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); });
    signal.throwIfAborted(); emit('explanation_complete', { text: 'SEALED_EXPLANATION' }); return result('D');
  };
  const coachProvider = async (_c,_body,{ signal,onText }) => { coachCalls++; onText('一起来复盘。'); await delay(300,undefined,{signal}); return { content: '一起来复盘。' }; };
  const opened = [], servers = [];
  const make = async (worker = true) => {
    const runtime = await DistributedRuntime.open(bank, configuration, { providers: { llm: provider }, coachProvider, worker }); opened.push(runtime);
    const app = createApp(bank,new MatchService(bank,configuration,{persist:false}),configuration,{runtime});
    const server = app.listen(0,'127.0.0.1');await once(server,'listening'); servers.push(server);
    return { runtime, base:'http://127.0.0.1:'+server.address().port };
  };
  t.after(async()=> { await Promise.all(opened.map(r=>r.close())); await Promise.all(servers.map(s=>{s.closeAllConnections();return new Promise(resolve=>s.close(resolve));})); });
  const a=await make(), b=await make();
  const request = async (node,path,{method='GET',body,token}={}) => {
    const response=await fetch(node.base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const login=await request(a,'/api/login',{method:'POST',body:{password:config.sitePassword}}); assert.equal(login.status,200);
  const token=login.data.token;
  const get=(node,path)=>request(node,path,{token}); const post=(node,path,body)=>request(node,path,{method:'POST',body,token});
  let id;
  await t.test('cross-instance submission keeps AI sealed and emits only safe snapshots',async()=>{
    const created=await post(a,'/api/matches',settings);assert.equal(created.status,201);id=created.data.match.id;
    await waitFor(()=>calls===1); await delay(200);
    const before=await get(b,`/api/matches/${id}`);
    assert.equal(before.status,200);assert.ok(!JSON.stringify(before.data).includes('SEALED_EXPLANATION'));assert.ok(!JSON.stringify(before.data).includes('GOLD_SECRET'));
    const controller=new AbortController();const response=await fetch(b.base+`/api/matches/${id}/events`,{headers:{Authorization:'Bearer '+token},signal:controller.signal});
    let streamed='';const read=(async()=>{try{for await(const chunk of response.body)streamed+=Buffer.from(chunk).toString();}catch{}})();
    await delay(80);assert.ok(!streamed.includes('SEALED_EXPLANATION'));
    const submitted=await Promise.all([post(a,`/api/matches/${id}/answer`,{index:0,choice:'D'}),post(b,`/api/matches/${id}/answer`,{index:0,choice:'D'})]);
    assert.ok(submitted.every(r=>r.status===200));gates.shift()();
    const completed=await waitFor(async()=>{const r=await get(b,`/api/matches/${id}`);return r.data.current.phase==='revealed'&&r.data;});
    assert.equal(completed.scores.human,1);assert.equal(completed.scores.ai,1);assert.equal(calls,1);
    assert.equal(completed.current.humanChoice,'D');assert.ok(completed.current.result.humanMs>=0);assert.ok(completed.current.result.aiMs>=0);
    await waitFor(()=>streamed.includes('revealed'));controller.abort();await read;
    assert.equal((await post(a,`/api/matches/${id}/answer`,{index:0,choice:'A'})).status,409);
  });
  await t.test('coach reservation is global and completed chat survives another backend',async()=>{
    const start=node=>node.runtime.enqueueCoach(id,0,'帮我理解',service=>service.matches.get(id));
    const results=await Promise.allSettled([start(a),start(b)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
    const jobId=results.find(x=>x.status==='fulfilled').value;
    await waitFor(async()=>(await b.runtime.jobStatus(jobId)).status==='done');
    assert.equal(coachCalls,1);const snapshot=await get(b,`/api/matches/${id}/coach?index=0`);
    assert.equal(snapshot.data.messages.length,2);assert.equal(snapshot.data.remaining,7);assert.equal(snapshot.data.busy,false);
    const guest=await request(b,'/api/public/matches/'+id);assert.ok(!JSON.stringify(guest.data).includes('帮我理解'));
  });
  await t.test('different replicas update bookmarks and profiles without stale overwrites',async()=>{
    await Promise.all([
      request(a,'/api/learning/profile',{method:'PATCH',token,body:{nickname:'一起刷题'}}),
      request(b,'/api/learning/questions/'+question.id,{method:'PATCH',token,body:{bookmarked:true,note:'PRIVATE_NOTE'}}),
    ]);
    assert.equal((await get(a,'/api/learning/questions/'+question.id)).data.note,'PRIVATE_NOTE');
    assert.equal((await get(b,'/api/learning/dashboard')).data.profile.nickname,'一起刷题');
    assert.ok(!JSON.stringify((await request(a,'/api/public/dashboard')).data).includes('PRIVATE_NOTE'));
    await assert.rejects(a.runtime.run(({learning})=>{learning.updateProfile({nickname:'ROLLED_BACK'});throw new Error('rollback');}));
    assert.equal((await get(b,'/api/learning/dashboard')).data.profile.nickname,'一起刷题');
  });
  await t.test('a restarted replica restores history without generating again',async()=>{
    await post(b,`/api/matches/${id}/finish`,{});await a.runtime.close();const replacement=await make();
    const saved=await get(replacement,`/api/matches/${id}`);assert.equal(saved.data.scores.human,1);assert.equal(saved.data.status,'finished');
    await delay(200);assert.equal(calls,1);
  });
  await t.test('global rate limits cannot be bypassed by switching replicas',async()=>{
    const key='test:'+crypto.randomUUID();await a.runtime.close();
    const active=opened.filter(r=>!r.closed);
    await active[0].limit(key,2,5000);await active[1].limit(key,2,5000);
    await assert.rejects(active[0].limit(key,2,5000),error=>error.status===429);
  });
  await t.test('versioned caches update scores immediately and late old readers cannot poison the new version',async()=>{
    const initial=await get(b,'/api/learning/overview');assert.equal(initial.data.summary.accuracy,100);
    const statsBefore=await request(b,'/api/public/stats');assert.equal(statsBefore.data.summary.accuracy,100);
    const active=opened.filter(r=>!r.closed), other=active.find(r=>r!==b.runtime);
    let release, entered;const started=new Promise(resolve=>entered=resolve);
    const oldRead=other.cached('cache-race',async({learning})=>{const value=learning.dashboard('primary');entered();await new Promise(resolve=>release=resolve);return value;});
    await started;
    const created=await post(b,'/api/matches',{...settings,mode:'practice'}),mid=created.data.match.id;
    await post(b,`/api/matches/${mid}/answer`,{index:0,choice:'A'});
    const fresh=await b.runtime.cached('cache-race',({learning})=>learning.dashboard('primary'));
    assert.equal(fresh.summary.answered,2);assert.equal(fresh.summary.correct,1);assert.equal(fresh.summary.accuracy,50);
    release();assert.equal((await oldRead).summary.accuracy,100);
    const hit=await other.cached('cache-race',()=>{throw new Error('Expected shared Redis cache hit');});assert.equal(hit.summary.accuracy,50);
    const overview=await get(b,'/api/learning/overview');assert.equal(overview.data.summary.answered,2);assert.equal(overview.data.history.total,2);
    assert.notEqual(overview.data.dataRevision,initial.data.dataRevision);
    const publicView=await request(b,'/api/public/overview');assert.equal(publicView.data.summary.accuracy,50);assert.equal(publicView.data.wrong,undefined);
    assert.ok(!JSON.stringify(publicView.data).includes('PRIVATE_NOTE'));
    const statsAfter=await request(b,'/api/public/stats?module=all');
    assert.equal(statsAfter.data.summary.answered,2);assert.equal(statsAfter.data.summary.accuracy,50);
    assert.notEqual(statsAfter.data.dataRevision,statsBefore.data.dataRevision);
    const replica=opened.find(r=>!r.closed&&r!==b.runtime),key='public:stats:v1:'+JSON.stringify({from:statsAfter.data.range.from,to:statsAfter.data.range.to,module:'all'});
    const shared=await replica.cached(key,()=>{throw new Error('Expected canonical guest stats to share Redis cache');});
    assert.deepEqual(shared,statsAfter.data);assert.ok(!JSON.stringify(shared).includes('PRIVATE_NOTE'));
    await post(b,`/api/matches/${mid}/finish`,{});
  });
  await t.test('Redis loss does not serve stale cached scores and admission fails closed',async()=>{
    const c=await make(false);c.runtime.redis.destroy();
    const state=await get(c,'/api/learning/dashboard');assert.equal(state.status,200);assert.equal(state.data.summary.accuracy,50);
    assert.equal((await request(c,'/api/health')).status,503);
    const login=await request(c,'/api/login',{method:'POST',body:{password:config.sitePassword}});assert.equal(login.status,503);
    await c.runtime.close();
  });
  await t.test('expired execution leases become manual retry, without automatic re-billing',async()=>{
    // Stop workers, then simulate an instance that died after the durable claim.
    for(const r of opened)clearInterval(r.timer);
    const created=await post(b,'/api/matches',settings),mid=created.data.match.id;
    await b.runtime.transaction(async client=>{await client.query("UPDATE study_jobs SET status='running',worker='dead-instance',lease_until=now()-interval '1 second' WHERE match_id=$1",[mid]);});
    await b.runtime.recover();
    const state=(await get(b,`/api/matches/${mid}`)).data;
    assert.equal(state.current.aiStatus,'error');assert.equal(calls,1);
    assert.equal((await post(b,`/api/matches/${mid}/answer`,{index:0,choice:'D'})).data.current.phase,'error');
    assert.equal((await post(b,`/api/matches/${mid}/retry`,{index:0})).status,200);
    b.runtime.startWorker();await waitFor(()=>calls===2);gates.shift()();
    await waitFor(async()=>(await get(b,`/api/matches/${mid}`)).data.current.phase==='revealed');
    assert.equal((await get(b,`/api/matches/${mid}`)).data.current.result.attempts,2);
  });
  await t.test('administrator model changes and libraries survive replica switches and stale bootstrap environments', async () => {
    const c = await make(false);
    const admin = (await request(b, '/api/login', { method: 'POST', body: { role: 'admin', password: configuration.adminPassword } })).data.token;
    assert.equal((await request(c, '/api/session', { token: admin })).data.role, 'admin');
    assert.equal((await get(c, '/api/ai/config')).status, 403);
    const previous = (await request(b, '/api/public/revision')).data.dataRevision;
    const current = (await request(b, '/api/ai/config', { token: admin })).data;
    const changed = await request(b, '/api/ai/config', { method: 'PUT', token: admin,
      body: { provider: 'llm', revision: current.revision, model: 'panel-configured-model', apiKey: 'panel-configured-secret' } });
    assert.equal(changed.status, 200); assert.ok(!JSON.stringify(changed.data).includes('panel-configured-secret'));
    assert.notEqual((await request(c, '/api/public/revision')).data.dataRevision, previous);
    assert.equal((await request(c, '/api/catalog')).data.providers.llm.model, 'panel-configured-model');
    assert.equal(await c.runtime.run(({ service }) => service.config.llm.key, { readOnly: true }), 'panel-configured-secret');
    assert.equal(await c.runtime.withQuestions(({ config }) => config.llm.model), 'panel-configured-model');
    const library = await request(b, '/api/kb/libraries', { method: 'POST', token: admin, body: { name: '跨副本备考资料' } });
    assert.equal(library.status, 201); assert.equal(library.data.ownerId, 'primary');
    const document = await post(c, `/api/kb/libraries/${library.data.id}/documents`, { title: '相遇问题', format: 'text', content: '相遇问题用路程除以速度和。' });
    assert.equal(document.status, 201);
    assert.equal((await get(b, `/api/kb/libraries/${library.data.id}`)).data.items.length, 1);
    const stale = await request(c, '/api/ai/config', { method: 'PUT', token: admin, body: { revision: current.revision, model: 'stale-edit' } });
    assert.equal(stale.status, 409);
    const restarted = await DistributedRuntime.open(bank, { ...configuration, llm: { key: 'stale-environment-secret', model: 'stale-environment-model' } }, { worker: false });
    opened.push(restarted);
    assert.equal(await restarted.withQuestions(({ config }) => config.llm.model), 'panel-configured-model');
    assert.equal(await restarted.withQuestions(({ config }) => config.llm.key), 'panel-configured-secret');
  });
  await t.test('embedding batches share durable leases, cache queries and fence model changes across replicas', async () => {
    for (const runtime of opened) await runtime.retrieval?.close();
    const d = await make(false), e = await make(false), inputs = [], rankInputs = [], release = [];
    let hold = true, rankFailing = false;
    const upstream = http.createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      if (req.url.endsWith('/rerank')) {
        assert.equal(req.headers.authorization, undefined);
        rankInputs.push(body);
        if (rankFailing) { res.writeHead(503); res.end('{}'); return; }
        res.end(JSON.stringify({ results: body.documents.map((text, index) => ({ index, relevance_score: text.includes('赶上') ? 0.95 : 0.01 })) })); return;
      }
      inputs.push(body.input);
      if (hold) await new Promise(resolve => release.push(resolve));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: text.includes('追及') || text.includes('赶上') ? [1, 0] : [0, 1] })) }));
    }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const admin = (await request(d, '/api/login', { method: 'POST', body: { role: 'admin', password: configuration.adminPassword } })).data.token;
    try {
      const library = (await post(d, '/api/kb/libraries', { name: '向量验收笔记' })).data;
      const document = (await post(d, `/api/kb/libraries/${library.id}/documents`, { title: '车辆笔记', format: 'text', content: '同向行驶时，赶上的时刻用初始间隔除以快慢差。' })).data.document;
      await post(d, `/api/kb/libraries/${library.id}/documents`, { title: '化学笔记', format: 'text', content: '生锈是一种缓慢氧化现象。' });
      await runKnowledge(d.runtime, configuration, ({ knowledge }) => {
        const privateLibrary = knowledge.createLibrary({ name: '另一个人的资料' }, 'other-owner');
        return knowledge.upload({ libraryId: privateLibrary.id, title: '私密车辆材料', format: 'text', content: '赶上前车的私密公式。' }, 'other-owner');
      });
      const changed = await request(d, '/api/ai/config', { method: 'PUT', token: admin, body: { provider: 'embedding',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'integration-embedding-key', model: 'semantic-model', enabled: true, batchSize: 1 } });
      assert.equal(changed.status, 200);
      await waitFor(() => inputs.length === 1);
      const second = e.runtime.retrieval.tick(); await waitFor(() => inputs.length === 2);
      // Neither request owns a transaction or blocks ordinary learner writes.
      assert.equal((await request(e, '/api/learning/profile', { method: 'PATCH', token, body: { nickname: '向量检索同学' } })).status, 200);
      assert.notEqual(inputs[0][0], inputs[1][0]); hold = false; release.splice(0).forEach(resolve => resolve());
      await second; await d.runtime.retrieval.tick();
      for (let i = 0; i < 8; i++) await Promise.all([d.runtime.retrieval.tick(), e.runtime.retrieval.tick()]);
      const status = (await request(e, '/api/admin/rag/status', { token: admin })).data;
      assert.equal(status.ready, status.total); assert.equal(status.total, 3);
      const chunkInputs = inputs.flat(); assert.equal(new Set(chunkInputs).size, chunkInputs.length);
      const found = await get(e, '/api/kb/search?q=' + encodeURIComponent('追及问题'));
      assert.equal(found.status, 200); assert.equal(found.data.mode, 'hybrid'); assert.equal(found.data.items[0].document.id, document.id);
      assert.ok(found.data.items.every(item => item.document.title !== '私密车辆材料'));
      await get(d, '/api/kb/search?q=' + encodeURIComponent('追及问题'));
      assert.equal(inputs.filter(batch => batch[0] === '追及问题').length, 1);
      assert.equal((await get(e, '/api/admin/rag/status')).status, 403);
      assert.equal((await request(e, '/api/admin/rag/reindex', { method: 'POST', token, body: {} })).status, 403);
      assert.equal((await request(d, '/api/ai/config', { method: 'PUT', token: admin, body: { provider: 'rerank',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'ranker-model', enabled: true, authRequired: false } })).status, 200);
      // Real HTTP, durable admin settings and Redis shared by two replicas.
      for (const embeddingEnabled of [false, true]) for (const rerankEnabled of [false, true]) {
        await request(d, '/api/ai/config', { method: 'PUT', token: admin, body: { provider: 'embedding', enabled: embeddingEnabled } });
        await request(d, '/api/ai/config', { method: 'PUT', token: admin, body: { provider: 'rerank', enabled: rerankEnabled } });
        for (const replica of [d, e]) {
          const result = await get(replica, '/api/kb/search?q=' + encodeURIComponent('赶上'));
          assert.equal(result.status, 200); assert.equal(result.data.mode, embeddingEnabled ? 'hybrid' : 'keyword');
          assert.equal(result.data.rerank.applied, rerankEnabled); assert.equal(result.data.items[0].document.id, document.id);
        }
      }
      assert.equal(rankInputs.length, 1); assert.ok(rankInputs.every(input => input.documents.every(text => !text.includes('私密'))));
      const generationBefore = (await request(e, '/api/admin/rag/status', { token: admin })).data.generation;
      assert.equal((await request(d, '/api/admin/rag/reindex', { method: 'POST', token: admin, body: { force: true } })).status, 200);
      for (let i = 0; i < 8; i++) await Promise.all([d.runtime.retrieval.tick(), e.runtime.retrieval.tick()]);
      const rebuilt = (await request(e, '/api/admin/rag/status', { token: admin })).data;
      assert.notEqual(rebuilt.generation, generationBefore); assert.equal(rebuilt.ready, rebuilt.total);
      await get(d, '/api/kb/search?q=' + encodeURIComponent('赶上')); await get(e, '/api/kb/search?q=' + encodeURIComponent('赶上'));
      assert.equal(inputs.filter(batch => batch[0] === '赶上').length, 2);
      rankFailing = true;
      const failedRank = await get(e, '/api/kb/search?q=' + encodeURIComponent('赶上前车'));
      assert.equal(failedRank.data.mode, 'hybrid'); assert.equal(failedRank.data.rerank.fallback, 'unavailable');
      assert.equal(failedRank.data.items[0].document.id, document.id); rankFailing = false;
      await request(d, '/api/ai/config', { method: 'PUT', token: admin, body: { provider: 'rerank', enabled: false } });
      await request(d, `/api/kb/libraries/${library.id}/documents/${document.id}`, { method: 'DELETE', token });
      assert.equal((await d.runtime.pool.query('SELECT count(*)::int AS count FROM study_kb_embeddings WHERE document_id=$1', [document.id])).rows[0].count, 0);
      await e.runtime.retrieval.close();
      const update = await request(e, '/api/ai/config', { method: 'PUT', token: admin, body: { provider: 'embedding', model: 'new-vector-space' } }); assert.equal(update.status, 200);
      assert.equal((await get(e, '/api/kb/search?q=' + encodeURIComponent('追及问题'))).data.fallback, 'indexing');
      const restarted = await DistributedRuntime.open(bank, { ...configuration, embedding: { enabled: true, key: 'stale-environment-key', model: 'stale-environment-model' } }, { worker: false }); opened.push(restarted);
      assert.equal(await restarted.withQuestions(({ config }) => config.embedding.model), 'new-vector-space');
      assert.equal(await restarted.withQuestions(({ config }) => config.embedding.key), 'integration-embedding-key');
      const settings = await restarted.withQuestions(({ config }) => config.embedding), key = embeddingIndexKey(settings), store = restarted.retrieval.store;
      await store.sync(key); const oldLease = await store.claim(key, 1, 'expired-worker', 1000);
      await restarted.pool.query("UPDATE study_kb_embeddings SET lease_until=now()-interval '1 second' WHERE index_key=$1 AND worker='expired-worker'", [key]);
      const newLease = await store.claim(key, 1, 'replacement-worker', 1000);
      assert.equal(oldLease.length, 1); assert.equal(newLease.length, 1);
      assert.equal(newLease[0].document_id, oldLease[0].document_id); assert.equal(newLease[0].chunk_index, oldLease[0].chunk_index);
      // Work claims include private documents; visibility-filtered status must
      // not be used to verify a randomly selected document's lease completion.
      const leasedRow = async () => (await restarted.pool.query(
        'SELECT status,worker,embedding FROM study_kb_embeddings WHERE index_key=$1 AND document_id=$2 AND chunk_index=$3',
        [key, newLease[0].document_id, newLease[0].chunk_index])).rows[0];
      await store.complete(key, oldLease, [[1, 0]], 'expired-worker');
      assert.deepEqual(await leasedRow(), { status: 'working', worker: 'replacement-worker', embedding: null });
      await store.complete(key, newLease, [[0, 1]], 'replacement-worker');
      assert.deepEqual(await leasedRow(), { status: 'ready', worker: null, embedding: [0, 1] });
    } finally { hold = false; release.splice(0).forEach(resolve => resolve()); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  });
});
