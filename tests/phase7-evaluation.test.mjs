import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PHASE7_POLICY, emptyReportTemplate, evaluateReport } from '../scripts/phase7-evaluation.mjs';

function successfulAttempt(id) {
  return {
    number: 1, authorization: { reference: `chat-2026-11-18-${id}`, approvedAt: '2026-11-18T08:00:00Z' },
    outcome: 'success', durationMs: 45_000, requestId: `req-${id}`,
    providerModelStatus: 'not_provided', providerModel: null, providerRequestId: null,
    outputReviewed: true, assessment: { identity: true, outfit: true, shoes: true, noMix: true, fullBody: true, scene: true },
  };
}
function passingReport() {
  const report = emptyReportTemplate();
  report.cases.forEach(record => { record.attempts = [successfulAttempt(record.id)]; });
  report.cancellation = { ...successfulAttempt('cancel'), inputCaseId: 'G1', outcome: 'cancelled', outputReviewed: false, browserStopped: true, backendCancelled: true, resourcesReleased: true, lateResponse: { observation: 'unobservable', isolated: null } };
  delete report.cancellation.assessment;
  report.controlledValidation = { timeoutDurationMs: 90_000, timeoutPassed: true, lateResponseIsolationPassed: true, resourcesReleased: true, evidenceId: 'synthetic-controlled-check' };
  return report;
}

test('empty template is a valid blocked report with the exact approved matrix', () => {
  const report = emptyReportTemplate();
  const result = evaluateReport(report);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ready, false);
  assert.equal(result.adjudicableGroups, 0);
  assert.equal(report.cases[1].sceneId, 'S004');
  assert.equal(report.cases[2].dressSide, 'right');
  assert.equal(report.cases[3].sceneId, 'S006');
  assert.equal(report.cases[4].sceneId, 'S001');
  assert.deepEqual(report.cases.map(({ attempts, ...record }) => record), PHASE7_POLICY.matrix);
});
test('five reviewed cases require four complete quality passes within the full deadline', () => {
  const report = passingReport();
  report.cases[4].attempts[0].assessment.shoes = false;
  assert.equal(evaluateReport(report).ready, true);
  report.cases[3].attempts[0].durationMs = 90_000;
  assert.equal(evaluateReport(report).ready, true, 'the exact 90-second boundary qualifies');
  report.cases[3].attempts[0].durationMs = 90_001;
  const result = evaluateReport(report);
  assert.equal(result.adjudicableGroups, 5);
  assert.equal(result.qualifiedGroups, 3);
  assert.equal(result.ready, false);
});
test('unreviewed successful images remain valid pending records', () => {
  const report = passingReport();
  const value = report.cases[0].attempts[0];
  value.outputReviewed = false;
  value.assessment = null;
  const result = evaluateReport(report);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ready, false);
  assert.equal(result.adjudicableGroups, 4);
});
test('reviewed parallel diagnostic quality evidence is scored without consuming formal attempts', () => {
  const report = emptyReportTemplate();
  report.cases[1].attempts = [
    { ...successfulAttempt('g2-one'), outcome: 'timeout', outputReviewed: false, resourcesReleased: true, lateResponse: { observation: 'unobservable', isolated: null } },
    { ...successfulAttempt('g2-two'), number: 2, outputReviewed: false, assessment: null },
    { ...successfulAttempt('g2-three'), number: 3, outcome: 'timeout', outputReviewed: false, resourcesReleased: true, lateResponse: { observation: 'unobservable', isolated: null } },
  ];
  for (const value of report.cases[1].attempts) delete value.assessment;
  report.diagnosticBatches = [{
    batchId: 'upstream-parallel-20261119-01', caseId: 'G2', promptSha256: 'd'.repeat(64), realModelCalls: 3,
    results: [
      { id: 'parallel-01', durationMs: 53_300, requestId: 'diag-one', outcome: 'success', providerModelStatus: 'not_provided', providerModel: null, providerRequestId: null, mime: 'image/png', width: 1536, height: 1024, imageSha256: null, outputReviewed: false, assessment: null },
      { id: 'parallel-02', durationMs: 52_823, requestId: 'diag-two', outcome: 'success', providerModelStatus: 'not_provided', providerModel: null, providerRequestId: null, mime: 'image/png', width: 1536, height: 1024, imageSha256: null, outputReviewed: false, assessment: null },
      { id: 'parallel-03', durationMs: 47_975, requestId: 'diag-three', outcome: 'success', providerModelStatus: 'not_provided', providerModel: null, providerRequestId: null, mime: 'image/png', width: 1536, height: 1024, imageSha256: 'a'.repeat(64), outputReviewed: false, assessment: null },
    ],
  }];
  const result = evaluateReport(report);
  assert.deepEqual(result.errors, []);
  assert.equal(report.cases[1].attempts.length, 3);
  assert.equal(result.adjudicableGroups, 0);
  assert.equal(result.qualifiedGroups, 0);
  assert.equal(result.ready, false);
  const fastest = report.diagnosticBatches[0].results[2];
  fastest.outputReviewed = true;
  fastest.assessment = { identity: true, outfit: true, shoes: true, noMix: true, fullBody: true, scene: true };
  const reviewed = evaluateReport(report);
  assert.deepEqual(reviewed.errors, []);
  assert.equal(reviewed.adjudicableGroups, 1, 'a reviewed diagnostic image makes G2 adjudicable');
  assert.equal(reviewed.qualifiedGroups, 0, 'diagnostic images do not count toward the formal qualification threshold');
  assert.equal(reviewed.ready, false);
  const phaseGate = passingReport();
  phaseGate.cases[1].attempts = report.cases[1].attempts;
  phaseGate.diagnosticBatches = report.diagnosticBatches;
  const gateResult = evaluateReport(phaseGate);
  assert.equal(gateResult.adjudicableGroups, 5);
  assert.equal(gateResult.qualifiedGroups, 4);
  assert.equal(gateResult.ready, true, 'G2 remains outside formal qualifications while its reviewed diagnostic closes adjudicability');
});

test('an unreviewed retry blocks readiness even after an earlier reviewed failure', () => {
  const report = passingReport();
  report.cases[4].attempts[0].assessment.shoes = false;
  report.cases[4].attempts.push({ ...successfulAttempt('pending-retry'), number: 2, outputReviewed: false, assessment: null });
  const result = evaluateReport(report);
  assert.deepEqual(result.errors, []);
  assert.equal(result.adjudicableGroups, 5);
  assert.equal(result.qualifiedGroups, 4);
  assert.deepEqual(result.pending, ['G5 needs a completed manual review']);
  assert.equal(result.ready, false);
});
test('provider aliases, dated snapshots and explicitly missing versions are distinct', () => {
  const report = passingReport();
  for (const [providerModel, providerModelStatus] of [[null, 'not_provided'], ['gpt-image-2.5-flare', 'reported_alias'], ['gpt-image-2.5-flare-2026-09-08', 'reported_snapshot']]) {
    Object.assign(report.cases[0].attempts[0], { providerModel, providerModelStatus });
    assert.equal(evaluateReport(report).ready, true);
  }
  for (const providerModel of ['other-model', 'gpt-image-2.5-flare-2026-13-40', undefined]) {
    report.cases[0].attempts[0].providerModel = providerModel;
    assert.ok(evaluateReport(report).errors.length);
  }
});
test('a timeout followed by an explicitly authorized retry can qualify; success stops retries', () => {
  const report = passingReport();
  const retry = { ...successfulAttempt('retry'), number: 2 };
  const timeout = { ...successfulAttempt('timeout'), outcome: 'timeout', durationMs: 55_000, outputReviewed: false, resourcesReleased: true, lateResponse: { observation: 'not_observed', isolated: null } };
  delete timeout.assessment;
  report.cases[0].attempts = [timeout, retry];
  assert.equal(evaluateReport(report).ready, true);
  report.cases[0].attempts.push({ ...successfulAttempt('third'), number: 3 });
  assert.ok(evaluateReport(report).errors.some(error => error.includes('must stop')));
});
for (const observation of ['observed', 'not_observed', 'unobservable']) {
  test(`cancellation late response state: ${observation}`, () => {
    const report = passingReport();
    report.cancellation.lateResponse = { observation, isolated: observation === 'observed' ? true : null };
    assert.equal(evaluateReport(report).ready, true);
    report.cancellation.lateResponse.isolated = observation === 'observed' ? false : true;
    assert.equal(evaluateReport(report).ready, false);
  });
}
for (const mutate of [
  report => { report.cases[0].outfitId = 'W006'; },
  report => { report.cases[1].sceneId = 'S001'; },
  report => { report.cases[0].attempts[0].authorization = null; },
  report => { report.cases[0].attempts[0].authorization.reference = 'chat-2026-11-18-Bearer-private-marker'; },
  report => { report.cases[0].attempts[0].assessment.shoes = undefined; },
  report => { report.cases[0].attempts[0].providerRequestId = 'https://private.invalid'; },
  report => { report.cases[0].attempts[0].image = 'private-marker'; },
  report => { report.cases[0].attempts[0].requestId = report.cases[1].attempts[0].requestId; },
  report => { report.cases[0].attempts[0].requestId = null; },
  report => { report.cancellation.authorization = report.cases[0].attempts[0].authorization; },
  report => { report.cases[0].attempts = Array.from({ length: 4 }, (_, index) => ({ ...successfulAttempt(`limit-${index}`), number: index + 1 })); },
  report => { report.model.name = 'unapproved'; },
  report => { report.cancellation.inputCaseId = 'G2'; },
]) {
  test(`invalid report is rejected: ${mutate.toString()}`, () => {
    const report = passingReport();
    mutate(report);
    const result = evaluateReport(report);
    assert.equal(result.ready, false);
    assert.ok(result.errors.length);
  });
}
for (const field of ['browserStopped', 'backendCancelled', 'resourcesReleased']) {
  test(`real cancellation requires ${field}`, () => {
    const report = passingReport(); report.cancellation[field] = false;
    assert.equal(evaluateReport(report).ready, false);
  });
}
test('controlled checks cannot be replaced by absent or accelerated timeout evidence', () => {
  const report = passingReport();
  report.controlledValidation.timeoutDurationMs = 60_000;
  assert.equal(evaluateReport(report).ready, false, 'historical 60-second evidence cannot satisfy the new deadline');
  report.controlledValidation.timeoutDurationMs = 100;
  assert.equal(evaluateReport(report).ready, false);
  report.controlledValidation = null;
  assert.equal(evaluateReport(report).ready, false);
  report.cancellation = null;
  assert.equal(evaluateReport(report).ready, false);
});
test('natural provider timeout not observed does not independently block readiness', () => {
  assert.equal(evaluateReport(passingReport()).ready, true);
});
test('malformed report shapes fail explicitly without throwing', () => {
  for (const input of [null, [], {}, { ...passingReport(), cases: [null] }]) assert.ok(evaluateReport(input).errors.length);
  for (const diagnosticBatches of [null, undefined, {}]) {
    const result = evaluateReport({ ...passingReport(), diagnosticBatches });
    assert.ok(result.errors.includes('diagnosticBatches must be an array'));
    assert.equal(result.ready, false);
  }
  const report = passingReport();
  report.cases = report.cases.map(() => null);
  const { number, authorization, ...diagnostic } = successfulAttempt('diagnostic');
  report.diagnosticBatches = [{
    batchId: 'invalid-shape-check', caseId: 'G2', promptSha256: 'd'.repeat(64), realModelCalls: 1,
    results: [{ ...diagnostic, id: 'diagnostic', mime: 'image/png', width: 1536, height: 1024, imageSha256: 'a'.repeat(64) }],
  }];
  const result = evaluateReport(report);
  assert.ok(result.errors.length);
  assert.equal(result.ready, false);
});
test('CLI emits an empty template or aggregate results without report contents', () => {
  const template = spawnSync(process.execPath, ['scripts/phase7-evaluation.mjs', '--template'], { encoding: 'utf8' });
  assert.equal(template.status, 0);
  assert.deepEqual(JSON.parse(template.stdout), emptyReportTemplate());
  const directory = mkdtempSync(join(tmpdir(), 'phase7-evaluation-'));
  const path = join(directory, 'report.json');
  try {
    for (const report of [passingReport(), emptyReportTemplate()]) {
      writeFileSync(path, JSON.stringify(report));
      const cli = spawnSync(process.execPath, ['scripts/phase7-evaluation.mjs', path], { encoding: 'utf8' });
      const expected = evaluateReport(report);
      assert.equal(cli.status, expected.ready ? 0 : 1, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).phase8Ready, expected.ready);
      assert.doesNotMatch(cli.stdout, /C001|W001|chuanapi|req-/);
    }
  } finally { rmSync(path); rmdirSync(directory); }
});
