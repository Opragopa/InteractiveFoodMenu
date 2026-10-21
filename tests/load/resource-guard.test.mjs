import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectResourceSample as inspect } from './resource-guard.mjs';
const start=Date.parse('2026-10-21T09:00:00Z');
const sample={runId:'test123',at:new Date(start).toISOString(),stop:false};
test('transient resource read failure retains only the original 25-second deadline',()=>{
 const temporary=inspect(sample,{ok:false,status:404},'test123',start+5000);
 assert.equal(temporary.reason,null);assert.equal(temporary.last,sample);assert.equal(temporary.readFailed,true);
 assert.equal(inspect(temporary.last,{ok:false},'test123',start+25001).reason,'resource_monitor_unavailable_or_stale');
});
test('malformed resource response cannot refresh or extend a valid sample',()=>{
 const r=inspect(sample,{ok:true,data:{}},'test123',start+20000);
 assert.equal(r.last,sample);assert.equal(r.readFailed,true);
 assert.equal(inspect(r.last,{ok:true,data:{}},'test123',start+26000).reason,'resource_monitor_unavailable_or_stale');
});
test('no initial monitor sample fails closed',()=>assert.equal(inspect(null,{ok:false},'test123',start).reason,'resource_monitor_unavailable_or_stale'));
test('stale and future monitor samples cannot conceal loss of telemetry',()=>{
 assert.equal(inspect(null,{ok:true,data:sample},'test123',start+25001).reason,'resource_monitor_unavailable_or_stale');
 assert.equal(inspect(null,{ok:true,data:{...sample,at:new Date(start+6000).toISOString()}},'test123',start).reason,'resource_monitor_unavailable_or_stale');
});
test('resource alarm stops immediately despite a recent healthy sample',()=>assert.equal(inspect(sample,{ok:true,data:{...sample,stop:true}},'test123',start+1000).reason,'resource_monitor_stop'));
test('resource identity mismatch is never treated as a transient read error',()=>assert.equal(inspect(sample,{ok:true,data:{...sample,runId:'other'}},'test123',start+1000).reason,'resource_monitor_identity_mismatch'));
