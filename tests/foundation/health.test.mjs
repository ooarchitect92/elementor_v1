import test from 'node:test';
import assert from 'node:assert/strict';
import {liveness,readiness,requestContext} from '../../backend/src/platform/health.ts';
function response(){return {headers:{},locals:{},statusCode:0,body:null,setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};}
test('liveness does not require a database',()=>{const r=response();liveness({},r);assert.equal(r.statusCode,200);});
test('readiness distinguishes dependency failure from liveness',async()=>{const r=response();await readiness(async()=>{throw Error('secret connection details');})({},r);assert.equal(r.statusCode,503);assert.equal(JSON.stringify(r.body).includes('secret'),false);});
test('readiness returns 200 after a real probe resolves',async()=>{const r=response();await readiness(async()=>1)({},r);assert.equal(r.statusCode,200);});
test('concurrent hung probes are deduplicated and timeout',async()=>{let calls=0;const handler=readiness(()=>{calls++;return new Promise(()=>{});},5);const a=response(),b=response();await Promise.all([handler({},a),handler({},b)]);assert.equal(calls,1);assert.equal(a.statusCode,503);assert.equal(b.statusCode,503);});
test('invalid request IDs are replaced and never echoed',()=>{const r=response();let next=false;requestContext({headers:{'x-request-id':'evil\r\nheader'}},r,()=>{next=true;});assert.match(r.headers['X-Request-ID'],/^[0-9a-f-]{36}$/);assert.equal(next,true);});
