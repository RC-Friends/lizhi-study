import crypto from 'node:crypto';

export const materialKey = question => {
  const content = question.material_html?.trim() || question.material?.trim() || '';
  return question.material_id ? `id:${question.material_id}` : content
    ? `content:${crypto.createHash('sha256').update(content).digest('hex')}` : `question:${question.id}`;
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const paperKey = occurrence => occurrence.raw_path === 'question-import/1.0'
  ? JSON.stringify(['import-material', occurrence.dataset])
  : JSON.stringify([occurrence.dataset, occurrence.paper_id || null,
    ...(occurrence.paper_id ? [] : [occurrence.paper_title, occurrence.source_url])]);

export function materialSources(questions) {
  const papers = new Map();
  for (const question of questions) for (const occurrence of question.occurrences || []) {
    if (!Number.isInteger(occurrence.question_number) || occurrence.question_number < 1) continue;
    const key = paperKey(occurrence);
    if (!papers.has(key)) papers.set(key, { key, positions: new Map() });
    const positions = papers.get(key).positions;
    positions.set(question.id, Math.min(positions.get(question.id) ?? Infinity, occurrence.question_number));
  }
  // The most complete source anchors a material's order. Stable source keys
  // break ties independently of input row order and process locale.
  return [...papers.values()].sort((a, b) => b.positions.size - a.positions.size || compare(a.key, b.key));
}

export function orderMaterialQuestions(questions) {
  if (questions.length < 2) return [...questions];
  const byId = new Map(questions.map(question => [question.id, question])), seen = new Set(), ordered = [];
  for (const { positions } of materialSources(questions)) {
    for (const [id] of [...positions].sort((a, b) => a[1] - b[1] || compare(a[0], b[0]))) {
      if (!seen.has(id)) { seen.add(id); ordered.push(byId.get(id)); }
    }
  }
  // Legacy inline materials without numbered provenance retain their supplied
  // order. Source variants append once, without splitting or dropping members.
  for (const question of questions) if (!seen.has(question.id)) ordered.push(question);
  return ordered;
}
