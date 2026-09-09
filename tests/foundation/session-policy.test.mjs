import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionToken, sessionDenial } from '../../backend/src/middlewares/session-policy.ts';
const now = new Date('2026-09-09T00:00:00Z');
const valid = () => ({ revokedAt: null, expiresAt: new Date(now.getTime()+60000), user: { status: 'ACTIVE' } });
test('active non-revoked session is accepted', () => assert.equal(sessionDenial(valid(),now),null));
for (const status of ['SUSPENDED','DELETED','UNKNOWN',undefined]) test(`account status ${status} denied`, () => {
  assert.equal(sessionDenial({...valid(),user:{status}},now).code,'ACCOUNT_INACTIVE');
});
test('missing user is denied',()=>assert.equal(sessionDenial({...valid(),user:null},now).status,403));
test('missing session is denied',()=>assert.equal(sessionDenial(null,now).status,401));
test('revoked session is denied',()=>assert.equal(sessionDenial({...valid(),revokedAt:now},now).code,'SESSION_REVOKED'));
for (const expiresAt of [now,new Date(now.getTime()-1),new Date(NaN),'tomorrow']) test(`invalid or expired timestamp ${String(expiresAt)} denied`,()=>{
  assert.equal(sessionDenial({...valid(),expiresAt},now).code,'SESSION_EXPIRED');
});
for (const token of [undefined,null,{},[],42,'','x'.repeat(513)]) test(`malformed token ${typeof token}/${String(token).length} denied`,()=>assert.equal(isSessionToken(token),false));
test('bounded session token accepted',()=>assert.equal(isSessionToken('a'.repeat(64)),true));
