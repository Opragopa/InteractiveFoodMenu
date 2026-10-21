import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTestUrl, fixtureGuard, requestFull, summarize } from './lib.mjs';

async function serve(handler){const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return{server,base:`http://127.0.0.1:${server.address().port}`};}
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
test('production and public targets cannot be used as audit targets',()=>{
 for(const value of ['https://api.foodmenu.cloudopragopa.online','https://foodmenu.cloudopragopa.online','https://example.com','http://localhost@api.foodmenu.cloudopragopa.online'])assert.throws(()=>assertTestUrl(value));
 assert.equal(assertTestUrl('http://127.0.0.1:8091/'),'http://127.0.0.1:8091');
 assert.equal(assertTestUrl('http://192.168.1.161:28091'),'http://192.168.1.161:28091');
 assert.throws(()=>fixtureGuard({format:'ifm-audit-v1',runId:'test1',identity:{projectId:'production',databaseId:'production'}}));
});
test('request timing includes complete body, and invalid JSON is an error',async()=>{
 const {server,base}=await serve((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();setTimeout(()=>res.end(req.url==='/bad'?'not-json':'{"ok":true}'),80);});
 try{const result=await requestFull(base,'/slow');assert.equal(result.ok,true);assert.ok(result.durationMs>=75);assert.ok(result.durationMs-result.ttfbMs>=50);assert.equal(result.bytes,11);const bad=await requestFull(base,'/bad');assert.equal(bad.error,'invalid_json');assert.equal(bad.ok,false);}finally{await close(server);}
});
test('request timeout bounds stalled responses and retains failure duration',async()=>{
 const {server,base}=await serve((req,res)=>{res.writeHead(200);res.flushHeaders();res.write('{');});
 try{const result=await requestFull(base,'/',{timeoutMs:50});assert.equal(result.ok,false);assert.equal(result.error,'timeout_or_abort');assert.ok(result.durationMs<1000);assert.equal(summarize([result]).failures,1);}finally{await close(server);}
});
async function scenario({invalid=false,stop=false,staleContent=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'ifm-harness-'));let stock=100,version=1;
 const {server,base}=await serve(async(req,res)=>{
  const buffers=[];for await(const chunk of req)buffers.push(chunk);let body={};try{body=JSON.parse(Buffer.concat(buffers).toString()||'{}');}catch{}
  res.setHeader('content-type','application/json');
  if(req.url==='/api/hub/overview')return res.end(JSON.stringify({venues:[{id:'v1',name:'AUDIT test123 1'}]}));
  if(req.url==='/api/menu')return res.end(JSON.stringify({venue:{id:'v1',menuVersion:version},items:[{id:'i1',stockQuantity:staleContent?100:stock,isAvailable:true,priceMinor:100},{id:'i2',isAvailable:true,priceMinor:200}],categories:[]}));
  if(req.url.startsWith('/tv/menu')){res.setHeader('content-type','text/html');return res.end(`<!doctype html><div class="item"><div class="main-row"><span class="item-name">Тестовое блюдо 3</span></div></div><script>var version=${version};</script>`);}
  if(req.url==='/tv/state'||req.url==='/api/menu/version')return res.end(invalid?'bad json':JSON.stringify({version}));
  if(req.url==='/api/items/i1/stock/adjust'){stock+=body.delta;version++;return res.end(JSON.stringify({item:{id:'i1',stockQuantity:stock,isAvailable:true,priceMinor:100}}));}
  if(req.url.includes('/statistics'))return res.end(JSON.stringify({venueId:'v1',counts:{}}));
  res.statusCode=404;res.end('{}');
 });
 const fixture={format:'ifm-audit-v1',runId:'test123',identity:{projectId:'ifm-audit-test123',databaseId:'ifm-audit-test123'},baseUrl:base,origin:base,markerVenueId:'v1',venueIds:['v1'],hub:{cookie:'ifm_hub=test'},staff:[{venueId:'v1',cookie:'ifm_staff=test',itemId:'i1',untrackedItemId:'i2'}],screens:Array.from({length:10},(_,i)=>({id:`s${i}`,venueId:'v1',type:['server','modern','react-legacy'][i%3],cookie:`ifm_tv_session=s${i}`,token:`t${i}`,width:1920,height:1080}))};
 const fixturePath=path.join(dir,'fixture.json');await writeFile(fixturePath,JSON.stringify(fixture));
 const output=path.join(dir,'result');const stopPath=path.join(dir,'STOP');if(stop)await writeFile(stopPath,'');
 try{
  const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./scenario.mjs',import.meta.url)),'--fixture',fixturePath,'--output',output,'--allow-load','--allow-writes','--confirm-run','test123','--profile','harness','--harness-only','--time-scale','.04','--stop-file',stopPath],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});
  const summary=JSON.parse(await readFile(path.join(output,'summary.json'),'utf8'));
  const report=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./report.mjs',import.meta.url)),'--input',output],{stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('exit',code=>resolve({code,error}));});assert.equal(report.code,0,report.error);const html=await readFile(path.join(output,'report.html'),'utf8');assert.match(html,/HARNESS ONLY/);assert.match(html,/Ожидаемых подтверждений/);assert.ok((await readFile(path.join(output,'routes.csv'),'utf8')).includes('p95Ms'));return{...result,summary};
 }finally{await close(server);await rm(dir,{recursive:true,force:true});}
}
test('fake HTTP harness exercises all polling types and verifies final stock',async()=>{const r=await scenario();assert.equal(r.code,0,r.stderr);assert.equal(r.summary.harnessOnly,true);assert.ok(r.summary.summary.count>20);assert.equal(r.summary.passed,true);assert.equal(r.summary.stockChecks[0].ok,true);assert.equal(r.summary.stockChecks[0].successfulDelta,1);assert.equal(r.summary.mutationEvidenceVersion,1);assert.equal(r.summary.initialItemStates.i2.isAvailable,true);});
test('malformed payloads remain visible and fail a harness run',async()=>{const r=await scenario({invalid:true});assert.equal(r.code,1,r.stderr);assert.ok(r.summary.summary.failures>0);assert.equal(r.summary.passed,false);});
test('stop-file support stops promptly and never reports success',async()=>{const r=await scenario({stop:true});assert.equal(r.code,1,r.stderr);assert.equal(r.summary.stopReason,'stop_file');assert.equal(r.summary.passed,false);});

test('new version with stale menu content cannot pass delivery acceptance',async()=>{const r=await scenario({staleContent:true});assert.equal(r.code,1,r.stderr);assert.equal(r.summary.acceptance.deliveryPassed,false);assert.ok(r.summary.delivery.missingReceipts>0);assert.equal(r.summary.passed,false);});
