import crypto from 'node:crypto';

export function waveConfig(schoolId,env=process.env) {
  if(env.WAVE_CHECKOUT_ENABLED!=='true')return null;
  try{
    const all=JSON.parse(env.WAVE_SCHOOL_MERCHANTS||'{}');
    const c=Object.hasOwn(all,schoolId)?all[schoolId]:null;
    if(!c||typeof c.apiKey!=='string'||c.apiKey.length<20||typeof c.webhookSecret!=='string'||c.webhookSecret.length<32)return null;
    return {apiKey:c.apiKey,webhookSecret:c.webhookSecret,signingSecret:typeof c.signingSecret==='string'?c.signingSecret:null};
  }catch{return null;}
}

export function verifyWaveSignature(raw,header,secret,now=Date.now()) {
  if(typeof header!=='string'||header.length>1024)return false;
  const parts=header.split(',').map(x=>x.trim()),timestamps=parts.filter(x=>x.startsWith('t='));
  if(timestamps.length!==1||!/^t=\d{10}$/.test(timestamps[0]))return false;
  const t=timestamps[0].slice(2),age=now/1000-Number(t);
  if(age>300||age< -30)return false;
  const expected=crypto.createHmac('sha256',secret).update(t).update(raw).digest();
  return parts.filter(x=>/^v1=[a-f0-9]{64}$/.test(x)).some(x=>crypto.timingSafeEqual(expected,Buffer.from(x.slice(3),'hex')));
}

export function validateWaveSession(data,row) {
  return Boolean(data&&data.client_reference===row.id&&String(data.amount)===String(row.amount_xof)&&data.currency==='XOF'
    &&typeof data.id==='string'&&/^cos-[A-Za-z0-9_-]{1,80}$/.test(data.id)&&(!row.provider_session_id||row.provider_session_id===data.id));
}

export function createWaveService({pool,json,body,identifier,env=process.env,fetchImpl=(...args)=>fetch(...args)}) {
  const authorized=me=>me?.schoolId&&(me.platformAdmin?me.platformContext:['owner','director','accountant'].includes(me.role));
  async function call(config,path,payload) {
    const raw=payload?JSON.stringify(payload):'',headers={authorization:'Bearer '+config.apiKey,'content-type':'application/json'};
    if(config.signingSecret){const t=String(Math.floor(Date.now()/1000));headers['Wave-Signature']='t='+t+',v1='+crypto.createHmac('sha256',config.signingSecret).update(t+raw).digest('hex');}
    const response=await fetchImpl('https://api.wave.com/v1/checkout/sessions'+path,{method:payload?'POST':'GET',headers,...(payload?{body:raw}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok){await response.body?.cancel();throw Error('wave_unavailable');}
    const data=await response.json();return data;
  }
  async function confirm(row,data) {
    if(!validateWaveSession(data,row))throw Error('wave_mismatch');
    if(data.checkout_status==='expired'){
      await pool.query("UPDATE online_checkouts SET status='expired',updated_at=now() WHERE id=$1 AND status IN ('creating','pending')",[row.id]);return;
    }
    const launch=new URL(data.wave_launch_url||'https://invalid.test');
    if(launch.protocol!=='https:'||launch.hostname!=='pay.wave.com'||launch.username||launch.password)throw Error('wave_mismatch');
    await pool.query("UPDATE online_checkouts SET provider_session_id=$2,launch_url=$3,status=CASE WHEN status='creating' THEN 'pending' ELSE status END,updated_at=now() WHERE id=$1 AND status IN ('creating','pending')",[row.id,data.id,launch.toString()]);
    if(data.payment_status!=='succeeded'||data.checkout_status!=='complete')return;
    if(typeof data.transaction_id!=='string'||!data.transaction_id||data.transaction_id.length>200||!Number.isFinite(Date.parse(data.when_completed)))throw Error('wave_mismatch');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const current=(await client.query('SELECT * FROM online_checkouts WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(['confirmed','review'].includes(current.status)){await client.query('COMMIT');return;}
      const invoice=(await client.query('SELECT * FROM invoices WHERE school_id=$1 AND id=$2 FOR UPDATE',[row.school_id,row.invoice_id])).rows[0];
      const paid=BigInt((await client.query('SELECT COALESCE(sum(amount_minor)/100,0)::text paid FROM student_fee_payments WHERE school_id=$1 AND invoice_id=$2',[row.school_id,row.invoice_id])).rows[0].paid);
      if(!invoice||['cancelled','exempted'].includes(invoice.financial_status)||BigInt(invoice.amount_due_xof)-paid<BigInt(row.amount_xof)){
        await client.query("UPDATE online_checkouts SET status='review',provider_transaction_id=$2,failure_code='balance_changed',updated_at=now() WHERE id=$1",[row.id,data.transaction_id]);
        await client.query('COMMIT');return;
      }
      const after=paid+BigInt(row.amount_xof),balance=BigInt(invoice.amount_due_xof)-after,status=balance===0n?'paid':'partially_paid';
      const batch=(await client.query("INSERT INTO student_payment_batches(school_id,student_id,total_amount_xof,currency,method,reference,paid_at,recorded_by) VALUES($1,$2,$3,'XOF','Wave',$4,$5,$6) RETURNING id",[row.school_id,invoice.student_id,row.amount_xof,'WAVE-'+data.transaction_id,data.when_completed,row.created_by])).rows[0];
      await client.query('INSERT INTO student_payment_allocations(school_id,payment_batch_id,invoice_id,amount_xof,amount_expected_xof_snapshot,total_paid_after_xof,balance_after_xof) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.school_id,batch.id,invoice.id,row.amount_xof,invoice.amount_due_xof,after.toString(),balance.toString()]);
      const receipt='REC-WAVE-'+row.id;
      await client.query('INSERT INTO receipts(school_id,payment_batch_id,number) VALUES($1,$2,$3)',[row.school_id,batch.id,receipt]);
      await client.query("UPDATE invoices SET amount_paid_xof=$3,balance_xof=$4,financial_status=$5,status=$6,updated_at=now() WHERE school_id=$1 AND id=$2",[row.school_id,invoice.id,after.toString(),balance.toString(),status,status==='paid'?'paid':'partial']);
      await client.query("UPDATE online_checkouts SET status='confirmed',provider_transaction_id=$2,receipt_number=$3,updated_at=now() WHERE id=$1",[row.id,data.transaction_id,receipt]);
      await client.query("INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata) VALUES($1,$2,'wave.confirmed','online_checkout',$3,$4)",[row.school_id,row.created_by,row.id,JSON.stringify({receipt,amountXof:String(row.amount_xof)})]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async function refresh(row,config,sessionId=null) {
    // A delayed authentic success must still be reconciled after a local timeout.
    if(['confirmed','review'].includes(row.status))return;
    if(row.provider_session_id||sessionId){await confirm(row,await call(config,'/'+encodeURIComponent(row.provider_session_id||sessionId)));return;}
    const result=await call(config,'/search?client_reference='+encodeURIComponent(row.id));
    if(result.result?.length===1)await confirm(row,result.result[0]);
    else if(result.result?.length>1)await pool.query("UPDATE online_checkouts SET status='review',failure_code='multiple_sessions',updated_at=now() WHERE id=$1",[row.id]);
    else if(Date.now()-new Date(row.created_at).getTime()>3600000)await pool.query("UPDATE online_checkouts SET status='failed',failure_code='session_not_found',updated_at=now() WHERE id=$1",[row.id]);
  }
  async function webhook(req,res,url) {
    const match=/^\/api\/integrations\/wave\/([^/]+)$/.exec(url.pathname);
    if(!match)return false;
    const schoolId=identifier(match[1]),config=waveConfig(schoolId,env);
    if(req.method!=='POST'||!config){json(res,404,{error:'Intégration indisponible.'});return true;}
    const chunks=[];let size=0;
    for await(const chunk of req){const part=Buffer.from(chunk);size+=part.length;if(size>65536)throw Error('body_too_large');chunks.push(part);}
    const raw=Buffer.concat(chunks);
    if(!verifyWaveSignature(raw,req.headers['wave-signature'],config.webhookSecret)){json(res,401,{error:'Signature invalide.'});return true;}
    let event;try{event=JSON.parse(raw.toString('utf8'));}catch{throw Error('invalid_body');}
    if(event.type==='checkout.session.completed'){
      const id=identifier(event.data?.client_reference),row=(await pool.query('SELECT * FROM online_checkouts WHERE school_id=$1 AND id=$2',[schoolId,id])).rows[0];
      if(!row){json(res,404,{error:'Session inconnue.'});return true;}
      if(!/^cos-[A-Za-z0-9_-]{1,80}$/.test(event.data?.id||''))throw Error('invalid_body');
      try{await refresh(row,config,event.data.id);}catch{json(res,503,{error:'Vérification Wave temporairement indisponible.'});return true;}
    }
    json(res,200,{received:true});return true;
  }
  async function router(req,res,url,me) {
    if(!url.pathname.startsWith('/api/online-payments'))return false;
    if(!authorized(me)){json(res,403,{error:'Accès au paiement en ligne non autorisé.'});return true;}
    const config=waveConfig(me.schoolId,env);
    if(req.method==='GET'&&url.pathname==='/api/online-payments'){
      const {rows}=await pool.query('SELECT o.id,o.invoice_id,o.amount_xof::text,o.status,o.launch_url,o.receipt_number,o.failure_code,o.created_at,i.label FROM online_checkouts o JOIN invoices i ON i.id=o.invoice_id AND i.school_id=o.school_id WHERE o.school_id=$1 ORDER BY o.created_at DESC LIMIT 50',[me.schoolId]);
      json(res,200,{enabled:Boolean(config),payments:rows});return true;
    }
    if(!config){json(res,503,{error:'Le compte marchand Wave de cet établissement doit être connecté avant activation.'});return true;}
    if(req.method==='POST'&&url.pathname==='/api/online-payments'){
      const b=await body(req,{maxBytes:2048});if(Object.keys(b).some(k=>k!=='invoiceId'))throw Error('invalid_body');const invoiceId=identifier(b.invoiceId),client=await pool.connect();let row;
      try{
        await client.query('BEGIN');
        const invoice=(await client.query('SELECT * FROM invoices WHERE school_id=$1 AND id=$2 FOR UPDATE',[me.schoolId,invoiceId])).rows[0];
        if(!invoice||['paid','cancelled','exempted'].includes(invoice.financial_status)){await client.query('ROLLBACK');json(res,409,{error:'Cette échéance ne peut pas être réglée en ligne.'});return true;}
        row=(await client.query("SELECT * FROM online_checkouts WHERE school_id=$1 AND invoice_id=$2 AND status IN ('creating','pending')",[me.schoolId,invoiceId])).rows[0];
        if(row){await client.query('COMMIT');json(res,200,{id:row.id,status:row.status,launch_url:row.launch_url});return true;}
        const paid=BigInt((await client.query('SELECT COALESCE(sum(amount_minor)/100,0)::text paid FROM student_fee_payments WHERE school_id=$1 AND invoice_id=$2',[me.schoolId,invoiceId])).rows[0].paid);
        const balance=BigInt(invoice.amount_due_xof)-paid;
        if(balance<=0n){await client.query('ROLLBACK');json(res,409,{error:'Cette échéance est déjà réglée.'});return true;}
        row=(await client.query('INSERT INTO online_checkouts(school_id,invoice_id,created_by,amount_xof) VALUES($1,$2,$3,$4) RETURNING *',[me.schoolId,invoiceId,me.sub,balance.toString()])).rows[0];
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      try{
        const data=await call(config,'',{amount:String(row.amount_xof),currency:'XOF',client_reference:row.id,success_url:'https://www.scolarispay.online/paiement-retour.html',error_url:'https://www.scolarispay.online/paiement-retour.html'});
        await confirm(row,data);const saved=(await pool.query('SELECT id,status,launch_url FROM online_checkouts WHERE id=$1',[row.id])).rows[0];json(res,201,saved);
      }catch{json(res,503,{error:'Création Wave à vérifier. Utilisez « Vérifier » avant toute nouvelle tentative.',checkoutId:row.id});}
      return true;
    }
    const match=/^\/api\/online-payments\/([^/]+)\/refresh$/.exec(url.pathname);
    if(req.method==='POST'&&match){
      await body(req,{maxBytes:2048});const row=(await pool.query('SELECT * FROM online_checkouts WHERE school_id=$1 AND id=$2',[me.schoolId,identifier(match[1])])).rows[0];
      if(!row){json(res,404,{error:'Paiement introuvable.'});return true;}
      try{await refresh(row,config);json(res,200,{ok:true});}catch{json(res,503,{error:'La vérification Wave est temporairement indisponible.'});}return true;
    }
    json(res,405,{error:'Méthode non autorisée.'});return true;
  }
  return {router,webhook,refresh,confirm};
}
