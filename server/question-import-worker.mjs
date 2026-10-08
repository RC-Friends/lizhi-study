import { parentPort, workerData } from 'node:worker_threads';
import { parseQuestionLines, validateCanonical, validateImport, ImportError } from './question-import.mjs';
try {
  const result = workerData.operation === 'document' ? validateImport(workerData.document)
    : validateCanonical(parseQuestionLines(Buffer.from(workerData.bytes)), { activeFingerprints: workerData.activeFingerprints });
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof ImportError ? { issues: error.issues, status: error.status, code: error.code }
    : { issues: [{ path: '', message: '题库校验失败。' }], status: 422, code: 'invalid_question_import' } });
}
