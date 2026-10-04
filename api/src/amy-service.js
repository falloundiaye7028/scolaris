import crypto from 'node:crypto';

export function canUseAmy(me) {
  return Boolean(me?.schoolId && (me.platformAdmin ? me.platformContext : ['owner','director','accountant'].includes(me.role)));
}

export function amyConfig(env = process.env) {
  const secret = env.AMY_SCOLARIS_SECRET || '';
  try {
    const endpoint = new URL(env.AMY_SCOLARIS_URL || 'https://amyia.tech/api/integrations/scolaris/assist');
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || secret.length < 32) return null;
    return { endpoint: endpoint.toString(), secret };
  } catch { return null; }
}

export function amyInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['question','history'].includes(k))) throw Error('invalid_body');
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  const history = value.history ?? [];
  if (!question || question.length > 2000 || question.includes('\0') || !Array.isArray(history) || history.length > 4) throw Error('invalid_body');
  for (const item of history) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k=>!['role','content'].includes(k)) || !['user','assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content || item.content.length > 2000 || item.content.includes('\0')) throw Error('invalid_body');
  }
  return { question, history };
}

export async function amySnapshot(pool, schoolId) {
  const { rows } = await pool.query(`WITH x AS (
    SELECT i.amount_due_xof,i.financial_status,i.due_date,
      COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0)::bigint paid
    FROM invoices i WHERE i.school_id=$1 AND i.financial_status<>'cancelled'
  ) SELECT now() AS computed_at,
    (SELECT count(*)::int FROM students WHERE school_id=$1 AND status='active') AS active_students,
    count(*)::int AS invoice_count,
    count(*) FILTER(WHERE financial_status<>'exempted' AND paid<amount_due_xof)::int AS outstanding_invoices,
    count(*) FILTER(WHERE financial_status<>'exempted' AND paid<amount_due_xof AND due_date<CURRENT_DATE)::int AS overdue_invoices,
    COALESCE(sum(amount_due_xof),0)::text AS expected_xof, COALESCE(sum(paid),0)::text AS paid_xof,
    COALESCE(sum(GREATEST(amount_due_xof-paid,0)),0)::text AS balance_xof,
    COALESCE(sum(GREATEST(amount_due_xof-paid,0)) FILTER(WHERE financial_status<>'exempted' AND due_date<CURRENT_DATE),0)::text AS overdue_xof
    FROM x`, [schoolId]);
  const r = rows[0];
  return { computedAt: new Date(r.computed_at).toISOString(), scope:'all_school_years', currency:'XOF',
    activeStudents:r.active_students, invoiceCount:r.invoice_count, outstandingInvoices:r.outstanding_invoices,
    overdueInvoices:r.overdue_invoices, expectedXof:r.expected_xof, paidXof:r.paid_xof, balanceXof:r.balance_xof, overdueXof:r.overdue_xof };
}

async function readReply(response) {
  if (!response.body) throw Error('amy_unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw Error('amy_unavailable'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function createAmyRouter({ pool, json, body, env = process.env, fetchImpl = fetch }) {
  return async (req, res, url, me) => {
    if (!['/api/amy/status','/api/amy/chat'].includes(url.pathname)) return false;
    if (!canUseAmy(me)) { json(res,403,{error:'AMY est réservée à la direction et à la comptabilité de l’établissement sélectionné.'}); return true; }
    const config = amyConfig(env);
    if (req.method === 'GET' && url.pathname === '/api/amy/status') {
      json(res,200,{enabled:Boolean(config),mode:'consultation',schoolDailyLimit:50,userHourlyLimit:20}); return true;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/amy/chat') { json(res,405,{error:'Méthode non autorisée'}); return true; }
    if (!config) { json(res,503,{error:'La connexion à AMY est en cours de configuration.'}); return true; }
    const input = amyInput(await body(req,{maxBytes:65_536}));
    const snapshot = await amySnapshot(pool,me.schoolId);
    const reference = value=>crypto.createHmac('sha256',config.secret).update(value).digest('hex');
    try {
      const response = await fetchImpl(config.endpoint, { method:'POST', redirect:'error', signal:AbortSignal.timeout(35_000),
        headers:{'content-type':'application/json',authorization:'Bearer '+config.secret},
        body:JSON.stringify({...input,snapshot,role:me.platformAdmin?'platform_admin':me.role,
          schoolReference:reference('school:'+me.schoolId),userReference:reference('user:'+me.schoolId+':'+me.sub)}) });
      if (response.status === 429) {
        await response.body?.cancel();
        json(res,429,{error:'La limite de requêtes AMY est atteinte. Réessayez plus tard.'}); return true;
      }
      if (!response.ok) { await response.body?.cancel(); throw Error('amy_unavailable'); }
      const result = await readReply(response);
      if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 12_000) throw Error('amy_unavailable');
      await pool.query('INSERT INTO audit_logs(school_id,user_id,action,entity,metadata) VALUES($1,$2,$3,$4,$5)',
        [me.schoolId,me.sub,'amy.consulted','assistant',JSON.stringify({mode:'consultation',scope:snapshot.scope})]);
      json(res,200,{answer:result.answer,snapshot});
    } catch {
      json(res,503,{error:'AMY est temporairement indisponible. Vos données restent accessibles dans les autres menus.'});
    }
    return true;
  };
}
