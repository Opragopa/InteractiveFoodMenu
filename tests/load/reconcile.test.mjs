import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSnapshots } from './reconcile-lib.mjs';
function evidence() {
 const tracked={venueId:'v1',stockQuantity:100,isAvailable:true,priceMinor:100};
 const untracked={venueId:'v1',stockQuantity:null,isAvailable:true,priceMinor:200};
 const before={format:'ifm-audit-statistics-v1',runId:'test1',identity:{databaseId:'ifm-audit-test1'},period:{from:'2026-09-20',to:'2026-10-22'},capturedAt:'2026-10-20T00:00:00Z',apiEqualsSource:true,
 sourceTotals:{availabilityChanges:20000,stockChanges:20000,menuChanges:20000,staffLogins:20000,displayConnections:0,errors:0,displayContactIntervals:20000},contacts:{intervals:[],invalidRows:0},stocks:{i1:100},items:{i1:tracked,i2:untracked},venues:[{venueId:'v1',state:{breakActive:false}}]};
 before.apiTotals=structuredClone(before.sourceTotals);
 const after=structuredClone(before);after.captureStartedAt='2026-10-20T02:01:00Z';after.capturedAt='2026-10-20T02:02:00Z';after.stocks.i1=101;after.items.i1.stockQuantity=101;after.items.i2.isAvailable=false;
 for(const field of ['stockChanges','menuChanges','availabilityChanges','displayContactIntervals']){after.sourceTotals[field]++;after.apiTotals[field]++;}
 after.contacts.intervals=['v1/screen/1234'];
 const requests=[{ok:true,route:'stock-adjust',mutation:{version:1,sequence:1,operation:'stock-adjust',venueId:'v1',itemId:'i1',delta:1,state:{stockQuantity:101,isAvailable:true,priceMinor:100}}},
 {ok:true,route:'availability-write',mutation:{version:1,sequence:2,operation:'availability-write',venueId:'v1',itemId:'i2',state:{stockQuantity:null,isAvailable:false,priceMinor:200}}}];
 const summary={mutationEvidenceVersion:1,initialItemStates:structuredClone(before.items),startedAt:'2026-10-20T00:01:00Z',endedAt:'2026-10-20T02:00:00Z',stockChecks:[{itemId:'i1',initial:100,expected:101,ok:true}]};
 return{before,after,requests,summary};
}
test('versioned successful mutation states reconcile all operational counter semantics',()=>{const {before,after,requests,summary}=evidence();const r=compareSnapshots(before,after,requests,summary);assert.equal(r.passed,true);assert.equal(r.allCounterSemanticsVerified,true);assert.equal(r.counts.find(row=>row.name==='availabilityChanges').expected,1);});
test('missing or duplicate availability events fail despite correct final item state',()=>{for(const change of [-1,1]){const {before,after,requests,summary}=evidence();after.sourceTotals.availabilityChanges+=change;after.apiTotals.availabilityChanges+=change;const r=compareSnapshots(before,after,requests,summary);assert.equal(r.passed,false);assert.equal(r.counts.find(row=>row.name==='availabilityChanges').passed,false);}});
test('lost stock event fails despite successful mutation and correct final stock',()=>{const {before,after,requests,summary}=evidence();after.sourceTotals.stockChanges--;after.apiTotals.stockChanges--;assert.equal(compareSnapshots(before,after,requests,summary).passed,false);});
test('unchanged availability write produces no transition event',()=>{const {before,after,requests,summary}=evidence();requests[1].mutation.state.isAvailable=true;after.items.i2.isAvailable=true;after.sourceTotals.availabilityChanges--;after.apiTotals.availabilityChanges--;const r=compareSnapshots(before,after,requests,summary);assert.equal(r.passed,true);assert.equal(r.counts.find(row=>row.name==='availabilityChanges').expected,0);});
test('missing mutation evidence cannot yield a partial semantic pass',()=>{const {before,after,requests,summary}=evidence();delete requests[1].mutation;const r=compareSnapshots(before,after,requests,summary);assert.equal(r.passed,false);assert.equal(r.allCounterSemanticsVerified,false);});
test('different identities, overlapping captures or missing timestamps are rejected',()=>{for(const variant of ['identity','overlap','missing']){const {before,after,requests,summary}=evidence();if(variant==='identity')after.identity.databaseId='foreign';if(variant==='overlap')before.capturedAt='2026-10-20T00:02:00Z';if(variant==='missing')delete before.capturedAt;assert.throws(()=>compareSnapshots(before,after,requests,summary));}});
