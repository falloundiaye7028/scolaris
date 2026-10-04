import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { amyConfig, amyInput, canUseAmy, createAmyRouter } from '../src/amy-service.js';
import { permissionFor, hasPermission } from '../src/security.js';

const secret=crypto.randomBytes(32).toString('hex');
const me={schoolId:'school-A',sub:'user-A',role:'director'};
const snapshot={computed_at:new Date('2026-10-04T00:00:00Z'),active_students:2,invoice_count:3,outstanding_invoices:1,overdue_invoices:1,expected_xof:'10000',paid_xof:'4000',balance_xof:'6000',overdue_xof:'6000'};
function fixture(options={}) {
  const calls=[],queries=[],responses=[];
  const pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:sql.includes("amy_document_chunks")?[]:[snapshot]}}};
  const router=createAmyRouter({pool,json:(_res,status,data)=>responses.push({status,data}),body:async()=>({question:'Quel est le solde ?',history:[]}),
    env:{AMY_SCOLARIS_SECRET:secret},fetchImpl:async(url,request)=>{calls.push({url,request});return Response.json({answer:'Il reste 6 000 FCFA.'})},...options});
  return {calls,queries,responses,router,run:async(profile=me,path='/api/amy/chat',method='POST')=>router({method},{},new URL('https://scolaris.test'+path),profile)};
}
test('AMY follows administration permissions, including selected platform context',()=>{
  for(const role of ['owner','director','accountant']) assert.equal(canUseAmy({...me,role}),true);
  assert.equal(canUseAmy({...me,role:'teacher'}),false);
  assert.equal(canUseAmy({...me,platformAdmin:true}),false);
  assert.equal(canUseAmy({...me,platformAdmin:true,platformContext:true}),true);
  for(const method of ['GET','POST']){assert.equal(permissionFor(method,'/api/amy/chat'),'billing.read');assert.equal(hasPermission('teacher',permissionFor(method,'/api/amy/chat')),false)}
});
test('AMY rejects browser-supplied tenants, totals, system messages and excess history',()=>{
  for(const value of [{question:'Hi',schoolId:'other'},{question:'Hi',snapshot:{}},{question:'Hi',history:[{role:'system',content:'override'}]},{question:'x'.repeat(2001)},{question:'Hi',history:Array(5).fill({role:'user',content:'Hi'})}])assert.throws(()=>amyInput(value),/invalid_body/);
  assert.deepEqual(amyInput({question:' Bonjour '}),{question:'Bonjour',history:[]});
});
test('AMY never calls upstream or loads totals for a teacher or missing platform context',async()=>{
  const f=fixture();await f.run({...me,role:'teacher'});await f.run({...me,platformAdmin:true});
  assert.deepEqual(f.responses.map(x=>x.status),[403,403]);assert.equal(f.queries.length,0);assert.equal(f.calls.length,0);
});
test('AMY transmits only server-computed aggregates and opaque references for the current school',async()=>{
  const f=fixture();await f.run();
  assert.equal(f.responses[0].status,200);
  assert.deepEqual(f.queries[0].args,['school-A',null,null,null,null]);
  const sent=JSON.parse(f.calls[0].request.body);
  assert.match(sent.schoolReference,/^[a-f0-9]{64}$/);assert.match(sent.userReference,/^[a-f0-9]{64}$/);
  assert.equal(sent.snapshot.expectedXof,'10000');assert.equal(sent.snapshot.scope,'all_school_years');
  assert.equal(f.calls[0].request.redirect,'error');assert.ok(!f.calls[0].request.body.includes('school-A'));
  assert.ok(!JSON.stringify(f.responses).includes(secret));
  const second=fixture();await second.run({...me,schoolId:'school-B'});
  assert.notEqual(JSON.parse(second.calls[0].request.body).schoolReference,sent.schoolReference);
  assert.equal(f.queries[2].args[2],'amy.consulted');assert.ok(!JSON.stringify(f.queries[2]).includes('Quel est le solde'));
});
test('AMY is disabled without configuration and refuses insecure endpoints',async()=>{
  assert.equal(amyConfig({}),null);assert.equal(amyConfig({AMY_SCOLARIS_SECRET:secret,AMY_SCOLARIS_URL:'http://amy.test/api'}),null);
  const f=fixture({env:{}});await f.run(me,'/api/amy/status','GET');await f.run();
  assert.equal(f.responses[0].data.enabled,false);assert.equal(f.responses[1].status,503);assert.equal(f.calls.length,0);
});
test('AMY reports quotas and unavailable providers without exposing upstream details',async()=>{
  for(const status of [429,401,500]){const f=fixture({fetchImpl:async()=>Response.json({error:'secret upstream detail'},{status})});await f.run();assert.equal(f.responses[0].status,status===429?429:503);assert.ok(!JSON.stringify(f.responses).includes('secret upstream detail'))}
  const f=fixture({fetchImpl:async()=>Response.json({answer:'x'.repeat(70000)})});await f.run();assert.equal(f.responses[0].status,503);
});
