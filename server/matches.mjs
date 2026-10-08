import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './bank.mjs';
import { providerCatalog } from './config.mjs';
import { runLlm, runJev, runDemo, ProviderError, llmBudgets } from './providers.mjs';
import { validateMatch } from './storage.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function scoreRounds(rounds, { mode } = {}) {
  const completed = rounds.filter(round => round.phase === 'revealed');
  const human = completed.filter(round => round.humanCorrect).length;
  const ai = completed.filter(round => round.aiCorrect).length;
  if (mode === 'practice') return { completed: completed.length, human, ai: null,
    humanAccuracy: completed.length ? Number((human / completed.length * 100).toFixed(1)) : null,
    aiAccuracy: null, bothCorrect: null, humanOnly: null, aiOnly: null, bothWrong: null,
    unscoredSubmissions: rounds.filter(round => round.humanChoice && round.phase !== 'revealed').length };
  return { completed: completed.length, human, ai,
    humanAccuracy: completed.length ? Number((human / completed.length * 100).toFixed(1)) : null,
    aiAccuracy: completed.length ? Number((ai / completed.length * 100).toFixed(1)) : null,
    bothCorrect: completed.filter(round => round.humanCorrect && round.aiCorrect).length,
    humanOnly: completed.filter(round => round.humanCorrect && !round.aiCorrect).length,
    aiOnly: completed.filter(round => !round.humanCorrect && round.aiCorrect).length,
    bothWrong: completed.filter(round => !round.humanCorrect && !round.aiCorrect).length,
    unscoredSubmissions: rounds.filter(round => round.humanChoice && round.phase !== 'revealed').length };
}

export class MatchService {
  constructor(bank, config, { providers = {}, persist = true, storage = null, dispatch = null } = {}) {
    this.bank = bank; this.config = config; this.persist = persist;
    this.storage = storage;
    this.dispatch = dispatch;
    this.matches = new Map(); this.listeners = new Map(); this.jobs = new Map();
    this.continuations = new Map(); // Ephemeral model-only context, never persisted or serialized.
    this.providers = { llm: runLlm, jev: runJev, demo: runDemo, ...providers };
    if (storage) {
      for (const match of storage.loadedMatches) {
        validateMatch(match, bank);
        this.restore(match);
      }
      storage.onFailure(() => this.shutdown());
    } else if (persist) {
      fs.mkdirSync(config.runtimePath, { recursive: true, mode: 0o700 });
      for (const filename of fs.readdirSync(config.runtimePath).filter(name => name.endsWith('.json'))) {
        try {
          const match = JSON.parse(fs.readFileSync(path.join(config.runtimePath, filename), 'utf8'));
          if (!match.id || !match.tokenHash || !match.questionIds.every(id => bank.byId.has(id))) continue;
          this.restore(match);
        } catch { /* Ignore incomplete/unrelated local files, without logging credentials. */ }
      }
    }
  }
  restore(match) {
    this.matches.set(match.id, match);
    const round = match.rounds[match.index];
    if (match.status === 'active' && (round?.aiStatus === 'running' || round?.phase === 'ai')) {
      round.aiMs = (round.aiMs || 0) + Math.max(0, Date.parse(round.aiCheckpointAt || round.aiStartedAt || now()) - Date.parse(round.aiAttemptStartedAt || round.aiStartedAt || now()));
      round.aiTimingIncomplete = true;
      round.aiStatus = 'error'; round.phase = round.humanChoice ? 'error' : 'human';
      round.error = '服务重新启动，请重试模型。已提交的答案会保留，本题尚未计分。';
      round.errorCode = 'server_restart';
      match.revision++; this.save(match);
    }
  }
  async flush() { if (this.storage) await this.storage.flush(); }
  save(match) {
    if (!this.persist) return;
    if (this.current(match)?.aiStatus === 'running') this.current(match).aiCheckpointAt = now();
    if (this.storage) { this.storage.saveMatch(match); return; }
    const destination = path.join(this.config.runtimePath, `${match.id}.json`);
    fs.writeFileSync(destination + '.tmp', JSON.stringify(match), { mode: 0o600 });
    fs.renameSync(destination + '.tmp', destination);
  }
  authenticate(id, token) {
    const match = this.matches.get(id);
    if (!match || !token || !equal(match.tokenHash, hash(token))) throw new HttpError(404, '对战不存在或当前浏览器无权访问。', 'match_not_found');
    return match;
  }
  current(match) { return match.rounds[match.index]; }
  newRound(mode) {
    const startedAt = now();
    return { phase: 'human', parallel: mode === 'llm', aiStatus: 'idle', startedAt, attempts: 0, aiMs: 0, explanation: '', transcription: '',
      ...(mode === 'practice' ? { activeHumanMs: 0, humanResumedAt: startedAt, pausedAt: null } : {}) };
  }
  requireCapacity() {
    if (this.jobs.size >= this.config.maxConcurrent) throw new HttpError(429, '竞技场目前较忙，请稍后再试。', 'arena_busy');
  }
  reveal(match) {
    const round = this.current(match);
    if (!round.humanChoice || round.aiStatus !== 'ready') return;
    const q = this.bank.byId.get(match.questionIds[match.index]);
    // Consult gold only once BOTH immutable submissions exist.
    round.humanCorrect = round.humanChoice === q.answer[0]; round.aiCorrect = round.aiChoice === q.answer[0];
    round.phase = 'revealed'; round.completedAt = now(); round.stage = 'complete'; round.stageLabel = '双方答案已锁定，结果已揭晓';
  }
  previousRequests(match) {
    const round = this.current(match);
    if (round.requests?.length) return round.requests;
    // Compatibility with sessions created before numeric diagnostics were saved.
    if (round.errorCode === 'output_limit' || round.error?.includes('超过长度上限')) {
      const stage = round.stage === 'choosing' ? 'choosing' : 'explaining';
      return [{ stage, finishReason: 'length', maxTokens: stage === 'choosing'
        ? match.settings.generation?.toolMaxTokens || 2048 : match.settings.generation?.maxTokens || 8192 }];
    }
    return [];
  }
  canRetry(match) {
    const round = this.current(match);
    if (match.status !== 'active' || round.phase !== 'error') return false;
    if (round.attempts < 3) return true;
    if (match.settings.demo || match.settings.mode !== 'llm') return false;
    const previous = this.previousRequests(match), last = previous.at(-1);
    if (last?.finishReason !== 'length') return false;
    const budgets = llmBudgets(this.bank.byId.get(match.questionIds[match.index]), this.config.llm, previous);
    return budgets[last.stage] > last.maxTokens;
  }
  snapshot(match) {
    const round = this.current(match);
    const scores = scoreRounds(match.rounds, match.settings), visible = Boolean(round.humanChoice);
    const history = match.rounds.flatMap((item, index) => item.phase === 'revealed' ? [{
      index, question: this.bank.publicQuestion(match.questionIds[index]), humanChoice: item.humanChoice,
      aiChoice: item.aiChoice, humanCorrect: item.humanCorrect, aiCorrect: item.aiCorrect,
      ...this.bank.reveal(match.questionIds[index]), humanMs: item.humanMs, aiMs: item.aiMs,
      model: item.model, explanation: item.explanation, transcription: item.transcription,
      probabilities: item.probabilities || null, confidence: item.confidence ?? null, visualAssisted: item.visualAssisted,
      requests: item.requests || [], parallel: Boolean(item.parallel), attempts: item.attempts, aiTimingIncomplete: Boolean(item.aiTimingIncomplete),
      submittedAt: item.submittedAt || null, completedAt: item.completedAt || item.submittedAt || null,
    }] : []);
    return {
      id: match.id, revision: match.revision, status: match.status, name: match.name,
      settings: match.settings, createdAt: match.createdAt, finishedAt: match.finishedAt || null,
      endReason: match.endReason || null, index: match.index, count: match.questionIds.length,
      scores, history, model: match.model,
      current: match.status === 'active' ? { index: match.index, question: this.bank.publicQuestion(match.questionIds[match.index]),
        phase: round.phase, parallel: Boolean(round.parallel), aiStatus: round.aiStatus || (round.phase === 'human' ? 'idle' : round.phase === 'revealed' ? 'ready' : round.phase === 'error' ? 'error' : 'running'),
        stage: visible ? round.stage || '' : '', stageLabel: visible ? round.stageLabel || '' : '',
        startedAt: round.startedAt, submittedAt: round.submittedAt || null, humanChoice: round.humanChoice || null,
        paused: Boolean(round.pausedAt), humanElapsedMs: round.humanChoice ? round.humanMs : round.activeHumanMs || 0,
        humanTimerStartedAt: round.pausedAt || round.humanChoice ? null : round.humanResumedAt || round.startedAt,
        humanMs: visible ? round.humanMs : null,
        aiStartedAt: visible ? round.aiStartedAt || null : null, aiAttemptStartedAt: visible ? round.aiAttemptStartedAt || round.aiStartedAt || null : null,
        aiMs: visible ? round.aiMs || 0 : null, progress: visible ? round.progress || null : null,
        explanation: visible ? round.explanation || '' : '', transcription: visible ? round.transcription || '' : '',
        error: visible ? round.error || null : null, errorCode: visible ? round.errorCode || (round.error?.includes('超过长度上限') ? 'output_limit' : null) : null,
        attempts: round.attempts, canRetry: this.canRetry(match), requests: visible ? round.requests || [] : [],
        result: round.phase === 'revealed' ? { ...this.bank.reveal(match.questionIds[match.index]),
          aiChoice: round.aiChoice, humanCorrect: round.humanCorrect, aiCorrect: round.aiCorrect,
          model: round.model, tool: round.tool, probabilities: round.probabilities || null,
          confidence: round.confidence ?? null, humanMs: round.humanMs, aiMs: round.aiMs,
          visualAssisted: round.visualAssisted, parallel: Boolean(round.parallel), attempts: round.attempts, aiTimingIncomplete: Boolean(round.aiTimingIncomplete) } : null,
      } : null,
    };
  }
  publish(match, type = 'snapshot', data = null, save = true) {
    match.revision++;
    if (save) this.save(match);
    const payload = data ? { ...data, revision: match.revision } : this.snapshot(match);
    const event = { id: match.revision, type, data: payload };
    const send = value => { for (const listener of this.listeners.get(match.id) || []) listener(value); };
    if (this.storage) {
      const captured = structuredClone(event);
      // Final answers and acknowledgement events cannot precede their DB commit.
      this.flush().then(() => send(captured)).catch(() => {});
    } else send(event);
  }
  subscribe(match, listener) {
    if (!this.listeners.has(match.id)) this.listeners.set(match.id, new Set());
    this.listeners.get(match.id).add(listener);
    return () => this.listeners.get(match.id)?.delete(listener);
  }
  create(input, { ownerId, allowedQuestionIds = null, composition = null } = {}) {
    this.storage?.assertHealthy();
    const mode = input.mode;
    if (!['llm', 'jev', 'practice'].includes(mode)) throw new HttpError(400, '请选择自主练习、LLM 或 JEV 模式。');
    if (input.demo !== undefined && typeof input.demo !== 'boolean') throw new HttpError(400, '演示设置无效。');
    const demo = mode !== 'practice' && input.demo === true;
    const catalog = providerCatalog(this.config);
    if (mode !== 'practice' && !demo && !catalog[mode].ready) throw new HttpError(409, `${mode === 'jev' ? 'JEV' : 'LLM'} 尚未配置服务端密钥。可先体验演示流程。`, 'provider_not_configured');
    const scope = input.scope || 'all';
    if (!['all', 'unseen', 'wrong', 'bookmarked', 'smart'].includes(scope) || (scope !== 'all' && allowedQuestionIds === null)) throw new HttpError(400, '练习范围无效，请重新组卷。');
    const settings = { mode, demo, scope, modules: input.modules, count: input.count, source: input.source || 'all', images: input.images || 'mixed' };
    if (scope === 'smart' && composition) settings.composition = composition;
    if (!demo && mode === 'llm') settings.generation = { thinking: this.config.llm.thinking || 'provider_default', reasoningEffort: this.config.llm.thinking === 'disabled' ? 'none' : this.config.llm.reasoningEffort || 'provider_default',
      maxTokens: this.config.llm.maxTokens, toolMaxTokens: this.config.llm.toolMaxTokens,
      imageMaxTokens: this.config.llm.imageMaxTokens || 32768, imageToolMaxTokens: this.config.llm.imageToolMaxTokens || 8192,
      maxRetryTokens: this.config.llm.maxRetryTokens || 65536 };
    if (mode !== 'practice' && !demo && settings.images !== 'text' && !catalog[mode].vision) throw new HttpError(400, '当前选手尚不能处理图片，请选择纯文字题。', 'vision_unavailable');
    const questionIds = this.bank.draw(settings, { allowedQuestionIds, requestedQuestionIds: input.questionIds });
    if (mode === 'llm') this.requireCapacity();
    const token = crypto.randomBytes(32).toString('base64url');
    const match = { id: crypto.randomUUID(), tokenHash: hash(token), revision: 1, status: 'active', index: 0,
      name: (typeof input.name === 'string' ? input.name.trim() : '').slice(0, 24) || '人类选手',
      settings, questionIds, questionFingerprints: questionIds.map(id => this.bank.fingerprints.get(id)),
      ...(ownerId ? { ownerId } : {}), model: mode === 'practice' ? null : demo ? `DEMO / ${mode.toUpperCase()}` : catalog[mode].model,
      createdAt: now(), rounds: [this.newRound(mode)] };
    this.matches.set(match.id, match); this.save(match);
    if (this.current(match).parallel) this.startJob(match);
    return { token, match: this.snapshot(match) };
  }
  requireActive(match, index) {
    this.storage?.assertHealthy();
    if (match.status !== 'active') throw new HttpError(409, '本场对战已经结束。');
    if (index !== match.index) throw new HttpError(409, '题目已切换，请刷新当前状态。', 'stale_round');
  }
  submit(match, { choice, index }) {
    this.requireActive(match, index);
    const round = this.current(match), q = this.bank.byId.get(match.questionIds[index]);
    if (!Object.hasOwn(q.options, choice)) throw new HttpError(400, '请选择一个有效选项。');
    if (round.phase !== 'human') {
      if (round.humanChoice === choice) return this.snapshot(match); // Duplicate click: no second bill.
      throw new HttpError(409, '你的答案已经锁定，不能修改。', 'answer_locked');
    }
    if (round.pausedAt) throw new HttpError(409, '本题已暂停，请先继续作答。', 'practice_paused');
    if (match.settings.mode !== 'practice' && !round.parallel) this.requireCapacity();
    round.humanChoice = choice; round.submittedAt = now();
    round.humanMs = match.settings.mode === 'practice'
      ? (round.activeHumanMs || 0) + Math.max(0, Date.now() - Date.parse(round.humanResumedAt || round.startedAt))
      : Math.max(0, Date.now() - Date.parse(round.startedAt));
    if (match.settings.mode === 'practice') {
      round.phase = 'revealed'; round.completedAt = now(); round.aiStatus = 'idle'; round.humanCorrect = choice === q.answer[0];
      round.aiChoice = null; round.aiCorrect = null; round.aiMs = null; round.model = null;
      round.stage = 'complete'; round.stageLabel = '答案已锁定，解析已揭晓'; this.publish(match);
    } else if (round.parallel) {
      round.phase = round.aiStatus === 'error' ? 'error' : 'ai';
      this.reveal(match); this.publish(match);
    } else this.startJob(match);
    return this.snapshot(match);
  }
  retry(match, { index }) {
    this.requireActive(match, index);
    const round = this.current(match);
    if (round.phase !== 'error') throw new HttpError(409, '当前不需要重试。');
    if (!this.canRetry(match)) throw new HttpError(409, '本题已达到重试或生成额度上限，请结束本场。');
    this.requireCapacity();
    this.startJob(match);
    return this.snapshot(match);
  }
  pause(match) {
    if (match.settings.mode !== 'practice') throw new HttpError(409, '人机对战双方同时计时，不能暂停。');
    if (match.status !== 'active') throw new HttpError(409, '本场练习已经结束。');
    const round = this.current(match);
    if (round.phase !== 'human' || round.pausedAt) return this.snapshot(match);
    round.activeHumanMs = (round.activeHumanMs || 0) + Math.max(0, Date.now() - Date.parse(round.humanResumedAt || round.startedAt));
    round.pausedAt = now(); this.publish(match); return this.snapshot(match);
  }
  resume(match) {
    if (match.settings.mode !== 'practice') throw new HttpError(409, '人机对战无需恢复计时。');
    if (match.status !== 'active') throw new HttpError(409, '本场练习已经结束。');
    const round = this.current(match);
    if (round.phase !== 'human' || !round.pausedAt) return this.snapshot(match);
    round.pausedAt = null; round.humanResumedAt = now(); this.publish(match); return this.snapshot(match);
  }
  startJob(match) {
    const index = match.index, round = this.current(match);
    const q = this.bank.byId.get(match.questionIds[index]);
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    const previousRequests = [...this.previousRequests(match)], contextKey = `${match.id}:${index}`;
    round.requests ||= [];
    round.phase = round.humanChoice ? 'ai' : 'human'; round.aiStatus = 'running';
    round.error = null; round.errorCode = null; round.progress = null; round.stage = 'preparing'; round.stageLabel = '模型正在独立作答';
    round.attempts++;
    round.aiStartedAt ||= round.parallel ? round.startedAt : now();
    round.aiAttemptStartedAt = round.attempts === 1 ? round.aiStartedAt : now();
    const started = Date.parse(round.aiAttemptStartedAt), previousMs = round.aiMs || 0;
    if (!round.explanationComplete) round.explanation = '';
    round.transcription = '';
    if (this.dispatch) {
      round.aiJobId = jobId;
      this.dispatch({ id: jobId, kind: 'answer', matchId: match.id, index, payload: { previousRequests } });
      this.publish(match);
      return;
    }
    this.jobs.set(match.id, { id: jobId, controller });
    this.publish(match);
    let lastSaved = Date.now();
    const valid = () => !controller.signal.aborted && !this.storage?.failure && match.status === 'active' && match.index === index && this.jobs.get(match.id)?.id === jobId;
    const context = { signal: controller.signal, previousRequests,
      savedExplanation: round.explanationComplete ? round.explanation : '',
      savedContinuation: round.explanationComplete ? this.continuations.get(contextKey) : null,
      saveContinuation: value => { if (valid()) { if (value) this.continuations.set(contextKey, value); else this.continuations.delete(contextKey); } },
      emit: (type, data) => {
        if (!valid()) return;
        if (type === 'phase') { round.stage = data.phase; round.stageLabel = data.label; round.progress = null; this.publish(match); }
        if (type === 'model_progress') {
          round.progress = { ...data, updatedAt: now() };
          const save = Date.now() - lastSaved > 5000;
          if (save) lastSaved = Date.now();
          if (round.humanChoice) this.publish(match, type, { progress: round.progress, index }, save);
          else if (save) this.save(match);
        }
        if (type === 'provider_request') { round.requests.push({ ...data, attempt: round.attempts }); this.save(match); }
        if (type === 'explanation_complete') { round.explanation = data.text; round.explanationComplete = true; this.publish(match); }
        if (type === 'explanation' || type === 'transcription') {
          round[type] = (round[type] || '') + data.text;
          const save = Date.now() - lastSaved > 750;
          if (save) lastSaved = Date.now();
          if (round.humanChoice) this.publish(match, type, { text: data.text, index }, save);
          else if (save) this.save(match);
        }
      } };
    const invoke = async () => {
      if (this.storage) await this.flush();
      if (!valid() || controller.signal.aborted) return;
      if (match.settings.demo) return this.providers.demo(q, match.settings.mode, context);
      if (match.settings.mode === 'jev') return this.providers.jev(q, this.config, context);
      return this.providers.llm(q, this.config.llm, context);
    };
    const task = invoke().then(async result => {
      if (!valid()) return;
      if (!Object.hasOwn(q.options, result.choice) || result.tool?.name !== 'submit_answer' || result.tool.arguments?.choice !== result.choice) throw new ProviderError('模型没有提交可验证的工具答案。');
      round.aiChoice = result.choice; round.tool = result.tool; round.model = result.model;
      round.aiMs = previousMs + Math.max(0, Date.now() - started); round.aiCompletedAt = now(); round.aiStatus = 'ready';
      round.explanation = result.explanation ?? round.explanation;
      round.probabilities = result.probabilities || null;
      round.confidence = result.confidence ?? null; round.visualAssisted = Boolean(result.visualAssisted);
      this.reveal(match);
      this.continuations.delete(contextKey);
      this.publish(match);
      await this.flush();
    }).catch(error => {
      if (!valid()) return;
      round.phase = round.humanChoice ? 'error' : 'human'; round.aiStatus = 'error';
      round.aiMs = previousMs + Math.max(0, Date.now() - started);
      round.errorCode = error instanceof ProviderError ? error.code : ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'connection_error';
      round.error = error instanceof ProviderError ? error.message : ['TimeoutError', 'AbortError'].includes(error.name)
        ? '模型响应超时。你的答案已保留，本题尚未计分，可以重试。' : '模型连接暂时中断。你的答案已保留，请重试。';
      this.publish(match);
    }).finally(() => { if (this.jobs.get(match.id)?.id === jobId) this.jobs.delete(match.id); });
    this.jobs.get(match.id).task = task;
  }
  next(match, { index }) {
    this.requireActive(match, index);
    if (this.current(match).phase !== 'revealed') throw new HttpError(409, '请等待双方完成并揭晓本题答案。');
    if (index === match.questionIds.length - 1) return this.finish(match, 'completed');
    if (match.settings.mode === 'llm') this.requireCapacity();
    this.continuations.delete(`${match.id}:${index}`);
    match.index++; match.rounds.push(this.newRound(match.settings.mode));
    if (this.current(match).parallel) this.startJob(match);
    else this.publish(match);
    return this.snapshot(match);
  }
  finish(match, reason = 'manual') {
    if (match.status === 'finished') return this.snapshot(match);
    match.status = 'finished'; match.finishedAt = now(); match.endReason = reason;
    this.jobs.get(match.id)?.controller.abort();
    this.continuations.delete(`${match.id}:${match.index}`);
    this.publish(match); return this.snapshot(match);
  }
  shutdown() { for (const job of this.jobs.values()) job.controller.abort(); this.continuations.clear(); }
}
