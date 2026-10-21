// A transient file-read/network failure must not extend the last sample's deadline.
export function inspectResourceSample(previous, response, runId, now = Date.now()) {
  const data = response.ok ? response.data : null;
  if (data?.runId && data.runId !== runId) return { last: previous, reason: 'resource_monitor_identity_mismatch', readFailed: true };
  const at = Date.parse(data?.at);
  const valid = response.ok && data?.runId === runId && Number.isFinite(at) && typeof data.stop === 'boolean' && at <= now + 5000;
  const last = valid ? data : previous;
  if (valid && data.stop) return { last, reason: 'resource_monitor_stop', readFailed: false };
  if (!last || now - Date.parse(last.at) > 25000) return { last, reason: 'resource_monitor_unavailable_or_stale', readFailed: !valid };
  return { last, reason: null, readFailed: !valid };
}
