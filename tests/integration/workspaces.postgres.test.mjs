/** Destructive fixtures are confined to a newly-created, random local test DB.
 * Never points to an existing application DB. Requires explicit disposable opt-in.
 */
import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {runWorkspaceCommand,createWorkspaceCommand,updateWorkspaceCommand,listWorkspaceCommand} from '../../backend/dist/modules/tenancy/workspace.core.js';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const {Client,Pool}=require('pg');
if(process.env.WORKSPACE_DISPOSABLE_TEST!=='1')throw new Error('Requires WORKSPACE_DISPOSABLE_TEST=1 and local disposable PostgreSQL');
const suffix=randomUUID().replaceAll('-',''),database=`fs_workspace_test_${suffix}`,role=`fs_workspace_role_${suffix}`;
const config={host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??5432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:'postgres',connectionTimeoutMillis:5000};
let admin,db,pool,created=false,roleCreated=false;
const ids={owner:randomUUID(),viewer:randomUUID(),other:randomUUID(),inactive:randomUUID(),tenantA:randomUUID(),tenantB:randomUUID(),sessionA:randomUUID(),sessionV:randomUUID(),sessionB:randomUUID(),sessionI:randomUUID()};
const actor=(userId=ids.owner,sessionId=ids.sessionA,tenantId=ids.tenantA)=>({userId,sessionId,tenantId,traceId:randomUUID()});
const creation=(key=randomUUID(),slug=`ws-${randomUUID()}`)=>createWorkspaceCommand({name:'Workspace',slug},key,randomUUID());
function parameters(strings,values){return {text:strings.reduce((sql,part,index)=>sql+(index?`$${index}`:'')+part,''),values};}
async function execute(who,command,{client=null,elevated=false,beforeAudit=null}={}){
  const c=client??await pool.connect();
  try{await c.query('BEGIN');if(!elevated)await c.query(`SET LOCAL ROLE "${role}"`);
    const result=await runWorkspaceCommand({
      $queryRaw:async(strings,...values)=>(await c.query(parameters(strings,values))).rows,
      $executeRaw:async(strings,...values)=>{if(beforeAudit)await beforeAudit();return (await c.query(parameters(strings,values))).rowCount;},
    },who,command,randomUUID());
    await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{if(!client)c.release();}
}
before(async()=>{
  admin=new Client(config);await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;
  db=new Client({...config,database});await db.connect();
  for(const name of ['001_platform.sql','002_membership_context.sql','003_workspaces.sql'])await db.query(await readFile(new URL(`../../infrastructure/postgres/${name}`,import.meta.url),'utf8'));
  // Migration repeat is safe and does not alter data or existing legacy tables.
  await db.query(await readFile(new URL('../../infrastructure/postgres/003_workspaces.sql',import.meta.url),'utf8'));
  await db.query(`CREATE TABLE public.users(id uuid PRIMARY KEY,status text NOT NULL);
    CREATE TABLE public.sessions(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES public.users(id),"revokedAt" timestamp,"expiresAt" timestamp NOT NULL)`);
  for(const [user,status]of [[ids.owner,'ACTIVE'],[ids.viewer,'ACTIVE'],[ids.other,'ACTIVE'],[ids.inactive,'SUSPENDED']])await db.query('INSERT INTO public.users VALUES($1,$2)',[user,status]);
  for(const [session,user]of [[ids.sessionA,ids.owner],[ids.sessionV,ids.viewer],[ids.sessionB,ids.other],[ids.sessionI,ids.inactive]])await db.query(`INSERT INTO public.sessions(id,"userId","expiresAt") VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+interval '1 hour')`,[session,user]);
  await db.query(`INSERT INTO platform.tenants(id,name) VALUES($1,'Tenant A'),($2,'Tenant B')`,[ids.tenantA,ids.tenantB]);
  for(const [tenant,user,permission]of [[ids.tenantA,ids.owner,'OWNER'],[ids.tenantA,ids.viewer,'VIEWER'],[ids.tenantB,ids.other,'OWNER'],[ids.tenantA,ids.inactive,'OWNER']])await db.query('INSERT INTO platform.memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,user,permission]);
  await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);roleCreated=true;
  await db.query(`GRANT USAGE ON SCHEMA public,platform TO "${role}";
    GRANT SELECT ON public.users,public.sessions,platform.tenants,platform.memberships,platform.workspaces TO "${role}";
    GRANT UPDATE(id) ON public.users,public.sessions,platform.tenants TO "${role}";
    GRANT UPDATE(version) ON platform.memberships TO "${role}";
    GRANT INSERT ON platform.workspaces,platform.audit_events TO "${role}";
    GRANT UPDATE(name,status,version,updated_at) ON platform.workspaces TO "${role}";`);
  pool=new Pool({...config,database,max:5});
});
after(async()=>{if(pool)await pool.end();if(db)await db.end();if(admin){if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);if(roleCreated)await admin.query(`DROP ROLE "${role}"`);await admin.end();}});
const code=expected=>e=>e.code===expected;
test('live PG: non-owner create is persisted with exactly one audit event',async()=>{const cmd=creation();const out=await execute(actor(),cmd);assert.equal(out.workspace.id,cmd.id);assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.audit_events WHERE resource_id=$1',[cmd.id])).rows[0].n,1);});
test('live PG: simultaneous duplicate creates converge to one receipt',async()=>{const cmd=creation();const [a,b]=await Promise.all([execute(actor(),cmd),execute(actor(),{...cmd,id:randomUUID()})]);assert.equal(a.workspace.id,b.workspace.id);assert.notEqual(a.replayed,b.replayed);assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.audit_events WHERE resource_id=$1',[a.workspace.id])).rows[0].n,1);});
test('live PG: key reuse with another payload is rejected',async()=>{const cmd=creation();await execute(actor(),cmd);await assert.rejects(execute(actor(),{...cmd,name:'Other'}),code('IDEMPOTENCY_KEY_REUSED'));});
test('live PG: slug collision is not reported as a completed create',async()=>{const cmd=creation();await execute(actor(),cmd);await assert.rejects(execute(actor(),creation(randomUUID(),cmd.slug)),code('WORKSPACE_SLUG_CONFLICT'));});
test('live PG: tenant selector alone cannot authorize cross-tenant operations',async()=>{await assert.rejects(execute(actor(ids.owner,ids.sessionA,ids.tenantB),creation()),code('TENANT_ACCESS_DENIED'));});
test('live PG: mismatched user and session are rejected',async()=>{await assert.rejects(execute(actor(ids.other,ids.sessionA,ids.tenantB),creation()),code('SESSION_NOT_ACTIVE'));});
test('live PG: suspended user with otherwise valid session is denied',async()=>{await assert.rejects(execute(actor(ids.inactive,ids.sessionI),creation()),code('SESSION_NOT_ACTIVE'));});
test('live PG: viewer can list but cannot create',async()=>{const who=actor(ids.viewer,ids.sessionV);assert.ok(Array.isArray((await execute(who,listWorkspaceCommand({}))).workspaces));await assert.rejects(execute(who,creation()),code('WORKSPACE_PERMISSION_DENIED'));});
test('live PG: stale concurrent updates reject one writer',async()=>{const {workspace}=await execute(actor(),creation());const cmd=updateWorkspaceCommand(workspace.id,{name:'Updated',expectedVersion:'1'});const result=await Promise.allSettled([execute(actor(),cmd),execute(actor(),cmd)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.code,'WORKSPACE_VERSION_CONFLICT');});
test('live PG: replay after rename/archive returns the original create receipt',async()=>{const cmd=creation();const first=await execute(actor(),cmd);await execute(actor(),updateWorkspaceCommand(first.workspace.id,{name:'Renamed',status:'ARCHIVED',expectedVersion:'1'}));const replay=await execute(actor(),cmd);assert.deepEqual(replay.workspace,first.workspace);assert.equal(replay.replayed,true);});
test('live PG: audit insert failure rolls back a workspace insert',async()=>{const cmd=creation();await db.query(`REVOKE INSERT ON platform.audit_events FROM "${role}"`);try{await assert.rejects(execute(actor(),cmd));assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.workspaces WHERE id=$1',[cmd.id])).rows[0].n,0);}finally{await db.query(`GRANT INSERT ON platform.audit_events TO "${role}"`);}});
test('live PG: a pooled connection does not retain either identity after commit',async()=>{const c=await pool.connect();try{await execute(actor(),listWorkspaceCommand({}),{client:c});let scope=(await c.query("SELECT current_setting('app.user_id',true) AS u,current_setting('app.tenant_id',true) AS t")).rows[0];assert.ok(!scope.u&&!scope.t);await execute(actor(ids.other,ids.sessionB,ids.tenantB),listWorkspaceCommand({}),{client:c});scope=(await c.query("SELECT current_setting('app.user_id',true) AS u,current_setting('app.tenant_id',true) AS t")).rows[0];assert.ok(!scope.u&&!scope.t);}finally{c.release();}});
test('live PG: elevated database credentials are refused',async()=>{await assert.rejects(execute(actor(),creation(),{elevated:true}),code('UNSAFE_DATABASE_ROLE'));});
test('live PG: suspended membership is freshly checked',async()=>{await db.query("UPDATE platform.memberships SET status='SUSPENDED' WHERE user_id=$1",[ids.owner]);try{await assert.rejects(execute(actor(),creation()),code('TENANT_ACCESS_DENIED'));}finally{await db.query("UPDATE platform.memberships SET status='ACTIVE' WHERE user_id=$1",[ids.owner]);}});
test('live PG: suspended tenant is freshly checked',async()=>{await db.query("UPDATE platform.tenants SET status='SUSPENDED' WHERE id=$1",[ids.tenantA]);try{await assert.rejects(execute(actor(),creation()),code('TENANT_ACCESS_DENIED'));}finally{await db.query("UPDATE platform.tenants SET status='ACTIVE' WHERE id=$1",[ids.tenantA]);}});
test('live PG: RLS denies forged scope even with direct SQL',async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE "${role}"`);await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[ids.owner,ids.tenantB]);assert.equal((await c.query('SELECT * FROM platform.workspaces')).rowCount,0);await assert.rejects(c.query('INSERT INTO platform.workspaces(tenant_id,id,name,slug,created_by,create_key,create_name,create_slug) VALUES($1,$2,$3,$4,$5,$6,$3,$4)',[ids.tenantB,randomUUID(),'Forged','forged',ids.owner,randomUUID()]),code('42501'));}finally{await c.query('ROLLBACK');c.release();}});
test('live PG: no context means no workspace rows',async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE "${role}"`);await c.query("SELECT set_config('app.user_id','',true),set_config('app.tenant_id','',true)");assert.equal((await c.query('SELECT * FROM platform.workspaces')).rowCount,0);}finally{await c.query('ROLLBACK');c.release();}});
test('live PG: creation receipt columns and audit history cannot be rewritten',async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE "${role}"`);await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[ids.owner,ids.tenantA]);await assert.rejects(c.query("UPDATE platform.workspaces SET create_name='forged'"),code('42501'));await c.query('ROLLBACK');await c.query('BEGIN');await c.query(`SET LOCAL ROLE "${role}"`);await assert.rejects(c.query('DELETE FROM platform.audit_events'),code('42501'));}finally{await c.query('ROLLBACK');c.release();}});
test('live PG: in-flight operation holds session lock; later revocation denies next operation', {timeout:15000},async()=>{
  let release,arrived;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>arrived=resolve);
  const pending=execute(actor(),creation(),{beforeAudit:async()=>{arrived();await gate;}});
  await Promise.race([ready,pending.then(()=>{throw new Error('Expected audit gate');})]);
  try{await db.query("SET lock_timeout='200ms'");await assert.rejects(db.query('UPDATE public.sessions SET "revokedAt"=now() WHERE id=$1',[ids.sessionA]),code('55P03'));}finally{release();await pending;await db.query("SET lock_timeout='0'");}
  await db.query('UPDATE public.sessions SET "revokedAt"=now() WHERE id=$1',[ids.sessionA]);
  try{await assert.rejects(execute(actor(),creation()),code('SESSION_NOT_ACTIVE'));}finally{await db.query('UPDATE public.sessions SET "revokedAt"=NULL WHERE id=$1',[ids.sessionA]);}
});
