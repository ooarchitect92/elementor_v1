import test from 'node:test';
import assert from 'node:assert/strict';
import { siteListCommand, siteMutationCommand, linkUuid } from '../../backend/src/modules/tenancy/site-links.policy.ts';
import { siteLinkClient } from '../../frontend/src/features/workspaces/site-links-client.ts';
const T='11111111-1111-4111-8111-111111111111',W='22222222-2222-4222-8222-222222222222',S='33333333-3333-4333-8333-333333333333',L='44444444-4444-4444-8444-444444444444';
test('pagination defaults and explicit bounded requests',()=>{
  assert.deepEqual(siteListCommand(W,{}),{kind:'list',workspaceId:W,view:'linked',limit:25,after:null});
  assert.equal(siteListCommand(W,{view:'owned',limit:'50',after:S}).limit,50);
});
for(const query of [{view:'all'},{view:['owned']},{limit:'51'},{limit:'0'},{limit:1},{limit:['2']},{after:'invalid'},{tenantId:T}])test(`reject query ${JSON.stringify(query)}`,()=>assert.throws(()=>siteListCommand(W,query)));
for(const payload of [null,[],{tenantId:T},{userId:T},{role:'OWNER'},{siteId:S},{workspaceId:W}])test(`reject authority payload ${JSON.stringify(payload)}`,()=>assert.throws(()=>siteMutationCommand('attach',W,S,payload)));
test('attach validates paths and accepts only empty JSON',()=>{
  assert.deepEqual(siteMutationCommand('attach',W,S,{}),{kind:'attach',workspaceId:W,siteId:S});
  assert.throws(()=>siteMutationCommand('attach','bad',S,{})); assert.throws(()=>linkUuid({},'id'));
});
for(const etag of [undefined,'*',L,`W/"${L}"`,`"${L}","${L}"`])test(`unlink requires one strong UUID precondition ${etag}`,()=>assert.throws(()=>siteMutationCommand('detach',W,S,{},etag)));
test('unlink captures current immutable link UUID',()=>assert.equal(siteMutationCommand('detach',W,S,{},`"${L}"`).linkId,L));
const fixture=(result,status=200)=>{const calls=[];const api=siteLinkClient('https://api.example',T,W,async(url,options)=>{calls.push({url,options});return Response.json(result,{status});});return{api,calls};};
const signal=()=>new AbortController().signal;
test('PUT request is scoped, credentialed, no-store and JSON with CSRF header',async()=>{
  const {api,calls}=fixture({success:true,created:true,link:{id:L,siteId:S,tenantId:T,workspaceId:W}},201);await api.attach(S,signal());
  const {options}=calls[0];assert.equal(options.method,'PUT');assert.equal(options.body,'{}');assert.equal(options.credentials,'include');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
  assert.equal(options.headers.get('X-ForgeStudio-Tenant'),T);assert.equal(options.headers.get('X-ForgeStudio-Request'),'workspace-v1');
});
test('DELETE sends exact If-Match and never deletes a website endpoint',async()=>{
  const {api,calls}=fixture({success:true,removed:true});await api.detach(S,L,signal());
  assert.equal(calls[0].options.headers.get('If-Match'),`"${L}"`);assert.ok(calls[0].url.includes('/site-links/'));assert.equal(calls[0].options.method,'DELETE');
});
test('wrong-tenant receipt is not acknowledged',async()=>{const {api}=fixture({success:true,created:true,link:{id:L,siteId:S,tenantId:S,workspaceId:W}});await assert.rejects(api.attach(S,signal()),{code:'INVALID_RESPONSE'});});
test('no forged success from malformed response',async()=>{await assert.rejects(fixture({success:true}).api.attach(S,signal()),{code:'INVALID_RESPONSE'});await assert.rejects(fixture({success:true,removed:false}).api.detach(S,L,signal()),{code:'INVALID_RESPONSE'});});
test('raw database error text is not exposed',async()=>{const {api}=fixture({success:false,code:'SITE_LINK_CONFLICT',message:'password=secret'},409);await assert.rejects(api.attach(S,signal()),e=>e.code==='SITE_LINK_CONFLICT'&&!e.message.includes('secret'));});
test('unknown 503 and invalid auth JSON stay failures',async()=>{await assert.rejects(fixture({success:false},503).api.attach(S,signal()),{code:'SERVICE_UNAVAILABLE'});await assert.rejects(fixture({success:false},401).api.list('linked',null,signal()),{code:'SESSION_NOT_ACTIVE'});});
test('list rejects impossible linked rows and repeated cursors',async()=>{
  const site={id:S,name:'My site',slug:'mine',status:'DRAFT',linkId:L,linkedAt:'2026-09-10T00:00:00Z'};
  assert.equal((await fixture({success:true,sites:[site],nextCursor:null}).api.list('linked',null,signal())).sites.length,1);
  await assert.rejects(fixture({success:true,sites:[{...site,linkId:null}],nextCursor:null}).api.list('linked',null,signal()));
  await assert.rejects(fixture({success:true,sites:[site,site],nextCursor:null}).api.list('linked',null,signal()));
  await assert.rejects(fixture({success:true,sites:[site],nextCursor:S}).api.list('linked',S,signal()));
});
test('owned-site list makes no eligibility promise',async()=>{const out=await fixture({success:true,sites:[{id:S,name:'Mine',slug:'mine',status:'DRAFT',linkId:null,linkedAt:null}],nextCursor:null}).api.list('owned',null,signal());assert.equal(out.sites[0].linkId,null);});
test('network failure never retries a mutation',async()=>{let n=0;const api=siteLinkClient('',T,W,async()=>{n++;throw new Error('socket');});await assert.rejects(api.attach(S,signal()),{code:'NETWORK_ERROR'});assert.equal(n,1);});
test('credentials in configured endpoint URL are rejected',()=>assert.throws(()=>siteLinkClient('https://secret:pass@api.example',T,W)));
