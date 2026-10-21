import { createRequire } from 'node:module';
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { args, assertTestUrl, externalPath, jwt, loadJsonExternal, repoRoot, requestFull, verifyApiIdentity } from './lib.mjs';

const cli = args();
const command = cli._[0];
if (!['preflight', 'seed', 'verify', 'cleanup'].includes(command) || !cli.config) throw new Error('Usage: node tests/load/stand.mjs preflight|seed|verify|cleanup --config /external/audit.json [--allow-seed|--allow-cleanup]');
const config = await loadJsonExternal(cli.config);
if (!/^[a-z0-9-]{3,16}$/.test(config.runId ?? '') || config.sessionSecret?.length < 32) throw new Error('Invalid audit runId/session secret.');
config.baseUrl = assertTestUrl(config.baseUrl); config.origin = assertTestUrl(config.origin);
assertTestUrl(config.appwrite.endpoint);
for (const key of ['projectId', 'databaseId', 'bucketId']) if (config.appwrite[key] !== `ifm-audit-${config.runId}`) throw new Error(`Isolated ${key} must equal ifm-audit-${config.runId}.`);
const fixturePath = await externalPath(config.fixturePath, { existing: false });
const require = createRequire(repoRoot + '/backend-api/package.json');
const { Client, TablesDB, Query } = require('node-appwrite');
const client = new Client().setEndpoint(config.appwrite.endpoint).setProject(config.appwrite.projectId).setKey(config.appwrite.apiKey).setSelfSigned(config.appwrite.selfSigned === true);
const tables = new TablesDB(client);
const databaseId = config.appwrite.databaseId;
const prefix = `a${config.runId}`;
const tableIds = ['operators','venues','categories','items','display_tokens','display_pairings','staff_accounts','staff_invites','statistics_events','client_logs','admin_audit_logs'];
const id = (kind, venue = 0, number = 0) => `${prefix}${kind}${String(venue).padStart(2,'0')}-${String(number).padStart(5,'0')}`;
async function all(tableId) {
  const rows = []; let cursor;
  for (;;) {
    const page = await tables.listRows({ databaseId, tableId, queries: [Query.limit(500), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
    rows.push(...page.rows); if (page.rows.length < 500) return rows; cursor = page.rows.at(-1).$id;
  }
}
async function assertOwned() {
  const counts = {};
  for (const tableId of tableIds) {
    const rows = await all(tableId);
    if (rows.some(row => !row.$id.startsWith(prefix) && !['statistics_events','client_logs','admin_audit_logs','display_pairings','staff_invites'].includes(tableId))) throw new Error('Foreign rows found in audit database; refusing mutation.');
    const venues = new Set(Array.from({length:10},(_,i)=>id('v',i)));
    if (rows.some(row => row.venueId && !venues.has(row.venueId))) throw new Error('Foreign venue references found; refusing mutation.');
    counts[tableId] = rows.length;
  }
  return counts;
}
async function put(tableId, rowId, data) {
  try { await tables.createRow({ databaseId, tableId, rowId, data }); }
  catch (error) {
    if (!(cli['resume-seed'] && error.code === 409)) throw error;
    const row = await tables.getRow({ databaseId, tableId, rowId });
    if (row.venueId && data.venueId !== row.venueId) throw new Error('Seed collision.');
    if (['operators','staff_accounts'].includes(tableId)) await tables.updateRow({databaseId,tableId,rowId,data:{passwordHash:data.passwordHash}});
  }
}
const ready = await requestFull(config.baseUrl, '/ready');
if (!ready.ok || ready.data?.status !== 'ready' || ready.data?.datastore && ready.data.datastore !== 'appwrite') throw new Error('Test API is not ready on Appwrite.');
await tables.get({ databaseId });
for (const tableId of tableIds) await tables.getTable({ databaseId, tableId });
let counts = await assertOwned();
if (command === 'preflight') {
  console.log(JSON.stringify({ event:'audit_preflight', runId:config.runId, datastore:'appwrite', counts, note:'No data mutations; an empty stand still needs seed identity verification.' }));
} else if (command === 'seed') {
  if (!cli['allow-seed']) throw new Error('Seed requires --allow-seed on the isolated stand.');
  if (!cli['resume-seed'] && Object.values(counts).some(Boolean)) throw new Error('Seed requires an empty database, or explicit --resume-seed.');
  const count = Number(config.statisticsPerVenue ?? 10000);
  if (!Number.isInteger(count) || count < 0 || count > 100000) throw new Error('Invalid statisticsPerVenue.');
  const now = new Date().toISOString();
  const salt = randomBytes(16); const pass = randomBytes(24).toString('base64url');
  const digest = `scrypt:${salt.toString('base64url')}:${scryptSync(pass,salt,64).toString('base64url')}`;
  const { hash } = require('@node-rs/argon2');
  const passwordHash = await hash(pass);
  const fixture = { format:'ifm-audit-v1', runId:config.runId, baseUrl:config.baseUrl, origin:config.origin,
    identity:{ projectId:config.appwrite.projectId, databaseId }, markerVenueId:id('v'), venueIds:[], staff:[], screens:[], operators:[], primaryScreens:50,
    seededAt:now, initialStocks:{}, expected:{ venues:10, staffAccounts:100, screens:200, primaryScreens:50, items:1780, statisticsEvents:count*10 },
    hub:{ cookie:`ifm_hub=${jwt({role:'hub',authType:'emergency'},config.sessionSecret)}` } };
  // The first write is to a dedicated, prefix-checked database. Read it through
  // the API before bulk writes, proving the API is connected to that database.
  const venueData = (v) => ({ name:`AUDIT ${config.runId} ${v+1}`, code:`audit-${config.runId}-${v+1}`, pinHash:digest, currency:'RUB', backgroundColor:'#56965B', accentColor:'#FFFFFF', pageDurationSeconds:10, displayScalePercent:100, displayScaleMode:'auto', menuRefreshSeconds:15, menuVersion:1, staffVersion:1, displayVersion:1, active:true, showServingSize:true, showCalories:true, updatedAt:now, updatedBy:'audit-seed' });
  await put('venues', id('v'), venueData(0));
  const identity = await requestFull(config.baseUrl,'/api/hub/overview',{headers:{cookie:fixture.hub.cookie}});
  if (!identity.ok || !identity.data?.venues?.some(row=>row.id===id('v') && row.name===venueData(0).name) || identity.data.venues.some(row=>!row.id.startsWith(prefix))) throw new Error('API does not read the isolated test database; bulk seed refused.');
  for (let op=0;op<2;op++) {
    await put('operators',id('o',op),{username:`audit.operator${op}`,passwordHash,active:true,sessionVersion:1,createdAt:now});
    fixture.operators.push({cookie:`ifm_hub=${jwt({role:'hub',authType:'personal',accountId:id('o',op),accountVersion:1},config.sessionSecret)}`});
  }
  for (let v=0;v<10;v++) {
    const venueId=id('v',v); fixture.venueIds.push(venueId);
    if (v) await put('venues',venueId,venueData(v));
    const categoryCount = v<8?6:v===8?10:20;
    const itemCount = v<8?60:v===8?300:1000;
    for(let c=0;c<categoryCount;c++) await put('categories',id('c',v,c),{venueId,name:`Раздел ${c+1}`,sortOrder:c,updatedAt:now,updatedBy:'audit-seed'});
    for(let n=0;n<itemCount;n++) {
      const tracked=n%2===0; const stock=n%5===0?0:100000;
      await put('items',id('i',v,n),{venueId,categoryId:id('c',v,n%categoryCount),name:n%10===0?`Очень длинное название тестового блюда ${n+1} с подробным описанием состава и варианта подачи`:`Тестовое блюдо ${n+1}`,priceMinor:10000+n,servingSize:'150 г',caloriesKcal:150+n%500,sortOrder:n,isAvailable:n%5!==0,...(tracked?{stockQuantity:stock}:{}),updatedAt:now,updatedBy:'audit-seed'});
    }
    for(let s=0;s<10;s++) {
      const accountId=id('s',v,s); await put('staff_accounts',accountId,{venueId,username:`audit.worker${s}`,passwordHash,active:true,sessionVersion:1,createdAt:now});
      if (s===0) { const itemId=id('i',v,2); fixture.initialStocks[itemId]=100000; fixture.staff.push({venueId,venueCode:venueData(v).code,username:`audit.worker${s}`,password:pass,cookie:`ifm_staff=${jwt({role:'staff',venueId,version:1,authType:'personal',accountId,accountVersion:1},config.sessionSecret)}`,itemId,untrackedItemId:id('i',v,1)}); }
    }
    for(let n=0;n<count;n+=8) await Promise.all(Array.from({length:Math.min(8,count-n)},async(_,j)=>{
      const x=n+j; const createdAt=new Date(Date.now()-30*86400000+Math.floor(x/Math.max(1,count)*29*86400000)).toISOString();
      await put('statistics_events',id('e',v,x),{venueId,eventType:['item_updated','stock_adjusted','availability_changed','staff_login','display_seen'][x%5],actor:'audit-seed',createdAt});
    }));
    console.log(JSON.stringify({event:'audit_seed_progress',venues:v+1,totalVenues:10}));
  }
  // First 50 = 3 server, 1 modern, 1 React legacy per venue; 150 reserve
  // credentials are used only for the explicitly selected 100/200 stress stages.
  for(let level=0;level<20;level++) for(let v=0;v<10;v++) {
    const venueId=id('v',v); const tokenId=id('d',v,level); const type=['server','server','server','modern','react-legacy'][level%5];
    await put('display_tokens',tokenId,{venueId,tokenHash:digest,active:true,createdAt:now,label:`Audit ${type} ${level+1}`});
    const token=jwt({role:'display',venueId,version:1,displayTokenId:tokenId},config.sessionSecret);
    fixture.screens.push({id:tokenId,venueId,type,cookie:`ifm_tv_session=${token}`,token,width:v%2?1366:1920,height:v%2?768:1080});
  }
  await writeFile(fixturePath,JSON.stringify(fixture,null,2)+'\n',{mode:0o600,flag:cli['resume-seed']?'w':'wx'});
  await verifyApiIdentity(fixture);
  console.log(JSON.stringify({event:'audit_seed_complete',runId:config.runId,counts:await assertOwned(),fixtureWritten:true,credentialsPrinted:false}));
} else if (command === 'verify') {
  const fixture=await loadJsonExternal(fixturePath); await verifyApiIdentity(fixture);
  counts=await assertOwned();
  if(counts.venues!==10||counts.staff_accounts!==100||counts.items!==1780||counts.display_tokens!==200) throw new Error('Seed counts differ from fixture.');
  console.log(JSON.stringify({event:'audit_verify',runId:config.runId,counts}));
} else {
  if(!cli['allow-cleanup'] || cli['confirm-run']!==config.runId) throw new Error('Cleanup requires --allow-cleanup --confirm-run RUN_ID.');
  const fixture=await loadJsonExternal(fixturePath); await verifyApiIdentity(fixture); await assertOwned();
  for(const tableId of ['staff_invites','display_pairings','display_tokens','client_logs','admin_audit_logs','statistics_events','items','categories','staff_accounts','venues','operators']) {
    const rows=await all(tableId);
    for(let n=0;n<rows.length;n+=8) await Promise.all(rows.slice(n,n+8).map(row=>tables.deleteRow({databaseId,tableId,rowId:row.$id})));
  }
  console.log(JSON.stringify({event:'audit_cleanup_complete',runId:config.runId,counts:await assertOwned(),schemaRetained:true}));
}
