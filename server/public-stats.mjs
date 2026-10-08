import { HttpError, MODULES } from './bank.mjs';

const DAY = 86400000;
const dateKey = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const shift = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const percent = (correct, total) => total ? Number((100 * correct / total).toFixed(1)) : null;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function publicStatsQuery(query = {}, now = Date.now()) {
  if (Object.keys(query).some(key => !['from', 'to', 'module'].includes(key))) throw new HttpError(400, '仅支持 from、to 和 module 查询参数。');
  const today = dateKey(now), to = query.to ?? today;
  if (!validDate(to)) throw new HttpError(400, 'to 必须是有效的 YYYY-MM-DD 日期。');
  const from = query.from ?? shift(to, -6), module = query.module ?? 'all';
  if (!validDate(from) || from > to || to > today || Date.parse(to) - Date.parse(from) >= 366 * DAY) {
    throw new HttpError(400, '日期范围须有效、不超过今天，且最多包含 366 天。');
  }
  if (module !== 'all' && !MODULES.includes(module)) throw new HttpError(400, '模块无效。');
  return { from, to, module };
}

function summary(rows) {
  const correct = rows.filter(row => row.correct).length, studyMs = rows.reduce((sum, row) => sum + row.humanMs, 0);
  return { answered: rows.length, correct, accuracy: percent(correct, rows.length),
    uniqueAnswered: new Set(rows.map(row => row.questionId)).size, studyMs,
    averageMs: rows.length ? Math.round(studyMs / rows.length) : null,
    sessions: new Set(rows.map(row => row.matchId)).size };
}

// Read the same revealed rounds and the same transaction snapshot as the study
// dashboard. Construct a compact public view; never serialize the match model.
export function publicStats(learning, range) {
  const { from, to, module } = range, now = learning.clock();
  const attempts = learning.attempts().filter(row => module === 'all' || row.module === module);
  const between = (start, end) => attempts.filter(row => { const date = dateKey(row.answeredAt); return date >= start && date <= end; });
  const rows = between(from, to), days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  const previousRange = { from: shift(from, -days), to: shift(from, -1) }, previous = summary(between(previousRange.from, previousRange.to));
  const current = summary(rows), profile = learning.profile();
  const duels = ['llm', 'jev'].map(mode => {
    const pairs = rows.flatMap(row => {
      const match = learning.matches.matches.get(row.matchId), round = match.rounds[row.index];
      return match.settings.mode === mode && typeof round.aiCorrect === 'boolean' ? [{ row, round }] : [];
    });
    const timed = pairs.filter(({ round }) => round.parallel === true && !round.aiTimingIncomplete
      && Number.isFinite(round.aiMs) && round.aiMs >= 0 && Number.isFinite(round.humanMs) && round.humanMs >= 0);
    const humanCorrect = pairs.filter(({ row }) => row.correct).length, aiCorrect = pairs.filter(({ round }) => round.aiCorrect).length;
    const humanMs = timed.reduce((sum, { round }) => sum + round.humanMs, 0), aiMs = timed.reduce((sum, { round }) => sum + round.aiMs, 0);
    return { mode, answered: pairs.length, humanCorrect, aiCorrect,
      humanAccuracy: percent(humanCorrect, pairs.length), aiAccuracy: percent(aiCorrect, pairs.length),
      timing: { compared: timed.length, excluded: pairs.length - timed.length, humanMs, aiMs,
        humanAverageMs: timed.length ? Math.round(humanMs / timed.length) : null,
        aiAverageMs: timed.length ? Math.round(aiMs / timed.length) : null } };
  });
  const grouped = new Map(), daily = new Map(), modules = new Map();
  for (const row of rows) {
    for (const [map, key] of [[grouped, row.matchId], [daily, dateKey(row.answeredAt)], [modules, row.module]]) {
      if (!map.has(key)) map.set(key, []); map.get(key).push(row);
    }
  }
  const recent = [...grouped].map(([id, attempts]) => ({ id, mode: learning.matches.matches.get(id).settings.mode,
    ...summary(attempts), lastAnsweredAt: attempts.at(-1).answeredAt, href: '/#record/' + encodeURIComponent(id) }))
    .sort((a, b) => Date.parse(b.lastAnsweredAt) - Date.parse(a.lastAnsweredAt)).slice(0, 5);
  return { schemaVersion: '1.0', timezone: 'Asia/Shanghai', asOf: new Date(now).toISOString(),
    range: { ...range, days, includesToday: to === dateKey(now) }, profile: { nickname: profile.nickname, dailyGoal: profile.dailyGoal },
    summary: current, previous: { range: previousRange, summary: previous,
      accuracyChangePoints: current.accuracy == null || previous.accuracy == null ? null : Number((current.accuracy - previous.accuracy).toFixed(1)) },
    activity: Array.from({ length: days }, (_, index) => { const date = shift(from, index); return { date, ...summary(daily.get(date) || []) }; }),
    modules: MODULES.map(name => ({ name, ...summary(modules.get(name) || []) })), duels, recent,
    lastAnsweredAt: rows.at(-1)?.answeredAt ?? null,
    scope: { revealedOnly: true, includesDemo: false, timing: 'parallel_complete_only', onlineStatusAvailable: false },
    links: { supervision: '/', history: '/#history', skill: '/skills/lizhi-study-observer/SKILL.md' } };
}
