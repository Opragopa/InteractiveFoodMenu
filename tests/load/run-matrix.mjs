import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { args, externalPath, fixtureGuard, loadJsonExternal, assertTestUrl } from './lib.mjs';
import { matrixStages } from './matrix-plan.mjs';

const cli = args();
const usage = `Usage: npm run load:matrix -- --fixture /external/fixture.json --output /external/new-result
  --confirm-run RUN_ID --allow-load [--allow-writes] [--detach | --dry-run]
  [--devices 10,25,50,100,200] [--stage-seconds 600] [--warmup-seconds 180]
  [--transport lan|ssh-tunnel|server-local] [--resource-status-url URL]
  [--software-version COMMIT] [--max-inflight 64] [--timeout-ms 10000]
Stop: create OUTPUT/STOP. Results and console.log remain in OUTPUT.`;
if (cli.help) { console.log(usage); process.exit(0); }
const allowed = new Set(['fixture','output','confirm-run','allow-load','allow-writes','detach','dry-run','background-worker','devices','stage-seconds','warmup-seconds','transport','resource-status-url','software-version','max-inflight','timeout-ms']);
if (cli._.length || Object.keys(cli).some(key => key !== '_' && !allowed.has(key))) throw new Error('Unknown argument.\n' + usage);
if (!cli.fixture || !cli.output || !cli['confirm-run']) throw new Error(usage);
const fixturePath = await externalPath(cli.fixture);
const fixture = fixtureGuard(await loadJsonExternal(fixturePath));
if (fixture.screens.some(screen => typeof screen.id !== 'string' || !screen.id) || new Set(fixture.screens.map(screen => screen.id)).size !== fixture.screens.length) throw new Error('Fixture must contain distinct screen IDs.');
if (cli['confirm-run'] !== fixture.runId) throw new Error('confirm-run must match the isolated fixture runId.');
const stages = matrixStages(cli, fixture.screens.length);
if (cli['resource-status-url']) assertTestUrl(cli['resource-status-url']);
for (const [key, fallback, min, max] of [['max-inflight',64,1,256],['timeout-ms',10000,50,30000]]) {
  const n = Number(cli[key] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}.`);
}
if (!cli['dry-run'] && !cli['allow-load']) throw new Error('Execution requires --allow-load.');
const output = await externalPath(cli.output, { existing: Boolean(cli['background-worker']) });
const workload = path.join(output, 'workload');
const plan = {
  format: 'ifm-load-matrix-v1', runId: fixture.runId, stages,
  scheduledSeconds: stages.reduce((n, stage) => n + stage.seconds, 0),
  writesEnabled: Boolean(cli['allow-writes']), transport: cli.transport ?? 'unspecified',
  resourceMonitorAttached: Boolean(cli['resource-status-url']),
  screenMix: stages.map(stage => ({ stage: stage.name, types: fixture.screens.slice(0, stage.screens).reduce((mix, screen) => { mix[screen.type] = (mix[screen.type] ?? 0) + 1; return mix; }, {}) })),
  notes: ['Device count means distinct screen HTTP sessions; staff and operators are additional actors.', 'Stages run sequentially on the same database, without resetting data.', 'Allow up to 17 seconds delivery drain per stage plus verification/request completion.', 'Resource telemetry and API logs are collected separately on the server.'],
};
if (cli['dry-run']) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
if (!cli['background-worker']) {
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
}
if (cli.detach) {
  const fd = openSync(path.join(output, 'console.log'), 'wx', 0o600);
  const argv = process.argv.slice(2).filter(value => value !== '--detach');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv, '--background-worker'], { detached: true, stdio: ['ignore', fd, fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  closeSync(fd);
  child.unref();
  console.log(JSON.stringify({ event: 'matrix_started_in_background', pid: child.pid, output, stopFile: path.join(output, 'STOP') }));
  process.exit(0);
}

const startedAt = new Date().toISOString();
const statePath = path.join(output, 'runner.json');
const saveState = state => writeFile(statePath, JSON.stringify({ startedAt, pid: process.pid, ...state }, null, 2) + '\n');
let activeChild;
let interrupted = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  interrupted = true;
  void writeFile(path.join(output, 'STOP'), '').catch(() => {});
  activeChild?.kill(signal);
});
async function run(script, argv) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...argv], { stdio: ['ignore','inherit','inherit'] });
  activeChild = child;
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
  finally { activeChild = undefined; }
}
await saveState({ status: 'running' });
try {
  const argv = ['--fixture', fixturePath, '--output', workload, '--profile', 'matrix', '--allow-load', '--confirm-run', fixture.runId, '--stop-file', path.join(output, 'STOP')];
  for (const key of ['devices','stage-seconds','warmup-seconds','transport','resource-status-url','software-version','max-inflight','timeout-ms']) if (cli[key] !== undefined) argv.push(`--${key}`, String(cli[key]));
  if (cli['allow-writes']) argv.push('--allow-writes');
  const result = await run('./scenario.mjs', argv);
  // Generate reports even after a threshold stop or a failed acceptance check.
  const hasSummary = await access(path.join(workload, 'summary.json')).then(() => true, () => false);
  let reportCode = null;
  if (hasSummary) {
    reportCode = (await run('./report.mjs', ['--input', workload])).code;
    const events = (await readFile(path.join(workload, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const summary = JSON.parse(await readFile(path.join(workload, 'summary.json'), 'utf8'));
    const rows = stages.map(stage => {
      const started = events.some(e => e.event === 'stage_started' && e.stage === stage.name);
      const end = events.find(e => e.event === 'stage_completed' && e.stage === stage.name);
      const completed = Boolean(end && end.elapsedSeconds >= stage.seconds && !events.some(e => e.event === 'stopped' && e.stage === stage.name));
      return [stage.name, stage.screens, stage.seconds, started, completed, end?.elapsedSeconds ?? '', end?.summary.count ?? '', end?.summary.failures ?? '', end?.summary.p95Ms ?? '', end?.dropped ?? '', end ? end.summary.count / end.elapsedSeconds : ''];
    });
    await writeFile(path.join(output, 'stages.csv'), 'stage,screens,plannedSeconds,started,completed,elapsedSeconds,requests,failures,p95Ms,dropped,rps\n' + rows.map(row => row.join(',')).join('\n') + '\n');
    await saveState({ status: interrupted || summary.stopped ? 'stopped' : result.code === 0 && reportCode === 0 ? 'completed' : 'failed', endedAt: new Date().toISOString(), scenarioExitCode: result.code, reportExitCode: reportCode, passed: summary.passed, stopReason: summary.stopReason });
  } else {
    await saveState({ status: 'failed', endedAt: new Date().toISOString(), scenarioExitCode: result.code, signal: result.signal, reason: 'scenario_did_not_produce_summary' });
  }
  process.exitCode = !interrupted && result.code === 0 && reportCode === 0 ? 0 : 1;
  console.log(JSON.stringify({ event: 'matrix_finished', output, exitCode: process.exitCode }));
} catch {
  await saveState({ status: 'failed', endedAt: new Date().toISOString(), reason: 'runner_or_report_failure; inspect console output' });
  process.exitCode = 1;
}
