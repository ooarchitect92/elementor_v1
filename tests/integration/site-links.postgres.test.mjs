/** Live PostgreSQL + compiled Express router. Identity is injected in the test
 * router only; this does NOT certify the full browser/requireAuth/Prisma pipeline.
 * Creates/drops only its own random database on loopback, never an existing DB.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runSiteLinkCommand } from '../../backend/dist/modules/tenancy/site-links.core.js';
import { createSiteLinkRouter } from '../../backend/dist/modules/tenancy/site-links.http.js';
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const { Client,Pool }=require('pg'), express=require('express');
if(process.env.SITE_LINK_DISPOSABLE_TEST!=='1')throw new Error('SITE_LINK_DISPOSABLE_TEST=1 required; newly-created loopback database only');
const suffix=randomUUID().replaceAll('-',''),database=`fs_link_test_${suffix}`,role=`fs_link_role_${suffix}`;
const cfg={host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??5432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:'postgres',connectionTimeoutMillis:5000};
let admin,db,pool,server,url,created=false,roleCreated=false;
const ids={owner:randomUUID(),viewer:randomUUID(),other:randomUUID(),a:randomUUID(),b:randomUUID(),w1:randomUUID(),w2:randomUUID(),wb:randomUUID(),so:randomUUID(),sv:randomUUID(),sx:randomUUID()};
const actor=(userId=ids.owner,sessionId=ids.so,tenantId=ids.a)=>({userId,sessionId,tenantId,traceId:randomUUID()});
const sql=(strings,values)=>({text:strings.reduce((out,part,i)=>out+(i?`$${i}`:'')+part,''),values});
async function transaction(work,{elevated=false,beforeAudit=null,client=null}={}){
  const c=client??await pool.connect();
  try{await c.query('BEGIN');if(!elevated)await c.query(`SET LOCAL ROLE "${role}"`);
    const result=await work({$queryRaw:async(s,...v)=>(await c.query(sql(s,v))).rows,
      $executeRaw:async(s,...v)=>{if(beforeAudit&&s.join('').includes('INSERT INTO platform.audit_events'))await beforeAudit();return(await c.query(sql(s,v))).rowCount;}});
    await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{if(!client)c.release();}
}
const run=(command,who=actor(),options={})=>transaction(tx=>runSiteLinkCommand(tx,who,command,randomUUID(),randomUUID()),options);
const attach=(siteId,workspaceId=ids.w1)=>({kind:'attach',siteId,workspaceId});
const detach=(siteId,linkId,workspaceId=ids.w1)=>({kind:'detach',siteId,linkId,workspaceId});
const list=(workspaceId=ids.w1,view='linked',limit=50,after=null)=>({kind:'list',workspaceId,view,limit,after});
const code=expected=>error=>error.code===expected;
async function site(owner=ids.owner){const id=randomUUID();await db.query('INSERT INTO public.websites(id,"userId",name,slug,status,"editorData") VALUES($1,$2,$3,$4,$5,$6)',[id,owner,'Fixture site',`site-${id}`,'DRAFT',JSON.stringify({private:'unchanged',elements:[{id:1}]})]);return id;}
const linkCount=async id=>(await db.query('SELECT count(*)::int AS n FROM platform.site_links WHERE site_id=$1',[id])).rows[0].n;
const auditCount=async id=>(await db.query('SELECT count(*)::int AS n FROM platform.audit_events WHERE resource_id=$1',[id])).rows[0].n;
before(async()=>{
  admin=new Client(cfg);await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;
  db=new Client({...cfg,database});await db.connect();
  for(const file of ['001_platform.sql','002_membership_context.sql','003_workspaces.sql'])await db.query(await readFile(new URL(`../../infrastructure/postgres/${file}`,import.meta.url),'utf8'));
  // Minimal legacy-schema fixture with the actual column names/types used here.
  await db.query(`CREATE TABLE public.users(id uuid PRIMARY KEY,status text NOT NULL);
    CREATE TABLE public.sessions(id uuid PRIMARY KEY,"userId" uuid REFERENCES public.users(id),"revokedAt" timestamp,"expiresAt" timestamp NOT NULL);
    CREATE TABLE public.websites(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES public.users(id),name text NOT NULL,slug text NOT NULL,status text NOT NULL,"editorData" jsonb NOT NULL);`);
  await db.query(await readFile(new URL('../../infrastructure/postgres/004_site_links.sql',import.meta.url),'utf8'));
  for(const user of [ids.owner,ids.viewer,ids.other])await db.query("INSERT INTO public.users VALUES($1,'ACTIVE')",[user]);
  for(const [session,user]of [[ids.so,ids.owner],[ids.sv,ids.viewer],[ids.sx,ids.other]])await db.query(`INSERT INTO public.sessions(id,"userId","expiresAt") VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+interval '1 hour')`,[session,user]);
  await db.query("INSERT INTO platform.tenants(id,name) VALUES($1,'A'),($2,'B')",[ids.a,ids.b]);
  for(const [tenant,user,permission]of [[ids.a,ids.owner,'OWNER'],[ids.b,ids.owner,'OWNER'],[ids.a,ids.viewer,'VIEWER'],[ids.a,ids.other,'ADMIN']])await db.query('INSERT INTO platform.memberships(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenant,user,permission]);
  for(const [tenant,w]of [[ids.a,ids.w1],[ids.a,ids.w2],[ids.b,ids.wb]])await db.query(`INSERT INTO platform.workspaces(tenant_id,id,name,slug,created_by,create_key,create_name,create_slug) VALUES($1,$2,'Fixture',$3,$4,$5,'Fixture',$3)`,[tenant,w,`ws-${w}`,ids.owner,randomUUID()]);
  await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);roleCreated=true;
  await db.query(`GRANT USAGE ON SCHEMA public,platform TO "${role}";
    GRANT SELECT ON public.users,public.sessions,public.websites,platform.tenants,platform.memberships,platform.workspaces,platform.site_links TO "${role}";
    GRANT UPDATE(id) ON public.users,public.sessions,public.websites,platform.tenants,platform.workspaces TO "${role}";
    GRANT UPDATE(version) ON platform.memberships TO "${role}";
    GRANT INSERT,DELETE ON platform.site_links TO "${role}";
    GRANT INSERT ON platform.audit_events TO "${role}";`);
  pool=new Pool({...cfg,database,max:6});
  const app=express();app.use(express.json());
  app.use('/links',createSiteLinkRouter({
    authenticate:(req,res,next)=>{if(req.get('x-fixture-auth')!=='owner')return res.status(401).json({success:false});res.locals.user={id:ids.owner};res.locals.session={id:ids.so};next();},
    selectTenant:(_req,res,next)=>{res.locals.tenant={tenantId:ids.a};next();},transaction,newId:randomUUID,trustedOrigin:()=> 'https://builder.example',production:()=>true,
  }));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}/links/workspaces/${ids.w1}`;
});
after(async()=>{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(pool)await pool.end();if(db)await db.end();
  if(admin){if(created)await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);if(roleCreated)await admin.query(`DROP ROLE "${role}"`);await admin.end();}
});
test('PG: linking persists one association/audit and leaves website ownership/content untouched',async()=>{
  const s=await site(),before=(await db.query('SELECT * FROM public.websites WHERE id=$1',[s])).rows[0];
  const result=await run(attach(s));assert.equal(result.created,true);assert.equal(result.link.siteId,s);assert.equal(await linkCount(s),1);assert.equal(await auditCount(s),1);
  assert.deepEqual((await db.query('SELECT * FROM public.websites WHERE id=$1',[s])).rows[0],before);
});
test('PG: simultaneous duplicate PUTs converge to one link and one audit',async()=>{
  const s=await site();const [a,b]=await Promise.all([run(attach(s)),run(attach(s))]);assert.equal(a.link.id,b.link.id);assert.notEqual(a.created,b.created);assert.equal(await auditCount(s),1);
});
test('PG: simultaneous different-workspace assignments cannot create two links',async()=>{
  const s=await site(),out=await Promise.allSettled([run(attach(s)),run(attach(s,ids.w2))]);assert.equal(out.filter(r=>r.status==='fulfilled').length,1);assert.equal(out.find(r=>r.status==='rejected').reason.code,'SITE_LINK_CONFLICT');assert.equal(await linkCount(s),1);
});
test('PG: owner in two tenants cannot bypass a hidden global assignment',async()=>{
  const s=await site();await run(attach(s));await assert.rejects(run(attach(s,ids.wb),actor(ids.owner,ids.so,ids.b)),code('SITE_LINK_CONFLICT'));assert.equal(await linkCount(s),1);
});
test('PG: tenant admin cannot link or list another owner private website',async()=>{
  const s=await site();await run(attach(s));const who=actor(ids.other,ids.sx);
  await assert.rejects(run(attach(s),who),code('SITE_NOT_AVAILABLE'));assert.equal((await run(list(),who)).sites.some(row=>row.id===s),false);
});
test('PG: viewer cannot mutate even a website they personally own',async()=>{const s=await site(ids.viewer);await assert.rejects(run(attach(s),actor(ids.viewer,ids.sv)),code('LINK_PERMISSION_DENIED'));});
test('PG: archived workspace blocks new links but permits exact unlink',async()=>{
  const s=await site(),out=await run(attach(s));await db.query("UPDATE platform.workspaces SET status='ARCHIVED' WHERE id=$1",[ids.w1]);
  try{await assert.rejects(run(attach(await site())),code('WORKSPACE_ARCHIVED'));assert.equal((await run(detach(s,out.link.id))).removed,true);}finally{await db.query("UPDATE platform.workspaces SET status='ACTIVE' WHERE id=$1",[ids.w1]);}
});
test('PG: unlink removes only association, preserving the website and audit trail',async()=>{const s=await site(),out=await run(attach(s));await run(detach(s,out.link.id));assert.equal(await linkCount(s),0);assert.equal((await db.query('SELECT count(*)::int AS n FROM public.websites WHERE id=$1',[s])).rows[0].n,1);assert.equal(await auditCount(s),2);});
test('PG: stale unlink cannot remove a subsequently recreated link (ABA)',async()=>{const s=await site(),a=await run(attach(s));await run(detach(s,a.link.id));const b=await run(attach(s));assert.notEqual(a.link.id,b.link.id);await assert.rejects(run(detach(s,a.link.id)),code('SITE_LINK_CHANGED'));assert.equal(await linkCount(s),1);});
test('PG: concurrent unlink produces one removal and one stale precondition',async()=>{const s=await site(),a=await run(attach(s));const results=await Promise.allSettled([run(detach(s,a.link.id)),run(detach(s,a.link.id))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'SITE_LINK_CHANGED');assert.equal(await auditCount(s),2);});
test('PG: revoked sessions are rechecked inside the operation',async()=>{
  const s=await site();await db.query('UPDATE public.sessions SET "revokedAt"=now() WHERE id=$1',[ids.so]);try{await assert.rejects(run(attach(s)),code('SESSION_NOT_ACTIVE'));}finally{await db.query('UPDATE public.sessions SET "revokedAt"=NULL WHERE id=$1',[ids.so]);}
});
test('PG: suspended membership cannot read linked metadata',async()=>{await db.query("UPDATE platform.memberships SET status='SUSPENDED' WHERE user_id=$1 AND tenant_id=$2",[ids.owner,ids.a]);try{await assert.rejects(run(list()),code('TENANT_ACCESS_DENIED'));}finally{await db.query("UPDATE platform.memberships SET status='ACTIVE' WHERE user_id=$1 AND tenant_id=$2",[ids.owner,ids.a]);}});
test('PG: suspended account cannot assign a site',async()=>{const s=await site();await db.query("UPDATE public.users SET status='SUSPENDED' WHERE id=$1",[ids.owner]);try{await assert.rejects(run(attach(s)),code('SESSION_NOT_ACTIVE'));}finally{await db.query("UPDATE public.users SET status='ACTIVE' WHERE id=$1",[ids.owner]);}});
test('PG: audit failure rolls back both attach and unlink',async()=>{
  const s=await site(),bound=await site(),result=await run(attach(bound));await db.query(`REVOKE INSERT ON platform.audit_events FROM "${role}"`);
  try{await assert.rejects(run(attach(s)));assert.equal(await linkCount(s),0);await assert.rejects(run(detach(bound,result.link.id)));assert.equal(await linkCount(bound),1);}finally{await db.query(`GRANT INSERT ON platform.audit_events TO "${role}"`);}
});
async function direct(who,query,values=[]){const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE "${role}"`);await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[who?.userId??'',who?.tenantId??'']);return await c.query(query,values);}finally{await c.query('ROLLBACK');c.release();}}
test('PG: no transaction scope yields no site link rows',async()=>assert.equal((await direct(null,'SELECT * FROM platform.site_links')).rowCount,0));
test('PG: direct SQL cannot read another owner links or insert a forged one',async()=>{
  const s=await site();await run(attach(s));const who=actor(ids.other,ids.sx);assert.equal((await direct(who,'SELECT * FROM platform.site_links WHERE site_id=$1',[s])).rowCount,0);
  const other=await site();await assert.rejects(direct(who,'INSERT INTO platform.site_links(id,tenant_id,workspace_id,site_id,created_by) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ids.a,ids.w1,other,ids.other]),code('42501'));
});
test('PG: direct SQL cannot cross tenants without membership',async()=>{
  const s=await site(ids.other);await assert.rejects(direct(actor(ids.other,ids.sx,ids.b),'INSERT INTO platform.site_links(id,tenant_id,workspace_id,site_id,created_by) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ids.b,ids.wb,s,ids.other]),code('42501'));
});
test('PG: no UPDATE privilege permits identity rewrite and no audit deletion grant exists',async()=>{
  await assert.rejects(direct(actor(),"UPDATE platform.site_links SET created_by=$1",[ids.other]),code('42501'));await assert.rejects(direct(actor(),'DELETE FROM platform.audit_events'),code('42501'));
});
test('PG: elevated database credentials are rejected',async()=>{await assert.rejects(run(list(),actor(),{elevated:true}),code('UNSAFE_DATABASE_ROLE'));});
test('PG: pooled connections drop user and tenant scope after COMMIT',async()=>{const c=await pool.connect();try{await run(list(),actor(),{client:c});const r=(await c.query("SELECT current_setting('app.user_id',true) AS u,current_setting('app.tenant_id',true) AS t")).rows[0];assert.ok(!r.u&&!r.t);}finally{c.release();}});
test('PG: list pagination returns metadata only, not editorData',async()=>{
  const a=await run(list(ids.w1,'owned',1));assert.equal(a.sites.length,1);assert.ok(a.nextCursor);assert.equal(a.sites[0].editorData,undefined);
  const b=await run(list(ids.w1,'owned',1,a.nextCursor));assert.notEqual(b.sites[0].id,a.sites[0].id);
});
test('PG: site ownership and workspace archive changes wait for authorized in-flight assignment', {timeout:15000},async()=>{
  const s=await site();let release,arrive;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrive=r);
  const pending=run(attach(s),actor(),{beforeAudit:async()=>{arrive();await gate;}});
  await Promise.race([ready,pending.then(()=>{throw new Error('Missing audit gate');})]);
  try{await db.query("SET lock_timeout='200ms'");await assert.rejects(db.query('UPDATE public.websites SET "userId"=$1 WHERE id=$2',[ids.other,s]),code('55P03'));await assert.rejects(db.query("UPDATE platform.workspaces SET status='ARCHIVED' WHERE id=$1",[ids.w1]),code('55P03'));}
  finally{release();await pending;await db.query("SET lock_timeout='0'");}
});
const headers={'x-fixture-auth':'owner',Origin:'https://builder.example','Content-Type':'application/json','X-ForgeStudio-Request':'workspace-v1'};
test('HTTP+PG: actual router attaches, lists and unlinks with durable acknowledgements',async()=>{
  const s=await site(),path=`${url}/sites/${s}`;let response=await fetch(path,{method:'PUT',headers,body:'{}'});assert.equal(response.status,201);const body=await response.json();assert.equal(await linkCount(s),1);
  response=await fetch(url,{headers});assert.equal(response.headers.get('cache-control'),'no-store');assert.ok((await response.json()).sites.some(row=>row.id===s));
  response=await fetch(path,{method:'DELETE',headers:{...headers,'If-Match':`"${body.link.id}"`},body:'{}'});assert.equal(response.status,200);assert.equal(await linkCount(s),0);
});
test('HTTP+PG: missing authentication/CSRF and injected authority fields fail before writing',async()=>{
  const s=await site(),path=`${url}/sites/${s}`;
  assert.equal((await fetch(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(path,{method:'PUT',headers:{...headers,Origin:'https://attacker.example'},body:'{}'})).status,403);
  assert.equal((await fetch(path,{method:'PUT',headers,body:JSON.stringify({tenantId:ids.b})})).status,400);assert.equal(await linkCount(s),0);
});
test('HTTP+PG: missing unlink precondition is 428; stale one is 412',async()=>{
  const s=await site(),out=await run(attach(s)),path=`${url}/sites/${s}`;
  assert.equal((await fetch(path,{method:'DELETE',headers,body:'{}'})).status,428);
  assert.equal((await fetch(path,{method:'DELETE',headers:{...headers,'If-Match':`"${randomUUID()}"`},body:'{}'})).status,412);assert.equal((await run(attach(s))).link.id,out.link.id);
});
test('HTTP+PG: audit error returns sanitized 503 and no phantom assignment',async()=>{
  const s=await site();await db.query(`REVOKE INSERT ON platform.audit_events FROM "${role}"`);
  try{const response=await fetch(`${url}/sites/${s}`,{method:'PUT',headers,body:'{}'});assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'SITE_LINK_SERVICE_UNAVAILABLE');assert.equal(body.success,false);assert.ok(!JSON.stringify(body).includes('permission denied'));assert.equal(await linkCount(s),0);}finally{await db.query(`GRANT INSERT ON platform.audit_events TO "${role}"`);}
});
test('migration: refuses a reused schema version rather than silently adopting another branch',async()=>{
  try{await assert.rejects(db.query(await readFile(new URL('../../infrastructure/postgres/004_site_links.sql',import.meta.url),'utf8')),/already used/);}finally{await db.query('ROLLBACK');}
});
