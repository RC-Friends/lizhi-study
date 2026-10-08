export const question = {
  id: 'test_question', module: '数量关系', submodule: '数学运算', question_type: 'single',
  source_type: '模拟题', year: 2025, province: '模拟', quality_flags: [],
  stem: '两本练习册共多少钱？', stem_html: '<p>两本练习册共多少钱？</p>',
  material: '每本练习册 12 元。', material_html: '<p>每本练习册 12 元。</p>',
  options: { A: '12 元', B: '18 元', C: '20 元', D: '24 元' },
  options_html: { A: '12 元', B: '18 元', C: '20 元', D: '24 元' },
  answer: ['D'], analysis: 'GOLD_SECRET_NEVER_SEND', analysis_html: '<p>GOLD_SECRET_NEVER_SEND：12×2=24。</p>',
  images: [], occurrences: [{ paper_title: '测试试卷', source_url: 'https://example.org/source' }],
};
export const settings = { mode: 'llm', demo: false, count: 1, modules: ['数量关系'], images: 'text', source: 'all' };
export const config = {
  llm: { key: 'test-private-key', model: 'test-vision', baseUrl: 'https://example.org/v1', vision: true, timeout: 1000, maxTokens: 1000 },
  jev: { key: 'jev-test-key', model: 'jev-latest', baseUrl: 'https://api.typesafe.ai/v1', timeout: 1000 },
  vision: { key: 'test-private-key', enabled: true, model: 'test-vision', baseUrl: 'https://example.org/v1', timeout: 1000 },
  maxConcurrent: 3, runtimePath: '/tmp/duel-test-unused', sitePassword: 'test-learner-password', jwtSecret: 'test-jwt-signing-secret-at-least-32-bytes',
};
export const result = (choice = 'A') => ({ choice, model: 'test-model', explanation: '测试用公开解题说明。', tool: { name: 'submit_answer', arguments: { choice } } });
export function streamingResponse(events, { crlf = false, split = false } = {}) {
  const separator = crlf ? '\r\n' : '\n';
  const text = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}${separator}${separator}`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
