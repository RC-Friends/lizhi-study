import fs from 'node:fs';
import path from 'node:path';
import { HttpError, MODULES } from './bank.mjs';
import { scoreRounds } from './matches.mjs';
import { validateLearning } from './storage.mjs';

const PRIMARY = 'primary';
const DAY = 86400000;
// The study calendar is consistently China time, including on servers hosted abroad.
const dayKey = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const accuracy = (correct, answered) => answered ? Number((correct / answered * 100).toFixed(1)) : null;
const own = (object, key) => Object.hasOwn(object, key);
const safeMs = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const paginate = (items, { page = 1, pageSize = 20 } = {}) => {
  page = Number(page); pageSize = Number(pageSize);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, '分页参数无效。');
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, pages: Math.ceil(items.length / pageSize) };
};

export class LearningService {
  constructor(bank, matches, config, { persist = true, clock = Date.now } = {}) {
    this.bank = bank; this.matches = matches; this.persist = persist; this.clock = clock;
    this.storage = matches.storage;
    this.defaultName = typeof config.profileName === 'string' && config.profileName.trim() ? config.profileName.trim().slice(0, 24) : '备考同学';
    this.filename = config.learningPath || path.join(path.dirname(config.runtimePath), 'learning.json');
    this.data = { version: 1, profiles: {}, questions: {} };
    if (this.storage) this.data = structuredClone(validateLearning(this.storage.learning, bank));
    else if (persist && fs.existsSync(this.filename)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        if (saved.version !== 1 || !saved.profiles || !saved.questions) throw new Error('Invalid learning state');
        this.data = saved;
      } catch { throw new Error('学习资料文件无法读取；为避免覆盖原记录，请先检查 learning.json。'); }
    }
  }
  save(kind, ownerId, questionId) {
    this.memo?.clear();
    if (!this.persist) return;
    if (this.storage) {
      if (kind === 'profile') this.storage.saveProfile(ownerId, this.data.profiles[ownerId]);
      else this.storage.saveAnnotation(ownerId, questionId, this.data.questions[ownerId][questionId]);
      return;
    }
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  profile(ownerId = PRIMARY) {
    return { nickname: this.defaultName, dailyGoal: 30, examDate: '', ...this.data.profiles[ownerId] };
  }
  owned(ownerId = PRIMARY) {
    return [...this.matches.matches.values()].filter(match => match.ownerId === ownerId && !match.settings.demo);
  }
  requireOwned(id, ownerId = PRIMARY) {
    const match = this.matches.matches.get(id);
    if (!match || match.ownerId !== ownerId || match.settings.demo) throw new HttpError(404, '练习记录不存在。', 'record_not_found');
    return match;
  }
  attempts(ownerId = PRIMARY) {
    const key = `attempts:${ownerId}`; if (this.memo?.has(key)) return this.memo.get(key);
    const result = this.owned(ownerId).flatMap(match => match.rounds.flatMap((round, index) => round.phase === 'revealed' ? [{
      matchId: match.id, index, questionId: match.questionIds[index], module: this.bank.byId.get(match.questionIds[index]).module,
      choice: round.humanChoice, correct: Boolean(round.humanCorrect), humanMs: safeMs(round.humanMs),
      // Count the learner's answer on its submission date, even if AI finishes after midnight.
      answeredAt: round.submittedAt || round.completedAt || match.finishedAt || match.createdAt,
    }] : [])).sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt));
    this.memo?.set(key, result); return result;
  }
  annotations(ownerId = PRIMARY) { return this.data.questions[ownerId] || {}; }
  questionStats(ownerId = PRIMARY) {
    const key = `stats:${ownerId}`; if (this.memo?.has(key)) return this.memo.get(key);
    const stats = new Map();
    for (const attempt of this.attempts(ownerId)) {
      const value = stats.get(attempt.questionId) || { attempts: 0, correct: 0 };
      value.attempts++; value.correct += Number(attempt.correct);
      value.lastChoice = attempt.choice; value.lastCorrect = attempt.correct;
      value.lastAnsweredAt = attempt.answeredAt; value.lastHumanMs = attempt.humanMs;
      stats.set(attempt.questionId, value);
    }
    this.memo?.set(key, stats); return stats;
  }
  isMastered(stats, annotation = {}) {
    // A newly wrong answer reopens a manually mastered item.
    if (own(annotation, 'mastered') && Number.isInteger(annotation.masteredAttemptCount)) return annotation.masteredAttemptCount === (stats?.attempts || 0) ? annotation.mastered : Boolean(stats?.lastCorrect);
    if (own(annotation, 'mastered') && Date.parse(annotation.masteredAt || 0) >= Date.parse(stats?.lastAnsweredAt || 0)) return annotation.mastered;
    return Boolean(stats?.lastCorrect);
  }
  eligibleIds(scope = 'all', ownerId = PRIMARY) {
    if (!['all', 'unseen', 'wrong', 'bookmarked'].includes(scope)) throw new HttpError(400, '练习范围无效。');
    if (scope === 'all') return null;
    const stats = this.questionStats(ownerId), annotations = this.annotations(ownerId);
    return this.bank.rows.filter(q => scope === 'unseen' ? !stats.has(q.id)
      : scope === 'bookmarked' ? annotations[q.id]?.bookmarked
        : stats.has(q.id) && stats.get(q.id).correct < stats.get(q.id).attempts && !this.isMastered(stats.get(q.id), annotations[q.id])).map(q => q.id);
  }
  availability(input, ownerId = PRIMARY) {
    const settings = { modules: input.modules || MODULES, source: input.source || 'all', images: input.images || 'mixed' };
    const rows = this.bank.eligible(settings, { allowedQuestionIds: this.eligibleIds(input.scope || 'all', ownerId) });
    return { count: rows.length, modules: MODULES.map(name => ({ name, count: rows.filter(q => q.module === name).length })) };
  }
  summary(match) {
    const scores = scoreRounds(match.rounds, match.settings), completed = match.rounds.filter(round => round.phase === 'revealed');
    const latest = completed.at(-1);
    return { id: match.id, name: match.name, mode: match.settings.mode, status: match.status,
      count: match.questionIds.length, completed: scores.completed, correct: scores.human, accuracy: scores.humanAccuracy,
      aiAccuracy: scores.aiAccuracy, humanMs: completed.reduce((sum, round) => sum + safeMs(round.humanMs), 0),
      createdAt: match.createdAt, updatedAt: latest?.completedAt || latest?.submittedAt || match.createdAt,
      finishedAt: match.finishedAt || null, demo: Boolean(match.settings.demo), modules: match.settings.modules };
  }
  dashboard(ownerId = PRIMARY) {
    const attempts = this.attempts(ownerId), profile = this.profile(ownerId), today = dayKey(this.clock());
    const todayIndex = Date.parse(today), todayAttempts = attempts.filter(a => dayKey(a.answeredAt) === today);
    const weekStart = todayIndex - ((new Date(todayIndex).getUTCDay() + 6) % 7) * DAY;
    const todayCorrect = todayAttempts.filter(a => a.correct).length;
    const daily = new Map();
    for (const attempt of attempts) {
      const date = dayKey(attempt.answeredAt), row = daily.get(date) || { date, answered: 0, correct: 0, studyMs: 0 };
      row.answered++; row.correct += Number(attempt.correct); row.studyMs += attempt.humanMs; daily.set(date, row);
    }
    let streak = 0, cursor = todayIndex;
    if (!daily.has(today)) cursor -= DAY;
    while (daily.has(new Date(cursor).toISOString().slice(0, 10))) { streak++; cursor -= DAY; }
    const activity = Array.from({ length: 28 }, (_, index) => {
      const date = new Date(todayIndex - (27 - index) * DAY).toISOString().slice(0, 10);
      const row = daily.get(date) || { date, answered: 0, correct: 0, studyMs: 0 };
      return { ...row, accuracy: accuracy(row.correct, row.answered) };
    });
    const correct = attempts.filter(a => a.correct).length;
    const owned = this.owned(ownerId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { profile, summary: { answered: attempts.length, correct, accuracy: accuracy(correct, attempts.length),
      uniqueAnswered: new Set(attempts.map(a => a.questionId)).size, totalStudyMs: attempts.reduce((sum, a) => sum + a.humanMs, 0),
      todayAnswered: todayAttempts.length, todayCorrect, todayAccuracy: accuracy(todayCorrect, todayAttempts.length),
      weekAnswered: attempts.filter(a => Date.parse(dayKey(a.answeredAt)) >= weekStart && dayKey(a.answeredAt) <= today).length,
      streak, goalProgress: Math.min(100, Math.round(todayAttempts.length / profile.dailyGoal * 100)),
      daysToExam: profile.examDate ? Math.ceil((Date.parse(profile.examDate) - todayIndex) / DAY) : null }, activity,
      modules: MODULES.map(name => {
        const rows = attempts.filter(a => a.module === name), correct = rows.filter(a => a.correct).length;
        return { name, answered: rows.length, correct, accuracy: accuracy(correct, rows.length), uniqueAnswered: new Set(rows.map(a => a.questionId)).size,
          available: this.bank.rows.filter(q => q.module === name).length };
      }), counts: { wrong: this.eligibleIds('wrong', ownerId).length, bookmarked: this.eligibleIds('bookmarked', ownerId).length, unseen: this.eligibleIds('unseen', ownerId).length },
      recent: owned.filter(match => match.rounds.some(r => r.phase === 'revealed')).map(match => this.summary(match))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 8),
      active: [...this.matches.matches.values()].filter(match => match.ownerId === ownerId && match.status === 'active')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(match => this.summary(match)) };
  }
  publicDashboard() {
    const dashboard = this.dashboard(PRIMARY);
    // A guest sees study outcomes and the public profile, never a live question or private notebook state.
    return { profile: dashboard.profile, summary: dashboard.summary, activity: dashboard.activity, modules: dashboard.modules,
      recent: dashboard.recent, updatedAt: dashboard.recent[0]?.updatedAt || null };
  }
  history({ ownerId = PRIMARY, publicOnly = false, ...paging } = {}) {
    const items = this.owned(publicOnly ? PRIMARY : ownerId).filter(match => match.rounds.some(r => r.phase === 'revealed'))
      .map(match => this.summary(match)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return paginate(items, paging);
  }
  record(id, { ownerId = PRIMARY, publicOnly = false } = {}) {
    const match = this.requireOwned(id, publicOnly ? PRIMARY : ownerId);
    const completed = match.rounds.filter(r => r.phase === 'revealed');
    if (!completed.length) throw new HttpError(404, '本场暂时没有已揭晓的题目。', 'record_not_found');
    // Deliberately construct this view without serializing the live MatchService snapshot.
    const history = match.rounds.flatMap((round, index) => round.phase === 'revealed' ? [{
      index, question: this.bank.publicQuestion(match.questionIds[index]), ...this.bank.reveal(match.questionIds[index]),
      humanChoice: round.humanChoice, humanCorrect: round.humanCorrect, humanMs: round.humanMs,
      aiChoice: round.aiChoice ?? null, aiCorrect: round.aiCorrect ?? null, aiMs: round.aiMs ?? null,
      model: round.model || null, explanation: round.explanation || '', transcription: round.transcription || '',
      probabilities: round.probabilities || null, confidence: round.confidence ?? null,
      visualAssisted: Boolean(round.visualAssisted), parallel: Boolean(round.parallel), attempts: round.attempts,
      aiTimingIncomplete: Boolean(round.aiTimingIncomplete), submittedAt: round.submittedAt || null,
      completedAt: round.completedAt || round.submittedAt || null,
    }] : []);
    return { id: match.id, name: match.name, status: 'finished', originalStatus: match.status, current: null,
      revision: match.revision, settings: { mode: match.settings.mode, demo: false, scope: match.settings.scope || 'all',
        modules: match.settings.modules, count: match.questionIds.length, source: match.settings.source, images: match.settings.images },
      createdAt: match.createdAt, finishedAt: match.finishedAt || null, endReason: match.endReason || 'in_progress',
      index: history.at(-1).index, count: match.questionIds.length, scores: scoreRounds(completed, match.settings), history, model: match.model || null };
  }
  collection({ ownerId = PRIMARY, kind = 'wrong', module = 'all', search = '', mastered = 'all', includeMastered = false, ...paging } = {}) {
    if (!['wrong', 'bookmarked', 'all'].includes(kind)) throw new HttpError(400, '题集类型无效。');
    if (module !== 'all' && !MODULES.includes(module)) throw new HttpError(400, '题集模块无效。');
    if (typeof search !== 'string' || search.length > 100) throw new HttpError(400, '搜索词最多 100 字。');
    if (!['all', 'true', 'false', true, false].includes(mastered) || !['true', 'false', true, false].includes(includeMastered)) throw new HttpError(400, '掌握筛选无效。');
    const stats = this.questionStats(ownerId), annotations = this.annotations(ownerId);
    const ids = kind === 'all' ? [...new Set([...stats.keys(), ...Object.keys(annotations)])]
      : kind === 'wrong' && (includeMastered === true || includeMastered === 'true' || mastered === true || mastered === 'true')
        ? [...stats].filter(([, value]) => value.correct < value.attempts).map(([id]) => id) : this.eligibleIds(kind, ownerId);
    const query = search.trim().toLocaleLowerCase();
    const items = ids.filter(id => this.bank.byId.has(id)).map(questionId => {
      const item = stats.get(questionId), annotation = annotations[questionId] || {};
      return { questionId, question: this.bank.publicQuestion(questionId), ...(item ? this.bank.reveal(questionId) : {}),
        bookmarked: Boolean(annotation.bookmarked), note: annotation.note || '', mastered: this.isMastered(item, annotation),
        attempts: item?.attempts || 0, correct: item?.correct || 0, wrongCount: (item?.attempts || 0) - (item?.correct || 0), accuracy: accuracy(item?.correct || 0, item?.attempts || 0),
        lastChoice: item?.lastChoice || null, lastCorrect: item?.lastCorrect ?? null, lastAnsweredAt: item?.lastAnsweredAt || null,
        lastHumanMs: item?.lastHumanMs ?? null, updatedAt: annotation.updatedAt || item?.lastAnsweredAt || null };
    }).filter(item => (module === 'all' || item.question.module === module)
      && (mastered === 'all' || item.mastered === (mastered === true || mastered === 'true'))
      && (!query || [this.bank.byId.get(item.questionId).stem, this.bank.byId.get(item.questionId).material,
        ...Object.values(this.bank.byId.get(item.questionId).options), item.question.module, item.question.submodule, item.note].join(' ').toLocaleLowerCase().includes(query)))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    return paginate(items, paging);
  }
  questionMeta(id, ownerId = PRIMARY) {
    if (!this.bank.byId.has(id)) throw new HttpError(404, '题目不存在。');
    const annotation = this.annotations(ownerId)[id] || {}, stats = this.questionStats(ownerId).get(id);
    return { questionId: id, bookmarked: Boolean(annotation.bookmarked), note: annotation.note || '',
      mastered: this.isMastered(stats, annotation), attempts: stats?.attempts || 0, correct: stats?.correct || 0,
      accuracy: accuracy(stats?.correct || 0, stats?.attempts || 0), lastAnsweredAt: stats?.lastAnsweredAt || null };
  }
  updateQuestion(id, patch, ownerId = PRIMARY) {
    if (!this.bank.byId.has(id)) throw new HttpError(404, '题目不存在。');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['bookmarked', 'note', 'mastered'].includes(key))) throw new HttpError(400, '题目记录设置无效。');
    for (const key of ['bookmarked', 'mastered']) if (own(patch, key) && typeof patch[key] !== 'boolean') throw new HttpError(400, '题目标记须为布尔值。');
    if (own(patch, 'note') && (typeof patch.note !== 'string' || patch.note.length > 4000)) throw new HttpError(400, '笔记最多 4000 字。');
    if (own(patch, 'mastered') && !this.questionStats(ownerId).has(id)) throw new HttpError(400, '完成过的题目才能标记掌握。');
    const annotations = this.data.questions[ownerId] ||= {};
    const updatedAt = new Date(this.clock()).toISOString();
    const value = { ...annotations[id], ...patch, updatedAt, ...(own(patch, 'mastered') ? { masteredAt: updatedAt, masteredAttemptCount: this.questionStats(ownerId).get(id).attempts } : {}) };
    annotations[id] = value; this.save('annotation', ownerId, id);
    return { questionId: id, bookmarked: Boolean(value.bookmarked), note: value.note || '', mastered: this.isMastered(this.questionStats(ownerId).get(id), value), updatedAt };
  }
  updateProfile(patch, ownerId = PRIMARY) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['nickname', 'dailyGoal', 'examDate'].includes(key))) throw new HttpError(400, '学习目标设置无效。');
    if (own(patch, 'nickname') && (typeof patch.nickname !== 'string' || !patch.nickname.trim() || patch.nickname.trim().length > 24)) throw new HttpError(400, '昵称须为 1—24 字。');
    if (own(patch, 'dailyGoal') && (!Number.isInteger(patch.dailyGoal) || patch.dailyGoal < 1 || patch.dailyGoal > 500)) throw new HttpError(400, '每日目标须为 1—500 道整数。');
    if (own(patch, 'examDate') && (typeof patch.examDate !== 'string' || (patch.examDate !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.examDate) || !Number.isFinite(Date.parse(patch.examDate)) || new Date(patch.examDate).toISOString().slice(0, 10) !== patch.examDate)))) throw new HttpError(400, '考试日期无效。');
    this.data.profiles[ownerId] = { ...this.profile(ownerId), ...patch, ...(own(patch, 'nickname') ? { nickname: patch.nickname.trim() } : {}) };
    this.save('profile', ownerId); return this.profile(ownerId);
  }
}
