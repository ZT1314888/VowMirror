import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PHASE7_POLICY = Object.freeze({
  provider: 'chuanapi', model: 'gpt-image-2.5-flare', maxAttempts: 3, maxDurationMs: 90_000,
  minimumQualified: 4,
  matrix: Object.freeze([
    ['G1', 'C001', 'W001', 'left', 'original', null],
    ['G2', 'C002', 'W002', 'left', 'upload', 'S004'],
    ['G3', 'C001', 'W003', 'right', 'original', null],
    ['G4', 'C002', 'W004', 'right', 'upload', 'S006'],
    ['G5', 'C001', 'W005', 'left', 'upload', 'S001'],
  ].map(row => Object.freeze(Object.fromEntries(['id', 'coupleId', 'outfitId', 'dressSide', 'sceneMode', 'sceneId'].map((key, index) => [key, row[index]]))))),
});
const CRITERIA = ['identity', 'outfit', 'shoes', 'noMix', 'fullBody', 'scene'];
const OUTCOMES = ['success', 'provider_error', 'timeout', 'cancelled'];
const OBSERVATIONS = ['observed', 'not_observed', 'unobservable'];
const ATTEMPT_KEYS = ['number', 'authorization', 'outcome', 'durationMs', 'requestId', 'providerModelStatus', 'providerModel', 'providerRequestId', 'outputReviewed', 'assessment', 'lateResponse', 'resourcesReleased'];
const DIAGNOSTIC_BATCH_KEYS = ['batchId', 'caseId', 'promptSha256', 'realModelCalls', 'results'];
const DIAGNOSTIC_RESULT_KEYS = ['id', 'durationMs', 'requestId', 'outcome', 'providerModelStatus', 'providerModel', 'providerRequestId', 'mime', 'width', 'height', 'imageSha256', 'outputReviewed', 'assessment'];

function object(value, keys, label, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  if (Object.keys(value).some(key => !keys.includes(key))) errors.push(`${label} contains unsupported fields`);
  return true;
}
function identifier(value, label, errors, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || /sk-|AIza|bearer/i.test(value)) errors.push(`${label} must be an anonymous identifier`);
}
function authorization(value, label, errors) {
  if (!object(value, ['reference', 'approvedAt'], label, errors)) return;
  if (typeof value.reference !== 'string' || !/^chat-\d{4}-\d{2}-\d{2}(?:-[A-Za-z0-9_-]+)?$/.test(value.reference) || /sk-|AIza|bearer/i.test(value.reference)) errors.push(`${label} requires a dated anonymous instruction reference`);
  if (typeof value.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.approvedAt) || Number.isNaN(Date.parse(value.approvedAt))) errors.push(`${label} requires an approval timestamp`);
}
function modelStatus(model) {
  if (model === null) return 'not_provided';
  if (model === PHASE7_POLICY.model) return 'reported_alias';
  const suffix = typeof model === 'string' ? model.slice(PHASE7_POLICY.model.length) : '';
  const timestamp = Date.parse(suffix.slice(1));
  if (typeof model === 'string' && model.startsWith(PHASE7_POLICY.model) && /^-\d{4}-\d{2}-\d{2}$/.test(suffix) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === suffix.slice(1)) return 'reported_snapshot';
  return 'mismatch';
}
function attempt(record, label, index, errors, cancellation = false) {
  const keys = cancellation ? [...ATTEMPT_KEYS, 'inputCaseId', 'browserStopped', 'backendCancelled'] : ATTEMPT_KEYS;
  if (!object(record, keys, label, errors)) return { reviewed: false, passed: false, pending: true };
  if (record.number !== index + 1) errors.push(`${label} has a non-sequential attempt number`);
  authorization(record.authorization, `${label} authorization`, errors);
  if (!OUTCOMES.includes(record.outcome)) errors.push(`${label} has an invalid outcome`);
  if (!Number.isSafeInteger(record.durationMs) || record.durationMs < 0) errors.push(`${label} requires elapsed milliseconds including preparation and decoding`);
  identifier(record.requestId, `${label} requestId`, errors, record.outcome !== 'success');
  identifier(record.providerRequestId, `${label} providerRequestId`, errors, true);
  const version = modelStatus(record.providerModel);
  if (record.providerModelStatus !== version || version === 'mismatch') errors.push(`${label} provider model declaration is inconsistent or mismatched`);
  const terminated = ['timeout', 'cancelled'].includes(record.outcome);
  if (terminated) {
    if (object(record.lateResponse, ['observation', 'isolated'], `${label} lateResponse`, errors)) {
      if (!OBSERVATIONS.includes(record.lateResponse.observation)) errors.push(`${label} requires a late-response observation state`);
      const isolated = record.lateResponse.isolated;
      if (record.lateResponse.observation === 'observed' ? typeof isolated !== 'boolean' : isolated !== null) errors.push(`${label} late-response isolation must distinguish unobserved from failed`);
    }
    if (typeof record.resourcesReleased !== 'boolean') errors.push(`${label} requires local resource-release evidence`);
  } else if (record.lateResponse !== undefined || record.resourcesReleased !== undefined) {
    errors.push(`${label} termination evidence requires timeout or cancellation`);
  }
  if (typeof record.outputReviewed !== 'boolean') errors.push(`${label} requires an explicit review state`);
  const reviewed = record.outcome === 'success' && record.outputReviewed === true;
  if (reviewed) {
    if (object(record.assessment, CRITERIA, `${label} assessment`, errors)) {
      if (CRITERIA.some(key => typeof record.assessment[key] !== 'boolean')) errors.push(`${label} requires all six manual criteria`);
    }
  } else if (record.assessment !== undefined && record.assessment !== null) errors.push(`${label} must not claim quality scores before review`);
  if (record.outcome !== 'success' && record.outputReviewed !== false) errors.push(`${label} has no output to review`);
  return {
    reviewed,
    pending: record.outcome === 'success' && !reviewed,
    passed: reviewed && record.durationMs <= PHASE7_POLICY.maxDurationMs && CRITERIA.every(key => record.assessment?.[key] === true),
  };
}

function diagnosticBatches(value, errors, requestIds) {
  const review = { reviewed: false };
  if (!Array.isArray(value)) {
    errors.push('diagnosticBatches must be an array');
    return review;
  }
  const batchIds = new Set();
  for (const batch of value) {
    if (!object(batch, DIAGNOSTIC_BATCH_KEYS, 'diagnostic batch', errors)) continue;
    identifier(batch.batchId, 'diagnostic batchId', errors);
    if (batchIds.has(batch.batchId)) errors.push('diagnostic batch identifiers must be unique');
    batchIds.add(batch.batchId);
    if (batch.caseId !== 'G2' || typeof batch.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(batch.promptSha256)) errors.push('diagnostic batch must identify G2 and an anonymous prompt hash');
    if (!Array.isArray(batch.results) || batch.realModelCalls !== batch.results.length) {
      errors.push('diagnostic batch call count must match its results');
      continue;
    }
    const diagnosticIds = new Set();
    for (const result of batch.results) {
      if (!object(result, DIAGNOSTIC_RESULT_KEYS, 'diagnostic result', errors)) continue;
      identifier(result.id, 'diagnostic result id', errors);
      if (diagnosticIds.has(result.id)) errors.push('diagnostic result identifiers must be unique within a batch');
      diagnosticIds.add(result.id);
      if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0 || result.outcome !== 'success') errors.push('diagnostic results require successful calls and elapsed milliseconds');
      identifier(result.requestId, 'diagnostic requestId', errors);
      if (requestIds.has(result.requestId)) errors.push('server request identifiers must be unique');
      requestIds.add(result.requestId);
      const version = modelStatus(result.providerModel);
      if (result.providerModelStatus !== version || version === 'mismatch') errors.push('diagnostic provider model declaration is inconsistent or mismatched');
      identifier(result.providerRequestId, 'diagnostic providerRequestId', errors, true);
      if (result.mime !== 'image/png' || result.width !== 1536 || result.height !== 1024) errors.push('diagnostic image metadata must match the fixed PNG output');
      if (typeof result.outputReviewed !== 'boolean') errors.push('diagnostic output requires an explicit manual review state');
      if (result.imageSha256 !== null && (typeof result.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.imageSha256))) errors.push('diagnostic image hash must be an anonymous SHA-256 or null');
      if (result.outputReviewed && result.imageSha256 === null) errors.push('diagnostic image must be retained locally before manual review');
      if (result.outputReviewed) {
        if (object(result.assessment, CRITERIA, 'diagnostic assessment', errors)) {
          if (CRITERIA.some(key => typeof result.assessment[key] !== 'boolean')) errors.push('diagnostic assessment requires all six manual criteria');
          else review.reviewed = true;
        }
      } else if (result.assessment !== null) errors.push('diagnostic assessment must remain null before manual review');
    }
  }
  return review;
}

export function evaluateReport(report) {
  const errors = [];
  const pending = [];
  const result = { errors, pending, ready: false, adjudicableGroups: 0, qualifiedGroups: 0 };
  if (!object(report, ['model', 'cases', 'diagnosticBatches', 'cancellation', 'controlledValidation', 'naturalProviderTimeout'], 'report', errors)) return result;
  if (object(report.model, ['provider', 'name'], 'model', errors) && (report.model.provider !== PHASE7_POLICY.provider || report.model.name !== PHASE7_POLICY.model)) errors.push('model must match the approved provider and requested model');
  if (!Array.isArray(report.cases) || report.cases.length !== PHASE7_POLICY.matrix.length) {
    errors.push('report must contain the five approved cases');
    return result;
  }
  const attempts = [];
  const caseEvaluations = PHASE7_POLICY.matrix.map(() => []);
  report.cases.forEach((record, index) => {
    const expected = PHASE7_POLICY.matrix[index];
    if (!object(record, [...Object.keys(expected), 'attempts'], expected.id, errors)) return;
    if (Object.keys(expected).some(key => record[key] !== expected[key])) errors.push(`${expected.id} must match the approved input combination`);
    if (!Array.isArray(record.attempts) || record.attempts.length > PHASE7_POLICY.maxAttempts) {
      errors.push(`${expected.id} exceeds the attempt limit or lacks an attempts array`);
      return;
    }
    const evaluated = record.attempts.map((value, number) => attempt(value, `${expected.id} attempt ${number + 1}`, number, errors));
    caseEvaluations[index] = evaluated;
    if (evaluated.some(value => value.reviewed)) result.adjudicableGroups++;
    if (evaluated.some(value => value.passed)) result.qualifiedGroups++;
    if (evaluated.some(value => value.pending)) pending.push(`${expected.id} needs a completed manual review`);
    const firstPass = evaluated.findIndex(value => value.passed);
    if (firstPass >= 0 && firstPass < evaluated.length - 1) errors.push(`${expected.id} must stop after its first qualified attempt`);
    attempts.push(...record.attempts);
  });
  const diagnosticRequestIds = new Set(attempts.map(value => value?.requestId).filter(value => typeof value === 'string'));
  const diagnosticReview = diagnosticBatches(report.diagnosticBatches, errors, diagnosticRequestIds);
  if (diagnosticReview.reviewed && !caseEvaluations[1].some(value => value.reviewed)) result.adjudicableGroups++;
  if (diagnosticReview.reviewed) {
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].startsWith('G2 needs a completed manual review')) pending.splice(index, 1);
    }
  }
  if (report.cancellation === null) pending.push('real cancellation has not been authorized and verified');
  else {
    const record = report.cancellation;
    attempt(record, 'cancellation', 0, errors, true);
    if (record?.inputCaseId !== 'G1' || record?.outcome !== 'cancelled') errors.push('cancellation must be a separate cancelled G1 request');
    if (record?.browserStopped !== true || record?.backendCancelled !== true || record?.resourcesReleased !== true || record?.lateResponse?.observation === 'observed' && record?.lateResponse?.isolated !== true) pending.push('real cancellation and local resource release are not verified');
    attempts.push(record);
  }
  const ids = attempts.map(value => value?.requestId).filter(value => typeof value === 'string');
  const instructions = attempts.filter(value => value?.authorization).map(value => JSON.stringify([value.authorization.reference, value.authorization.approvedAt]));
  if (new Set(instructions).size !== instructions.length) errors.push('each call requires its own explicit manual instruction');
  if (attempts.some(value => ['timeout', 'cancelled'].includes(value?.outcome) && (value.resourcesReleased !== true || value.lateResponse?.observation === 'observed' && value.lateResponse?.isolated !== true))) pending.push('terminated requests must release resources and isolate observed late results');
  if (new Set(ids).size !== ids.length) errors.push('server request identifiers must be unique');
  if (!OBSERVATIONS.includes(report.naturalProviderTimeout)) errors.push('natural provider timeout requires an explicit observation state');
  if (report.controlledValidation === null) pending.push('controlled timeout and late-result isolation are not verified');
  else if (object(report.controlledValidation, ['timeoutDurationMs', 'timeoutPassed', 'lateResponseIsolationPassed', 'resourcesReleased', 'evidenceId'], 'controlledValidation', errors)) {
    const controlled = report.controlledValidation;
    identifier(controlled.evidenceId, 'controlledValidation evidenceId', errors);
    if (controlled.timeoutDurationMs !== PHASE7_POLICY.maxDurationMs || controlled.timeoutPassed !== true || controlled.lateResponseIsolationPassed !== true || controlled.resourcesReleased !== true) pending.push('controlled validation must cover the complete deadline and resource release');
  }
  result.ready = errors.length === 0 && pending.length === 0 && result.adjudicableGroups === PHASE7_POLICY.matrix.length && result.qualifiedGroups >= PHASE7_POLICY.minimumQualified;
  return result;
}

export function emptyReportTemplate() {
  return {
    model: { provider: PHASE7_POLICY.provider, name: PHASE7_POLICY.model },
    cases: PHASE7_POLICY.matrix.map(record => ({ ...record, attempts: [] })),
    diagnosticBatches: [],
    cancellation: null, controlledValidation: null, naturalProviderTimeout: 'not_observed',
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--template') {
    process.stdout.write(`${JSON.stringify(emptyReportTemplate(), null, 2)}\n`);
    return 0;
  }
  if (args.length !== 1) {
    process.stderr.write('Usage: node scripts/phase7-evaluation.mjs <report.json> | --template\n');
    return 2;
  }
  let source;
  try { source = await readFile(args[0], 'utf8'); }
  catch { process.stderr.write('Evaluation report could not be read.\n'); return 2; }
  let report;
  try { report = JSON.parse(source); }
  catch { process.stderr.write('Evaluation report is not valid JSON.\n'); return 2; }
  const result = evaluateReport(report);
  for (const error of result.errors) process.stderr.write(`Invalid report: ${error}\n`);
  for (const reason of result.pending) process.stderr.write(`Pending: ${reason}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.errors.length ? 'invalid' : result.ready ? 'passed' : 'blocked', adjudicableGroups: result.adjudicableGroups, qualifiedGroups: result.qualifiedGroups, phase8Ready: result.ready })}\n`);
  return result.ready ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
