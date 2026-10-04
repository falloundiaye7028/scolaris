import crypto from 'node:crypto';

export function reminderChannels(env=process.env) {
  const enabled=env.REMINDER_DELIVERY_ENABLED==='true';
  let gateway=false;
  try{const u=new URL(env.REMINDER_GATEWAY_URL);gateway=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&(env.REMINDER_GATEWAY_SECRET||'').length>=32;}catch{}
  return {email:enabled&&Boolean(env.RESEND_API_KEY&&env.RESEND_FROM_EMAIL),sms:enabled&&gateway,whatsapp:enabled&&gateway};
}

export function reminderInput(b,identifier) {
  if(Object.keys(b).some(k=>!['guardianId','invoiceId','channel','message','scheduledAt','idempotencyKey'].includes(k)))throw Error('invalid_body');
  const guardianId=identifier(b.guardianId),invoiceId=identifier(b.invoiceId),idempotencyKey=b.idempotencyKey?identifier(b.idempotencyKey):crypto.randomUUID();
  if(!['email','sms','whatsapp'].includes(b.channel)||typeof b.message!=='string'||!b.message.trim()||b.message.length>1000||b.message.includes('\0'))throw Error('invalid_body');
  const scheduledAt=b.scheduledAt?new Date(b.scheduledAt):new Date();
  if(!Number.isFinite(+scheduledAt)||+scheduledAt>Date.now()+90*86400000)throw Error('invalid_body');
  return {guardianId,invoiceId,idempotencyKey,channel:b.channel,message:b.message.trim(),scheduledAt:scheduledAt.toISOString()};
}

export function createReminderService({pool,json,body,identifier,env=process.env,fetchImpl=(...args)=>fetch(...args)}) {
  const channels=()=>reminderChannels(env);
  const authorized=me=>me?.schoolId&&(me.platformAdmin?me.platformContext:['owner','director','accountant'].includes(me.role));
  async function dispatchBatch(schoolId=null,id=null) {
    const configured=channels();
    if(!Object.values(configured).some(Boolean))return {processed:0,configured:false};
    const enabled=Object.keys(configured).filter(k=>configured[k]);
    // Claims expire, but the provider always sees the same idempotency key.
    const claimed=await pool.query(`UPDATE reminders SET dispatch_started_at=now(),first_attempt_at=COALESCE(first_attempt_at,now()),attempts=attempts+1
      WHERE id IN (SELECT r.id FROM reminders r JOIN schools s ON s.id=r.school_id
      JOIN school_subscriptions ss ON ss.school_id=s.id
      WHERE r.status='queued' AND r.approved_at IS NOT NULL AND r.scheduled_at<=now()
      AND (ss.is_exempt OR (s.subscription_status='active' AND ss.paid_until>now()))
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now()) AND r.attempts<3
      AND (r.dispatch_started_at IS NULL OR r.dispatch_started_at<now()-interval '5 minutes')
      AND ($1::uuid IS NULL OR r.school_id=$1) AND ($2::uuid IS NULL OR r.id=$2) AND r.channel=ANY($3::text[])
      ORDER BY r.scheduled_at LIMIT 3 FOR UPDATE OF r SKIP LOCKED) RETURNING *`,[schoolId,id,enabled]);
    for(const r of claimed.rows){
      const info=(await pool.query(`SELECT g.email,g.phone,i.financial_status,i.amount_due_xof,s.name,
        COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=r.school_id),0)::text paid
        FROM reminders r JOIN guardians g ON g.id=r.guardian_id AND g.school_id=r.school_id
        JOIN invoices i ON i.id=r.invoice_id AND i.school_id=r.school_id JOIN schools s ON s.id=r.school_id
        JOIN student_guardians sg ON sg.school_id=r.school_id AND sg.student_id=i.student_id AND sg.guardian_id=g.id WHERE r.id=$1`,[r.id])).rows[0];
      if(!info||['paid','cancelled','exempted'].includes(info.financial_status)||BigInt(info.paid)>=BigInt(info.amount_due_xof)){
        await pool.query("UPDATE reminders SET status='cancelled',last_error='invoice_settled_or_recipient_changed' WHERE id=$1",[r.id]);continue;
      }
      if(r.attempts>1&&Date.now()-new Date(r.first_attempt_at).getTime()>23*3600000){
        await pool.query("UPDATE reminders SET status='failed',last_error='delivery_uncertain_manual_review' WHERE id=$1",[r.id]);continue;
      }
      const recipient=r.channel==='email'?info.email:info.phone;
      if(!recipient){await pool.query("UPDATE reminders SET status='failed',last_error='missing_recipient' WHERE id=$1",[r.id]);continue;}
      if(recipient!==r.approved_recipient){await pool.query("UPDATE reminders SET status='cancelled',last_error='recipient_changed_after_approval' WHERE id=$1",[r.id]);continue;}
      try{
        const email=r.channel==='email';
        const response=await fetchImpl(email?'https://api.resend.com/emails':env.REMINDER_GATEWAY_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
          headers:{'content-type':'application/json',authorization:'Bearer '+(email?env.RESEND_API_KEY:env.REMINDER_GATEWAY_SECRET),'Idempotency-Key':'scolaris-reminder-'+r.id},
          body:JSON.stringify(email?{from:env.RESEND_FROM_EMAIL,to:[recipient],subject:'Rappel de scolarité · '+info.name,text:r.message}:{id:r.id,channel:r.channel,recipient,message:r.message})});
        if(!response.ok){await response.body?.cancel();throw Error('provider_unavailable');}
        const data=await response.json();
        if(typeof data.id!=='string'||!data.id||data.id.length>200)throw Error('provider_unavailable');
        await pool.query("UPDATE reminders SET status='sent',sent_at=now(),delivery_status='accepted',provider=$2,provider_id=$3,last_error=NULL WHERE id=$1",[r.id,email?'resend':'gateway',data.id]);
      }catch{
        await pool.query("UPDATE reminders SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,last_error='provider_unavailable',next_attempt_at=now()+interval '15 minutes',dispatch_started_at=NULL WHERE id=$1",[r.id]);
      }
    }
    return {processed:claimed.rowCount,configured:true};
  }
  async function dispatch(schoolId=null,id=null) {
    const deadline=Date.now()+15000;
    let processed=0,result;
    do {
      result=await dispatchBatch(schoolId,id);
      processed+=result.processed;
    } while(!id&&result.processed===3&&processed<90&&Date.now()<deadline);
    return {processed,configured:result.configured};
  }
  async function reconcileEmail() {
    if(!channels().email)return;
    const {rows}=await pool.query("SELECT id,provider_id FROM reminders WHERE provider='resend' AND status='sent' AND delivery_status='accepted' AND sent_at>now()-interval '7 days' ORDER BY delivery_checked_at NULLS FIRST,sent_at LIMIT 3");
    for(const r of rows){try{
      await pool.query('UPDATE reminders SET delivery_checked_at=now() WHERE id=$1',[r.id]);
      const response=await fetchImpl('https://api.resend.com/emails/'+encodeURIComponent(r.provider_id),{headers:{authorization:'Bearer '+env.RESEND_API_KEY},redirect:'error',signal:AbortSignal.timeout(3000)});
      if(!response.ok){await response.body?.cancel();continue;}const data=await response.json();
      const status={delivered:'delivered',bounced:'failed',failed:'failed',complained:'failed'}[data.last_event];
      if(status)await pool.query("UPDATE reminders SET delivery_status=$2,delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END WHERE id=$1",[r.id,status]);
    }catch{}}
  }
  async function router(req,res,url,me) {
    if(!url.pathname.startsWith('/api/reminders'))return false;
    if(!authorized(me)){json(res,403,{error:'Accès aux relances non autorisé.'});return true;}
    if(req.method==='GET'&&url.pathname==='/api/reminders/config'){json(res,200,{channels:channels()});return true;}
    if(req.method==='GET'&&url.pathname==='/api/reminders'){
      const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw Error('invalid_body');
      const {rows}=await pool.query(`SELECT r.*,g.full_name guardian_name,g.email guardian_email,g.phone guardian_phone,i.label invoice_label FROM reminders r JOIN guardians g ON g.id=r.guardian_id AND g.school_id=r.school_id JOIN invoices i ON i.id=r.invoice_id AND i.school_id=r.school_id WHERE r.school_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 30 OFFSET $2`,[me.schoolId,offset]);
      json(res,200,rows);return true;
    }
    if(req.method==='POST'&&url.pathname==='/api/reminders'){
      const b=reminderInput(await body(req),identifier);
      const {rows}=await pool.query(`INSERT INTO reminders(school_id,guardian_id,invoice_id,channel,message,scheduled_at,idempotency_key)
        SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM invoices i JOIN student_guardians sg ON sg.school_id=i.school_id AND sg.student_id=i.student_id
        JOIN guardians g ON g.id=sg.guardian_id AND g.school_id=i.school_id WHERE i.school_id=$1 AND i.id=$3 AND g.id=$2 AND i.financial_status NOT IN ('paid','cancelled','exempted'))
        ON CONFLICT(school_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,[me.schoolId,b.guardianId,b.invoiceId,b.channel,b.message,b.scheduledAt,b.idempotencyKey]);
      if(rows[0])json(res,201,rows[0]);
      else{const existing=(await pool.query('SELECT * FROM reminders WHERE school_id=$1 AND idempotency_key=$2',[me.schoolId,b.idempotencyKey])).rows[0];json(res,existing?200:404,existing||{error:'Parent lié ou échéance impayée introuvable.'});}
      return true;
    }
    const match=/^\/api\/reminders\/([^/]+)\/(approve|cancel|send)$/.exec(url.pathname);
    if(req.method==='POST'&&match){
      const id=identifier(match[1]),action=match[2],input=await body(req,{maxBytes:2048});
      const row=(await pool.query('SELECT * FROM reminders WHERE id=$1 AND school_id=$2',[id,me.schoolId])).rows[0];
      if(!row){json(res,404,{error:'Relance introuvable.'});return true;}
      if(action!=='cancel'&&!channels()[row.channel]){json(res,503,{error:'Ce canal de livraison doit être configuré avant envoi.'});return true;}
      if(action==='approve'){
        if(typeof input.recipient!=='string'||!input.recipient||input.recipient.length>320)throw Error('invalid_body');
        const approved=await pool.query(`UPDATE reminders r SET approved_at=now(),approved_by=$3,approved_recipient=$4
          FROM guardians g WHERE r.id=$1 AND r.school_id=$2 AND r.status='queued' AND r.approved_at IS NULL
          AND g.id=r.guardian_id AND g.school_id=r.school_id AND $4=CASE WHEN r.channel='email' THEN g.email ELSE g.phone END RETURNING r.id`,[id,me.schoolId,me.sub,input.recipient]);
        if(!approved.rowCount){json(res,409,{error:'La relance ou ses coordonnées ont changé. Actualisez avant de valider.'});return true;}
      }else if(action==='cancel'){
        const changed=await pool.query("UPDATE reminders SET status='cancelled' WHERE id=$1 AND school_id=$2 AND status='queued' AND dispatch_started_at IS NULL RETURNING id",[id,me.schoolId]);
        if(!changed.rowCount){json(res,409,{error:'Cette relance est déjà prise en charge ou terminée.'});return true;}
      }else {
        if(!row.approved_at||row.status!=='queued'||new Date(row.scheduled_at)>new Date()){json(res,409,{error:'Validez une relance arrivée à échéance avant de l’envoyer.'});return true;}
        await dispatch(me.schoolId,id);
      }
      json(res,200,{ok:true});return true;
    }
    json(res,405,{error:'Méthode non autorisée.'});return true;
  }
  async function deliveryWebhook(req,res,url) {
    if(url.pathname!=='/api/integrations/reminders/delivery')return false;
    const secret=env.REMINDER_GATEWAY_SECRET||'',auth=String(req.headers.authorization||'');
    const digest=value=>crypto.createHash('sha256').update(value).digest();
    if(req.method!=='POST'||secret.length<32||!crypto.timingSafeEqual(digest(auth),digest('Bearer '+secret))){json(res,401,{error:'Accès refusé.'});return true;}
    const b=await body(req,{maxBytes:2048}),id=identifier(b.id);
    if(!['delivered','failed'].includes(b.status)||typeof b.providerId!=='string'||b.providerId.length>200)throw Error('invalid_body');
    await pool.query("UPDATE reminders SET delivery_status=$3,delivered_at=CASE WHEN $3='delivered' THEN now() ELSE NULL END WHERE id=$1 AND provider='gateway' AND provider_id=$2 AND status='sent' AND delivery_status='accepted'",[id,b.providerId,b.status]);
    json(res,200,{received:true});return true;
  }
  return {router,dispatch,reconcileEmail,deliveryWebhook};
}
