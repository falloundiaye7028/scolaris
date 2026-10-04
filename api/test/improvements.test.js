import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { amyFilters, resolveAmyFilters } from '../src/amy-service.js';
import { documentInput, documentChunks } from '../src/amy-knowledge.js';
import { reminderChannels, reminderInput } from '../src/reminder-service.js';
import { waveConfig, verifyWaveSignature, validateWaveSession } from '../src/wave-service.js';
import { permissionFor,hasPermission } from '../src/security.js';

test('AMY filters reject invalid dates, unknown fields and foreign school references',async()=>{
  for(const filters of [{from:'2026-02-30'},{from:'2026-09-01',to:'2025-01-01'},{schoolId:crypto.randomUUID()},{classId:'invalid'},[]])assert.throws(()=>amyFilters(filters));
  const id=crypto.randomUUID();let checked;
  await assert.rejects(resolveAmyFilters({query:async(sql,args)=>{checked=args;return {rows:[]}}},'school-A',{classId:id}));
  assert.deepEqual(checked,[id,'school-A']);
});
test('document indexing bounds content and never treats documents as executable data',()=>{
  assert.throws(()=>documentInput({title:'x',content:'x'.repeat(50001)}));
  assert.throws(()=>documentInput({title:'x',content:'ok',schoolId:'other'}));
  assert.equal(documentInput({title:'Règlement',content:'<script>untrusted</script>'}).content,'<script>untrusted</script>');
  const chunks=documentChunks('x'.repeat(50000));assert.ok(chunks.length<35);assert.ok(chunks.every(c=>c.length<=1800));
});
test('reminders remain disabled until explicit configuration; recipient fields cannot be injected',()=>{
  assert.deepEqual(reminderChannels({RESEND_API_KEY:'configured',RESEND_FROM_EMAIL:'verified@example.test'}),{email:false,sms:false,whatsapp:false});
  assert.equal(reminderChannels({REMINDER_DELIVERY_ENABLED:'true',REMINDER_GATEWAY_URL:'http://invalid.test',REMINDER_GATEWAY_SECRET:crypto.randomBytes(32).toString('hex')}).sms,false);
  const b={guardianId:crypto.randomUUID(),invoiceId:crypto.randomUUID(),channel:'email',message:'Rappel',idempotencyKey:crypto.randomUUID()};
  assert.equal(reminderInput(b,x=>x).message,'Rappel');assert.throws(()=>reminderInput({...b,recipient:'other@example.test'},x=>x));
});
test('Wave configuration requires an explicit merchant for each school and authentic signatures',()=>{
  const secret=crypto.randomBytes(32).toString('hex'),id=crypto.randomUUID(),env={WAVE_CHECKOUT_ENABLED:'true',WAVE_SCHOOL_MERCHANTS:JSON.stringify({[id]:{apiKey:crypto.randomBytes(24).toString('hex'),webhookSecret:secret}})};
  assert.ok(waveConfig(id,env));assert.equal(waveConfig(crypto.randomUUID(),env),null);assert.equal(waveConfig(id,{}),null);
  const now=Date.now(),t=String(Math.floor(now/1000)),raw=Buffer.from('{"type":"checkout.session.completed"}');
  const signature='t='+t+',v1='+crypto.createHmac('sha256',secret).update(t).update(raw).digest('hex');
  assert.equal(verifyWaveSignature(raw,signature,secret,now),true);
  assert.equal(verifyWaveSignature(Buffer.from('{}'),signature,secret,now),false);
  assert.equal(verifyWaveSignature(raw,signature,secret,now+301000),false);
  assert.equal(verifyWaveSignature(raw,'t='+t+','+signature,secret,now),false);
});
test('Wave reconciliation checks school-owned reference, amount, currency and provider session',()=>{
  const row={id:crypto.randomUUID(),amount_xof:'15000',provider_session_id:'cos-example'},data={id:'cos-example',client_reference:row.id,amount:'15000',currency:'XOF'};
  assert.equal(validateWaveSession(data,row),true);
  for(const changed of [{currency:'EUR'},{amount:'15001'},{client_reference:crypto.randomUUID()},{id:'cos-other'}])assert.equal(validateWaveSession({...data,...changed},row),false);
  for(const method of ['GET','POST'])assert.equal(hasPermission('teacher',permissionFor(method,'/api/online-payments')),false);
});
