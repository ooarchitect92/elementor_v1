import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createWorkspaceRouter } from '../../backend/dist/modules/tenancy/workspace.http.js';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const express = require('express');
const uid=randomUUID(), sid=randomUUID(), tid=randomUUID(), wid=randomUUID(), key=randomUUID();
const row={id:wid,tenant_id:tid,name:'Workspace',slug:'workspace',status:'ACTIVE',version:1n,created_by:uid,created_at:new Date(),updated_at:new Date(),create_key:key,create_name:'Workspace',create_slug:'workspace'};
async function fixture(options={}) {
  let calls=0;
  const app=express();app.use(express.json({limit:'16kb'}));
  app.use('/api/v1/tenancy/workspaces',createWorkspaceRouter({
    authenticate:(_req,res,next)=>{if(options.anonymous)return res.status(401).json({success:false});res.locals.user={id:uid};res.locals.session={id:sid};next();},
    selectTenant:(_req,res,next)=>{res.locals.tenant={tenantId:tid,role:'OWNER'};next();},
    transaction:async work=>{calls++;let index=0;const answers=[[],[{unsafe:false}],[{id:sid}],[{role:options.role??'OWNER'}],[row]];
      const result=await work({$queryRaw:async()=>answers[index++]??[],$executeRaw:async()=>1});
      if(options.commitFails)throw new Error('secret connection URL');return result;},
    newId:randomUUID,trustedOrigin:()=>options.trustedOrigin??'https://builder.example',production:()=>true,
  }));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  return {base:`http://127.0.0.1:${server.address().port}/api/v1/tenancy/workspaces`,calls:()=>calls,close:()=>new Promise(resolve=>server.close(resolve))};
}
const headers={'Content-Type':'application/json',Origin:'https://builder.example','X-ForgeStudio-Request':'workspace-v1','Idempotency-Key':key};
const body=JSON.stringify({name:'Workspace',slug:'workspace'});
async function run(options,fn){const f=await fixture(options);try{await fn(f);}finally{await f.close();}}
test('HTTP: creation returns durable receipt and no cache',()=>run({},async f=>{const r=await fetch(f.base,{method:'POST',headers,body});assert.equal(r.status,201);const data=await r.json();assert.equal(data.workspace.version,'1');assert.equal(data.workspace.id,wid);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('idempotent-replayed'),'false');assert.equal('create_key'in data.workspace,false);}));
test('HTTP: unauthenticated request never starts transaction',()=>run({anonymous:true},async f=>{const r=await fetch(f.base);assert.equal(r.status,401);assert.equal(f.calls(),0);}));
test('HTTP: viewer cannot trust a stale OWNER in response locals',()=>run({role:'VIEWER'},async f=>{const r=await fetch(f.base,{method:'POST',headers,body});assert.equal(r.status,403);assert.equal((await r.json()).code,'WORKSPACE_PERMISSION_DENIED');}));
for(const patch of [{Origin:'https://attacker.example'},{Origin:'null'},{'X-ForgeStudio-Request':''}])test(`HTTP: reject CSRF ${JSON.stringify(patch)}`,()=>run({},async f=>{const r=await fetch(f.base,{method:'POST',headers:{...headers,...patch},body});assert.equal(r.status,403);assert.equal(f.calls(),0);}));
test('HTTP: client cannot choose tenant in request JSON',()=>run({},async f=>{const r=await fetch(f.base,{method:'POST',headers,body:JSON.stringify({name:'Workspace',slug:'workspace',tenantId:randomUUID()})});assert.equal(r.status,400);assert.equal(f.calls(),0);}));
test('HTTP: malformed id rejected',()=>run({},async f=>{const r=await fetch(`${f.base}/bad`);assert.equal(r.status,400);assert.equal(f.calls(),0);}));
test('HTTP: oversized pagination rejected',()=>run({},async f=>{const r=await fetch(`${f.base}?limit=1000`);assert.equal(r.status,400);assert.equal(f.calls(),0);}));
test('HTTP: repeated pagination parameter rejected',()=>run({},async f=>{const r=await fetch(`${f.base}?limit=1&limit=2`);assert.equal(r.status,400);assert.equal(f.calls(),0);}));
test('HTTP: transaction commit failure is not acknowledged as success or leaked',()=>run({commitFails:true},async f=>{const r=await fetch(f.base,{method:'POST',headers,body});assert.equal(r.status,503);const text=await r.text();assert.match(text,/WORKSPACE_SERVICE_UNAVAILABLE/);assert.doesNotMatch(text,/secret connection URL/);}));
test('HTTP: PATCH requires explicit version',()=>run({},async f=>{const r=await fetch(`${f.base}/${wid}`,{method:'PATCH',headers,body:JSON.stringify({name:'Renamed'})});assert.equal(r.status,400);assert.equal(f.calls(),0);}));
