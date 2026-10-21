import { inspectResourceSample } from './resource-guard.mjs';
import { itemState, mutationEvidence } from './mutation-state.mjs';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { args, assertTestUrl, externalPath, fixtureGuard, loadJsonExternal, percentile, positiveNumber, requestFull, summarize, verifyApiIdentity } from './lib.mjs';

const cli=args();
if(!cli.fixture || !cli.output || !cli['allow-load']) throw new Error('Usage: node tests/load/scenario.mjs --fixture /external/fixture.json --output /external/new-run --allow-load --allow-writes --confirm-run RUN_ID [--profile full|quick|harness]');
const fixture=fixtureGuard(await loadJsonExternal(cli.fixture));
if(cli['confirm-run']!==fixture.runId) throw new Error('Explicit --confirm-run must match fixture runId.');
const profile=cli.profile??'full';
if(!['full','quick','harness'].includes(profile)) throw new Error('Unknown profile.');
if(profile==='harness' && (!cli['harness-only'] || !['127.0.0.1','localhost','[::1]'].includes(new URL(fixture.baseUrl).hostname))) throw new Error('Harness profile is loopback-only and needs --harness-only.');
const scale=profile==='harness'?positiveNumber(cli['time-scale']??.002,'time-scale',.0001,.1):1;
const resourceUrl=cli['resource-status-url']?new URL(assertTestUrl(cli['resource-status-url'])):null;
const maxInflight=positiveNumber(cli['max-inflight']??64,'max-inflight',1,256);
const timeoutMs=positiveNumber(cli['timeout-ms']??10000,'timeout-ms',50,30000);
const output=await externalPath(cli.output,{existing:false});
await mkdir(output,{recursive:false,mode:0o700});
const stopFile=cli['stop-file']?await externalPath(cli['stop-file'],{existing:false}):path.join(output,'STOP');
const measurements=createWriteStream(path.join(output,'requests.jsonl'),{flags:'wx',mode:0o600});
const events=createWriteStream(path.join(output,'events.jsonl'),{flags:'wx',mode:0o600});
let stopped=false,stopReason=null,stageName='preflight',inflight=new Set(),dropped=0;
const controller=new AbortController();
const samples=[], delivery=[], writes={}, pending=new Map(), versions=new Map(), snapshots=new Map();
let lastResourceSample=null, resourceReadFailures=0;
let activeScreens=[], successfulWrites=0;const initialItemStates={},mutationSequences=new Map();
const startedAt=new Date().toISOString();
const harnessSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).update(await readFile(new URL('./lib.mjs',import.meta.url))).update(await readFile(new URL('./mutation-state.mjs',import.meta.url))).update(await readFile(new URL('./resource-guard.mjs',import.meta.url))).digest('hex');
const fixtureFingerprint=createHash('sha256').update(JSON.stringify({identity:fixture.identity,expected:fixture.expected,venueIds:fixture.venueIds,screens:fixture.screens.map(s=>({id:s.id,type:s.type,venueId:s.venueId}))})).digest('hex');
function stop(reason){if(!stopped){stopped=true;stopReason=reason;events.write(JSON.stringify({at:new Date().toISOString(),event:'stopped',reason})+'\n');controller.abort();}}
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
const logEvent=(event,details={})=>events.write(JSON.stringify({at:new Date().toISOString(),stage:stageName,event,...details})+'\n');
async function call(name,route,options={}){
 const result=await requestFull(fixture.baseUrl,route,{timeoutMs,signal:controller.signal,...options});
 if(result.ok && options.check && !options.check(result.data)){result.ok=false;result.error='invalid_payload';}
 let mutation;
 if(result.ok && options.mutationActor){try{mutation=mutationEvidence(name,options.mutationActor,result.data,options.body);mutation.sequence=(mutationSequences.get(mutation.venueId)??0)+1;mutationSequences.set(mutation.venueId,mutation.sequence);}catch{result.ok=false;result.error='invalid_mutation_evidence';}}
 const row={mutation,at:new Date().toISOString(),stage:stageName,route:name,status:result.status,ok:result.ok,error:result.error,durationMs:result.durationMs,ttfbMs:result.ttfbMs,bytes:result.bytes,requestId:result.requestId};
 samples.push(row);measurements.write(JSON.stringify(row)+'\n');
 return result;
}
const headers=(actor)=>({cookie:actor.cookie,origin:fixture.origin,'content-type':'application/json'});
function schedule(task,actor){
 if(stopped)return;
 if(inflight.size>=maxInflight || actor?.busy){dropped++;return;}
 if(actor)actor.busy=true;
 const promise=task().catch(()=>stop('unhandled_actor_error')).finally(()=>{if(actor)actor.busy=false;inflight.delete(promise);});inflight.add(promise);
}
function matchesContent(snapshot, expected, type){
 if(type==='server'){
   if(expected.breakActive!==undefined)return new RegExp('<aside class="break'+(expected.breakActive?' active':'')+'"').test(snapshot);
   const marker='<span class="item-name">'+expected.name+'</span>';
   const at=snapshot.indexOf(marker);if(at<0)return false;
   const from=snapshot.lastIndexOf('<div class="item',at);const next=snapshot.indexOf('<div class="item',at+marker.length);const segment=snapshot.slice(from,next<0?undefined:next);
   if(expected.isAvailable!==undefined && /class="item[^"]*\bunavailable\b/.test(segment)===expected.isAvailable)return false;
   if(expected.priceMinor!==undefined){const amount=(expected.priceMinor/100).toFixed(expected.priceMinor%100?2:0).replace('.',',')+' руб.';if(!segment.includes('>'+amount+'</span>'))return false;}
   return true;
 }
 if(expected.breakActive!==undefined)return snapshot.venue?.breakActive===expected.breakActive;
 const item=snapshot.items?.find(row=>row.id===expected.itemId);if(!item)return false;
 return Object.entries(expected.fields??{}).every(([key,value])=>item[key]===value);
}
function acknowledge(screen, entry, snapshot){
 const key=screen.id??screen.cookie;
 if(!entry.expected.has(key)||entry.seen.has(key)||snapshot.version<entry.version||!matchesContent(snapshot.data,entry.content,screen.type))return;
 entry.seen.add(key);const lagMs=Math.max(0,snapshot.at-entry.at);const intervalMs=screen.type==='server'?15000:5000;
 const row={stage:entry.stage,screenType:screen.type,lagMs,intervalMs};delivery.push(row);logEvent('update_observed',row);
}
function observed(screen,version,data){
 if(!Number.isFinite(version))return;
 const key=screen.id??screen.cookie;versions.set(key,version);
 if(data===undefined)return; // State/version alone is not a content receipt.
 const snapshot={version,data,at:performance.now()};snapshots.set(key,snapshot);
 for(const entry of pending.get(screen.venueId)??[])acknowledge(screen,entry,snapshot);
}
async function screenMenu(screen){
 if(screen.type==='server'){
   const response=await call('tv-menu',`/tv/menu?w=${screen.width}&h=${screen.height}`,{headers:headers(screen),json:false,check:text=>typeof text==='string'&&/^<!doctype html>/i.test(text)});
   if(response.ok){const version=/\bversion=(\d+)/.exec(response.data);if(version)observed(screen,Number(version[1]),response.data);}
 }else{
   const response=await call('display-menu','/api/menu',{headers:{authorization:`Bearer ${screen.token}`},check:data=>data?.venue?.id===screen.venueId&&Array.isArray(data.items)});
   if(response.ok)observed(screen,Number(response.data.venue.menuVersion??1),response.data);
 }
}
async function pollScreen(screen){
 if(screen.type==='react-legacy'){await screenMenu(screen);return;}
 const response=await call(screen.type==='server'?'tv-state':'display-version',screen.type==='server'?'/tv/state':'/api/menu/version',{headers:screen.type==='server'?headers(screen):{authorization:`Bearer ${screen.token}`},check:data=>Number.isFinite(data?.version)});
 if(!response.ok)return;
 const version=Number(response.data.version),prior=versions.get(screen.id??screen.cookie);
 if(prior===undefined||prior!==version)await screenMenu(screen);else observed(screen,version);
}
async function staffAction(actor){
 const n=actor.actions++;let response,content;
 if(n%10<6){
   const delta=n%2===0?1:-1;
   response=await call('stock-adjust',`/api/items/${encodeURIComponent(actor.itemId)}/stock/adjust`,{method:'POST',mutationActor:actor,headers:headers(actor),body:{delta},check:data=>data?.item?.id===actor.itemId&&Number.isInteger(data.item.stockQuantity)&&data.item.stockQuantity>=0});
   if(response.ok){writes[actor.itemId]=(writes[actor.itemId]??0)+delta;content={itemId:actor.itemId,name:'Тестовое блюдо 3',isAvailable:response.data.item.stockQuantity>0,fields:{stockQuantity:response.data.item.stockQuantity,isAvailable:response.data.item.stockQuantity>0}};}
 }else if(n%10<8){content={itemId:actor.untrackedItemId,name:'Тестовое блюдо 2',isAvailable:n%2===0,fields:{isAvailable:n%2===0}};response=await call('availability-write',`/api/items/${encodeURIComponent(actor.untrackedItemId)}`,{method:'PATCH',mutationActor:actor,headers:headers(actor),body:{isAvailable:n%2===0}});}
 else if(n%10===8){content={itemId:actor.untrackedItemId,name:'Тестовое блюдо 2',priceMinor:10000+actor.actions,fields:{priceMinor:10000+actor.actions}};response=await call('price-write',`/api/items/${encodeURIComponent(actor.untrackedItemId)}`,{method:'PATCH',mutationActor:actor,headers:headers(actor),body:{priceMinor:10000+actor.actions}});}
 else{actor.breakActive=!actor.breakActive;content={breakActive:actor.breakActive};response=await call('break-write',`/api/venue/break/${actor.breakActive?'start':'stop'}`,{method:'POST',mutationActor:actor,headers:headers(actor),body:actor.breakActive?{durationMinutes:1}:{}});}
 if(response?.ok){
   successfulWrites++;const changedAt=performance.now();
   const screen=fixture.screens.find(s=>s.venueId===actor.venueId&&s.type==='modern');
   if(screen){const state=await call('write-version-probe','/api/menu/version',{headers:{authorization:`Bearer ${screen.token}`},check:data=>Number.isFinite(data?.version)});
     if(state.ok){const expected=activeScreens.filter(s=>s.venueId===actor.venueId);const entry={version:Number(state.data.version),at:changedAt,stage:stageName,content,seen:new Set(),expected:new Set(expected.map(s=>s.id??s.cookie))};if(!pending.has(actor.venueId))pending.set(actor.venueId,[]);pending.get(actor.venueId).push(entry);for(const screen of expected){const cached=snapshots.get(screen.id??screen.cookie);if(cached)acknowledge(screen,entry,cached);}}else stop('write_version_probe_failed');}
 }
}
const stages=profile==='quick'?[{name:'warmup',screens:10,seconds:30},{name:'target50',screens:50,seconds:90}]:profile==='harness'?[{name:'harness',screens:10,seconds:30}]:[
 {name:'warmup',screens:10,seconds:180},{name:'step10',screens:10,seconds:600},{name:'step25',screens:25,seconds:600},{name:'target50',screens:50,seconds:600},
 {name:'reload50',screens:50,seconds:60,reload:true},{name:'soak50',screens:50,seconds:3600},{name:'stress100',screens:100,seconds:300},{name:'stress200',screens:200,seconds:300}];
if(fixture.screens.length<Math.max(...stages.map(s=>s.screens)))throw new Error('Fixture has too few distinct screen credentials.');
await writeFile(path.join(output,'manifest.json'),JSON.stringify({format:'ifm-audit-result-v1',runId:fixture.runId,startedAt,mutationEvidenceVersion:1,harnessSha256,fixtureFingerprint,softwareVersion:cli['software-version']??'unrecorded',profile,harnessOnly:profile==='harness',target:fixture.baseUrl,transport:cli.transport??'unspecified',writesEnabled:Boolean(cli['allow-writes']),resourceMonitorAttached:Boolean(resourceUrl),stages,maxInflight,timeoutMs,notes:['HTTP sessions simulate screens; this is not physical TV evidence.','Initial authentication is excluded; fixtures contain pre-provisioned test sessions.','Appwrite duration is summed SDK time, not database wall time.']},null,2)+'\n');
let identityOk=false;let control=[];
try{
 await verifyApiIdentity(fixture,{timeoutMs,signal:controller.signal});identityOk=true;
 // Capture stock at actual run start, allowing baseline/fixed comparisons after
 // a deliberate reseed, or independent read-only runs without assuming seed age.
 for(const actor of fixture.staff){
   const response=await call('initial-stock','/api/menu',{headers:headers(actor),check:data=>data?.venue?.id===actor.venueId});
   const item=response.data?.items?.find(i=>i.id===actor.itemId);
   if(!response.ok||!Number.isInteger(item?.stockQuantity))throw new Error('Initial stock control failed.');
   actor.initialStock=item.stockQuantity;
   for(const itemId of [actor.itemId,actor.untrackedItemId]){const candidate=response.data.items.find(row=>row.id===itemId);initialItemStates[itemId]={venueId:actor.venueId,...itemState(candidate)};}
 }
 for(const stage of stages){
   if(stopped)break;stageName=stage.name;const stageStart=performance.now(),end=stageStart+stage.seconds*1000*scale;const sampleStart=samples.length,dropStart=dropped;
   const screens=fixture.screens.slice(0,stage.screens).map((screen,i)=>({...screen,next:stageStart+(stage.reload?0:i/stage.screens*(screen.type==='server'?15000:5000)*scale),initial:true,busy:false}));
   activeScreens=screens;
   const staff=fixture.staff.slice(0,Math.min(10,Math.max(2,Math.round(stage.screens/5)))).map((actor,i)=>({...actor,nextRead:stageStart+i*700*scale,nextWrite:stageStart+(10000+i*1000)*scale,actions:0,breakActive:false,busy:false}));
   const hubCount=stage.screens>=50?2:1;
   const hubs=Array.from({length:hubCount},(_,i)=>({...(fixture.operators?.[i]??fixture.hub),next:stageStart+i*15000*scale,index:i,busy:false}));
   logEvent('stage_started',{screens:stage.screens,staff:staff.length,operators:hubCount,seconds:stage.seconds});
   let nextStopCheck=stageStart,nextWindow=stageStart+60000*scale;
   while(!stopped&&performance.now()<end){
     const now=performance.now();
     if(now>=nextStopCheck){nextStopCheck=now+Math.max(50,1000*scale);if(await access(stopFile).then(()=>true,()=>false)){stop('stop_file');break;}if(resourceUrl){const resource=await requestFull(resourceUrl.origin,resourceUrl.pathname,{timeoutMs:5000,signal:controller.signal});const decision=inspectResourceSample(lastResourceSample,resource,fixture.runId);lastResourceSample=decision.last;if(decision.readFailed){resourceReadFailures++;logEvent('resource_sample_read_failed',{status:resource.status,error:resource.error??'invalid_sample'});}if(decision.reason){stop(decision.reason);break;}}}
     for(const screen of screens)if(now>=screen.next){screen.next=now+(screen.type==='server'?15000:5000)*scale;const initial=screen.initial;screen.initial=false;schedule(()=>initial?screenMenu(screen):pollScreen(screen),screen);}
     for(const actor of staff){
       if(now>=actor.nextRead){actor.nextRead=now+15000*scale;schedule(()=>call('staff-menu','/api/menu',{headers:headers(actor),check:data=>data?.venue?.id===actor.venueId}),actor);}
       if(cli['allow-writes']&&now>=actor.nextWrite){actor.nextWrite=now+30000*scale;schedule(()=>staffAction(actor),actor);}
     }
     for(const hub of hubs)if(now>=hub.next){hub.next=now+30000*scale;const venueId=fixture.venueIds[hub.index++%fixture.venueIds.length];schedule(()=>call('hub-statistics',`/api/hub/venues/${encodeURIComponent(venueId)}/statistics`,{headers:headers(hub),check:data=>data?.venueId===venueId&&typeof data.counts==='object'}),hub);}
     if(now>=nextWindow){
       const window=samples.slice(sampleStart).filter(row=>Date.parse(row.at)>=Date.now()-60000*scale);const summary=summarize(window);nextWindow=now+60000*scale;
       if(window.length>=20&&summary.failures/window.length>.05)stop('error_rate_over_5_percent');
       else if(window.length>=20&&summary.p95Ms>3000)stop('p95_over_3000ms');
     }
     await new Promise(resolve=>setTimeout(resolve,Math.max(5,20*scale)));
   }
   await Promise.allSettled([...inflight]);
   logEvent('stage_completed',{screens:stage.screens,elapsedSeconds:(performance.now()-stageStart)/1000,dropped:dropped-dropStart,summary:summarize(samples.slice(sampleStart))});
 }
 if(!stopped && cli['allow-writes']){
   stageName='delivery_grace';const graceEnd=performance.now()+17000*scale;
   while(!stopped&&performance.now()<graceEnd&&[...pending.values()].flat().some(e=>e.seen.size<e.expected.size)){for(const screen of activeScreens)if(performance.now()>=screen.next){screen.next=performance.now()+(screen.type==='server'?15000:5000)*scale;schedule(()=>pollScreen(screen),screen);}await new Promise(r=>setTimeout(r,Math.max(5,20*scale)));}
   await Promise.allSettled([...inflight]);
 }
}catch(error){stop(identityOk?'control_or_runtime_failure':'identity_check_failed');}
finally{
 await Promise.allSettled([...inflight]);
 if(identityOk&&!controller.signal.aborted){
   stageName='verification';
   for(const actor of fixture.staff){
     const response=await call('final-stock','/api/menu',{headers:headers(actor),check:data=>data?.venue?.id===actor.venueId});
     const actual=response.data?.items?.find(item=>item.id===actor.itemId)?.stockQuantity;const expected=actor.initialStock+(writes[actor.itemId]??0);
     control.push({itemId:actor.itemId,initial:actor.initialStock,successfulDelta:writes[actor.itemId]??0,expected,actual:actual??null,ok:response.ok&&actual===expected});
   }
 }
 const grouped={};for(const row of samples){const key=`${row.stage}/${row.route}`;(grouped[key]??=[]).push(row);}
 const entries=[...pending.values()].flat();const expectedReceipts=entries.reduce((n,e)=>n+e.expected.size,0);const missingReceipts=entries.reduce((n,e)=>n+e.expected.size-e.seen.size,0);
 const deliveryPassed=!cli['allow-writes']||(successfulWrites>0&&expectedReceipts>0&&missingReceipts===0&&delivery.every(row=>row.lagMs<=row.intervalMs+2000));
 const nominalStages=new Set(['step10','step25','target50','soak50']);const slo=[];for(const [key,rows]of Object.entries(grouped)){const [stage,route]=key.split('/');if(!nominalStages.has(stage)||route==='write-version-probe')continue;const limit=route==='hub-statistics'||route==='tv-menu'?2000:['stock-adjust','availability-write','price-write','break-write'].includes(route)?1000:500;const stats=summarize(rows);slo.push({stage,route,count:stats.count,limitMs:limit,p95Ms:stats.p95Ms,errorRate:stats.failures/stats.count,passed:stats.p95Ms<=limit&&stats.failures/stats.count<.01});}
 const report={format:'ifm-audit-result-v1',runId:fixture.runId,startedAt,endedAt:new Date().toISOString(),profile,harnessOnly:profile==='harness',identityVerified:identityOk,resourceReadFailures,stopped:stopped,stopReason,dropped,summary:summarize(samples),routes:Object.fromEntries(Object.entries(grouped).map(([key,rows])=>[key,summarize(rows)])),acceptance:{integrityPassed:control.length===fixture.staff.length&&control.every(row=>row.ok),sloPassed:slo.length?slo.every(row=>row.passed):null,routeChecks:slo,deliveryPassed},delivery:{successfulWrites,expectedReceipts,missingReceipts,count:delivery.length,p95Ms:percentile(delivery.map(row=>row.lagMs),.95),violations:delivery.filter(row=>row.lagMs>row.intervalMs+2000).length},initialItemStates,mutationEvidenceVersion:1,stockChecks:control,passed:identityOk&&!stopped&&dropped===0&&samples.every(row=>row.ok)&&control.length===fixture.staff.length&&control.every(row=>row.ok)&&deliveryPassed&&slo.every(row=>row.passed)};
 await writeFile(path.join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
 measurements.end();events.end();await Promise.all([new Promise(r=>measurements.on('finish',r)),new Promise(r=>events.on('finish',r))]);
 console.log(JSON.stringify({event:'audit_run_complete',runId:fixture.runId,profile,harnessOnly:profile==='harness',passed:report.passed,stopReason,requests:samples.length,failures:report.summary.failures,output}));
 if(!report.passed)process.exitCode=1;
}
