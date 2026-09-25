const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8091";
const requests = Number(process.env.LOAD_REQUESTS ?? 100);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10);
const started = Date.now();
let next = 0;
let ok = 0;
let failed = 0;
const samples = [];

async function worker() {
  while (true) {
    const index = next++;
    if (index >= requests) return;
    const startedAt = performance.now();
    try {
      const response = await fetch(`${baseUrl}/health`);
      samples.push(performance.now() - startedAt);
      if (response.ok) ok += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
samples.sort((a, b) => a - b);
const percentile = (value) => samples[Math.min(samples.length - 1, Math.floor(samples.length * value))] ?? 0;
const summary = { baseUrl, requests, concurrency, ok, failed, elapsedMs: Date.now() - started, p50Ms: Math.round(percentile(.5)), p95Ms: Math.round(percentile(.95)), p99Ms: Math.round(percentile(.99)) };
console.log(JSON.stringify(summary, null, 2));
if (failed > 0 || ok !== requests) process.exitCode = 1;
