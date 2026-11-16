import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matrixStages } from './matrix-plan.mjs';

test('matrix plan rejects invalid, repeated, unordered and unprovisioned counts', () => {
  for (const devices of ['', '0', '1.5', '10,10', '25,10', '201', '10,', 'NaN']) assert.throws(() => matrixStages({ devices }, 200));
  for (const value of ['0','29','1.5','86401']) assert.throws(() => matrixStages({ 'stage-seconds': value }, 200));
  assert.deepEqual(matrixStages({ devices: '5,12', 'stage-seconds': '30', 'warmup-seconds': '0' }, 20), [{ name: 'devices5', screens: 5, seconds: 30 }, { name: 'devices12', screens: 12, seconds: 30 }]);
  assert.equal(matrixStages({}, 200).reduce((n, s) => n + s.seconds, 0), 3180);
});

function command(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run-matrix.mjs', import.meta.url)), ...argv], { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

for (const stop of [true, false]) test(`detached matrix ${stop ? 'stops without starting later stages' : 'finishes all stages'} and generates reports`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ifm-matrix-'));
  let childPid;
  let stock = 100, version = 1;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/hub/overview') return res.end(JSON.stringify({ venues: [{ id: 'v1', name: 'AUDIT matrix1 1' }] }));
    if (req.url === '/api/menu') return res.end(JSON.stringify({ venue: { id: 'v1', menuVersion: version }, items: [{ id: 'i1', stockQuantity: stock, isAvailable: true, priceMinor: 100 }, { id: 'i2', isAvailable: true, priceMinor: 200 }] }));
    if (req.url === '/api/menu/version') return res.end(JSON.stringify({ version }));
    if (req.url === '/api/items/i1/stock/adjust') { stock++; version++; return res.end(JSON.stringify({ item: { id: 'i1', stockQuantity: stock, isAvailable: true, priceMinor: 100 } })); }
    if (req.url.includes('/statistics')) return res.end('{"venueId":"v1","counts":{}}');
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fixture = { format: 'ifm-audit-v1', runId: 'matrix1', identity: { projectId: 'ifm-audit-matrix1', databaseId: 'ifm-audit-matrix1' }, baseUrl, origin: baseUrl, markerVenueId: 'v1', venueIds: ['v1'], hub: { cookie: 'hub' }, staff: [{ venueId: 'v1', cookie: 'staff', itemId: 'i1', untrackedItemId: 'i2' }], screens: Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, venueId: 'v1', type: 'modern', token: `t${i}`, cookie: `s${i}` })) };
  const fixturePath = path.join(dir, 'fixture.json');
  const output = path.join(dir, 'result');
  const argv = ['--fixture', fixturePath, '--output', output, '--confirm-run', 'matrix1', '--devices', '1,2', '--stage-seconds', '30', '--warmup-seconds', '0'];
  try {
    await writeFile(fixturePath, JSON.stringify(fixture));
    const dry = await command([...argv, '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).stages.length, 2);
    await assert.rejects(readFile(path.join(output, 'plan.json')));
    const result = await command([...argv, '--allow-load', ...(stop ? [] : ['--allow-writes']), '--detach']);
    assert.equal(result.code, 0, result.stderr);
    childPid = JSON.parse(result.stdout).pid;
    const deadline = Date.now() + (stop ? 10000 : 75000);
    let state;
    // Wait for real dispatch before stopping so the stop/report path is exercised.
    while (Date.now() < deadline) {
      const text = await readFile(path.join(output, 'workload', 'events.jsonl'), 'utf8').catch(() => '');
      if (text.includes('stage_started')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (stop) await writeFile(path.join(output, 'STOP'), '');
    while (Date.now() < deadline) {
      state = await readFile(path.join(output, 'runner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (state?.endedAt) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state?.status, stop ? 'stopped' : 'completed');
    assert.equal(state.stopReason, stop ? 'stop_file' : null);
    assert.equal(state.passed, !stop);
    if (!stop) {
      const summary = JSON.parse(await readFile(path.join(output, 'workload', 'summary.json'), 'utf8'));
      assert.equal(summary.delivery.successfulWrites, 2);
      assert.equal(summary.delivery.missingReceipts, 0);
      assert.equal(summary.stockChecks[0].successfulDelta, 2);
    }
    assert.equal(state.reportExitCode, 0);
    assert.match(await readFile(path.join(output, 'workload', 'report.html'), 'utf8'), /devices1/);
    const csv = await readFile(path.join(output, 'stages.csv'), 'utf8');
    assert.match(csv, stop ? /devices1,1,30,true,false/ : /devices1,1,30,true,true/);
    assert.match(csv, stop ? /devices2,2,30,false,false/ : /devices2,2,30,true,true/);
    const existing = await command([...argv, '--allow-load']);
    assert.notEqual(existing.code, 0);
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGTERM'); } catch {} }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
