import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { QuestionBank } from '../../server/bank.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { checkObserverSkill } from './observer-e2e.mjs';

const base=process.env.E2E_BASE_URL, password=process.env.E2E_PASSWORD;
if(!base || !['127.0.0.1','localhost'].includes(new URL(base).hostname) || !password) throw new Error('Use E2E_BASE_URL pointing to an isolated loopback stack and its E2E_PASSWORD.');
const bank=new QuestionBank(process.env.E2E_BANK_PATH || 'data/xingce/questions.jsonl');
const candidates=[process.env.BROWSER_PATH,'/usr/bin/chromium','/usr/bin/google-chrome'];
for(const folder of await fs.readdir(path.join(os.homedir(),'.cache/ms-playwright')).catch(()=>[])) if(folder.startsWith('chromium-')) candidates.push(path.join(os.homedir(),'.cache/ms-playwright',folder,'chrome-linux64/chrome'));
let executablePath;for(const candidate of candidates.filter(Boolean))try{await fs.access(candidate);executablePath=candidate;break;}catch{}
if(!executablePath)throw new Error('Set BROWSER_PATH to Chromium.');
await fs.mkdir('test-results',{recursive:true});
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const errors=[],failed=[],checks=[];let page;
const watch=p=>{p.setDefaultTimeout(25000);p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=400 && !(r.status()===401 && r.url().endsWith('/api/login')))failed.push(`${r.status()} ${new URL(r.url()).pathname}`);});};
const visible=(p,selector)=>p.locator(selector).first().waitFor({state:'visible'});
const nav=(p,name)=>p.locator('.lh-sidebar nav').getByRole('button',{name});
async function screenshot(p,name){const width=await p.evaluate(()=>({viewport:innerWidth,actual:document.documentElement.scrollWidth}));assert.ok(width.actual<=width.viewport+1,`${name}: horizontal overflow`);await p.screenshot({path:`test-results/stack-${name}.png`,fullPage:true});}
async function login(p){await p.getByRole('button',{name:'考生登录',exact:true}).click();await p.getByLabel('学习口令',{exact:true}).fill(password);await p.getByRole('button',{name:'进入我的学习中心'}).click();await visible(p,'.lh-user');}
async function state(p){return p.evaluate(async()=>{const s=JSON.parse(localStorage.getItem('xingce-study.session.v1'));const id=location.hash.split('/')[1];return(await fetch(`/api/matches/${id}`,{headers:{Authorization:`Bearer ${s.token}`}})).json();});}
async function setup(p,{mode='practice',images='visual',count=2}={}){await nav(p,'开始练习').click();await visible(p,'.lh-setup');if(mode!=='practice'){await p.locator('.lh-mode-card').filter({hasText:mode==='llm'?'与小栗对战':'JEV 决策模型'}).click();await p.getByRole('switch',{name:'演示模式'}).click();}await p.getByRole('spinbutton',{name:'自定义题量'}).fill(String(count));await p.getByLabel('图文类型',{exact:true}).selectOption(images);await p.locator('.lh-availability').filter({hasText:'当前条件可出'}).waitFor();await p.locator('.lh-setup-bottom').getByRole('button',{name:mode==='practice'?'开始练习':'开始演示对战',exact:true}).click();await visible(p,'.question-stem');}
async function answer(p,choice,label){await p.locator('.answer-option').nth('ABCD'.indexOf(choice)).locator('.option-letter').click();await p.getByRole('button',{name:label,exact:true}).click();await visible(p,'.round-reveal');}
async function home(p){const button=p.locator('.report-actions').getByRole('button',{name:'返回学习中心',exact:true});if(await button.count())await button.click();else if(await p.locator('.lh-brand').count())await p.locator('.lh-brand').click();else await p.locator('.brand').click();await visible(p,'.lh-welcome');}
async function images(p){await p.waitForFunction(()=>{const imgs=[...document.querySelectorAll('.question-card img')];return imgs.length&&imgs.every(x=>x.complete&&x.naturalWidth>0);});}
try{
 const context=await browser.newContext({viewport:{width:1440,height:1050}});page=await context.newPage();watch(page);await page.goto(base);await visible(page,'.lh-welcome.public');await screenshot(page,'desktop-guest');
 await login(page);await page.reload();await visible(page,'.lh-user');
 await page.getByRole('button',{name:'打开学习设置'}).click();await page.getByLabel('公开昵称',{exact:true}).fill('容器验收同学');await page.locator('#profile-goal').fill('3');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('已保存，按自己的节奏来',{exact:true}).waitFor();await nav(page,'学习概览').click();
 const observerContext=await browser.newContext({viewport:{width:1200,height:900}});const observer=await observerContext.newPage();watch(observer);await observer.goto(base);await visible(observer,'.lh-welcome.public');
 const before=await observer.evaluate(async()=>(await fetch('/api/public/dashboard')).json());
 await setup(page);await images(page);const first=await state(page),mid=first.id,qid=first.current.question.id;
 const img=page.locator('.question-stem img,.material-panel img');if(await img.count())await img.first().click();else await page.locator('.option-zoom').first().click();await visible(page,'.image-dialog[open]');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'收藏这道题',exact:true}).click();await page.getByRole('button',{name:'已收藏',exact:true}).waitFor();await page.getByRole('button',{name:'我的笔记',exact:true}).click();await page.locator('.note-editor textarea').fill('PRIVATE_STACK_NOTE：检查条件');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await page.getByRole('button',{name:'已保存',exact:true}).waitFor();
 const gold=bank.byId.get(qid).answer[0];await answer(page,gold==='A'?'B':'A','提交答案，看解析');assert.equal((await state(page)).current.result.humanCorrect,false);
 await observer.locator('.lh-stat').filter({hasText:'累计完成'}).locator('strong').filter({hasText:String(before.summary.answered+1)}).waitFor();
 const expectedAccuracy=Number((before.summary.correct/(before.summary.answered+1)*100).toFixed(1))+'%';
 assert.equal(await observer.locator('.lh-stat').filter({hasText:'总正确率'}).locator('strong').textContent(),expectedAccuracy);
 await observerContext.close();checks.push('public supervision updates answered count and correct-rate within one revision poll without reloading');
 await screenshot(page,'desktop-practice');
 await page.getByRole('button',{name:'确认，下一题',exact:true}).click();await visible(page,'.human-submit');await home(page);
 await page.locator('.lh-resume').getByRole('button',{name:'继续做题'}).click();await visible(page,'.human-submit');const second=await state(page);assert.equal(second.index,1);await answer(page,bank.byId.get(second.current.question.id).answer[0],'提交答案，看解析');await page.getByRole('button',{name:'完成练习，查看报告'}).click();await visible(page,'.practice-report');assert.equal((await state(page)).scores.humanAccuracy,50);await screenshot(page,'desktop-report');await home(page);
 checks.push('JWT refresh, shared profile, SeaweedFS images and zoom, bookmarks/private notes, wrong answer, next and pause/resume, 50% report');
 await nav(page,/错题本/).click();await visible(page,'.lh-notebook-item');await page.getByRole('textbox',{name:'搜索题目'}).fill('PRIVATE_STACK_NOTE');await page.waitForResponse(r=>r.url().includes('/api/learning/questions?')&&r.url().includes('PRIVATE_STACK_NOTE'));assert.equal(await page.locator('.lh-notebook-item').count(),1);await page.locator('.lh-notebook-item summary').click();await page.getByRole('button',{name:'标记掌握',exact:true}).click();await visible(page,'.lh-empty');await page.getByRole('checkbox',{name:'包括已掌握'}).check();await visible(page,'.lh-notebook-item');await screenshot(page,'desktop-notebook');
 await home(page);await setup(page,{mode:'llm',images:'visual',count:2});await images(page);const sealed=await state(page);assert.equal(sealed.current.parallel,true);assert.equal(sealed.current.explanation,'');
 await answer(page,'A','提交答案，查看 AI');let result=await state(page);assert.ok(result.current.result.aiMs>=0);assert.ok(result.current.result.humanMs>=0);await visible(page,'.timing-comparison');
 await page.getByRole('button',{name:'用简单的话讲讲这题'}).click();await page.locator('.coach-message.assistant').filter({hasText:'演示回复'}).waitFor();await screenshot(page,'desktop-duel');
 // A reconnect can first observe the worker's reserved busy flag. It must recover without another paid POST.
 let pendingSnapshot=true;const coachRoute='**/api/matches/*/coach?index=0';
 await page.route(coachRoute,async route=>{if(!pendingSnapshot)return route.continue();pendingSnapshot=false;const response=await route.fetch();const data=await response.json();await route.fulfill({response,json:{...data,busy:true}});});
 await page.reload();await visible(page,'.coach-recovery');await page.waitForFunction(()=>!document.querySelector('.coach-recovery')&&!document.querySelector('.coach-prompts button')?.disabled);await page.unroute(coachRoute);
 checks.push('coach reconnect automatically clears a recovered busy state without submitting another message');
 await page.getByRole('button',{name:'确认，下一题',exact:true}).click();await page.getByRole('heading',{name:'AI 已交卷，等你。'}).waitFor();assert.equal((await state(page)).current.explanation,'');await page.reload();await page.getByRole('heading',{name:'AI 已交卷，等你。'}).waitFor();assert.equal(await page.locator('.tool-receipt,.stream-text').count(),0);await answer(page,'B','提交答案，查看 AI');result=await state(page);assert.ok(result.current.result.humanMs>result.current.result.aiMs);await page.getByRole('button',{name:'完成对战，查看战报'}).click();await visible(page,'.report-page');await home(page);
 checks.push('real Nginx SSE across replicas, concurrent multimodal demo, sealed AI through refresh, independent timing, distributed coach, explicit next');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await visible(page,'.lh-welcome.public');await page.goto(`${base}/#record/${mid}`);await visible(page,'.reading-note');await page.locator('.review-item summary').first().click();assert.equal(await page.locator('.review-private-tools,.question-notebook,.coach-panel').count(),0);assert.ok(!(await page.locator('body').textContent()).includes('PRIVATE_STACK_NOTE'));await screenshot(page,'desktop-public-record');
 const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mobile=await mobileContext.newPage();page=mobile;watch(mobile);await mobile.goto(base);await visible(mobile,'.lh-welcome.public');await screenshot(mobile,'mobile-guest');await login(mobile);
 for(const name of ['开始练习',/错题本/,/收藏夹/,'学习记录','公开监督','AI 监督','学习概览']){await nav(mobile,name).click();await screenshot(mobile,'mobile-'+String(name).replace(/[^a-zA-Z\u4e00-\u9fff]/g,''));}
 await setup(mobile,{mode:'jev',images:'visual',count:2});await images(mobile);await answer(mobile,'A','锁定答案，轮到 AI');await visible(mobile,'.probabilities');await screenshot(mobile,'mobile-jev');await mobile.getByRole('button',{name:'确认，下一题',exact:true}).click();await visible(mobile,'.human-submit');await mobile.getByRole('button',{name:'结束本场'}).click();await mobile.getByRole('button',{name:'结束并查看报告'}).click();await visible(mobile,'.report-page');assert.equal((await state(mobile)).scores.completed,1);await home(mobile);
 await setup(mobile,{mode:'llm',images:'visual',count:1});await images(mobile);await mobile.getByRole('heading',{name:'AI 已交卷，等你。'}).waitFor();await answer(mobile,'C','提交答案，查看 AI');await visible(mobile,'.timing-comparison');await screenshot(mobile,'mobile-timing');await mobile.getByRole('button',{name:'完成对战，查看战报'}).click();await visible(mobile,'.report-page');
 checks.push('guest privacy, 390px navigation without overflow, image questions, JEV probabilities and early finish, mobile LLM timing/report');
 if(process.env.E2E_IMPORT_SOURCE && process.env.E2E_IMPORT_TOKEN){
  await home(mobile);await nav(mobile,'开始练习').click();await visible(mobile,'.lh-setup');
  const beforeImport=await mobile.evaluate(async()=>(await fetch('/api/catalog')).json());
  const published=JSON.parse(execFileSync(process.execPath,['scripts/publish-question-import.mjs',`--source=${process.env.E2E_IMPORT_SOURCE}`,`--url=${base}`],
    {encoding:'utf8',env:{...process.env,QUESTION_IMPORT_TOKEN:process.env.E2E_IMPORT_TOKEN},timeout:120000}));
  assert.equal(published.active,true);assert.equal(published.restartRequired,false);
  await mobile.locator('.lh-availability strong').filter({hasText:String(beforeImport.bank.total+3)}).waitFor();
  // Compact mobile chips intentionally hide their count; the visible
  // availability total above verifies the user-facing update.
  assert.equal(await mobile.locator('.module-chips button').filter({hasText:'数量关系'}).locator('span').textContent(),String(beforeImport.bank.modules.find(m=>m.name==='数量关系').count+1));
  await screenshot(mobile,'mobile-live-import');checks.push('operator CLI uploads through Nginx; active study UI refreshes catalog and availability without reload or backend restart');
 }
 await checkObserverSkill({browser,base,screenshot});checks.push('guest skill navigation, public HTTPS origin binding, real clipboard and Markdown/ZIP downloads, anonymous statistics, retry and 390px layout');
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);await fs.writeFile('test-results/stack-results.json',JSON.stringify({passed:true,checks,pageErrors:errors,failedRequests:failed,paidModelCalls:0},null,2));console.log(JSON.stringify({passed:true,checks,pageErrors:errors,failedRequests:failed}));
}catch(error){await page?.screenshot({path:'test-results/stack-failure.png',fullPage:true}).catch(()=>{});await fs.writeFile('test-results/stack-failure.json',JSON.stringify({error:error.message,errors,failed},null,2));throw error;}finally{await browser.close();}
