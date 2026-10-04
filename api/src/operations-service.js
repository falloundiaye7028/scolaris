import { pagination, safeText } from './security.js';

export function createOperationsRouter({pool,json}) {
  return async(req,res,url,me)=>{
    if(req.method==='GET'&&url.pathname==='/api/invoices/open'){
      const {limit,offset}=pagination(url.searchParams,{defaultLimit:30,maxLimit:100});
      const q=safeText(url.searchParams.get('q')||'',{max:120}),needle='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
      const base=`FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=i.school_id
        CROSS JOIN LATERAL (SELECT COALESCE(sum(p.amount_minor)/100,0) paid FROM student_fee_payments p WHERE p.school_id=$1 AND p.invoice_id=i.id) p
        WHERE i.school_id=$1 AND i.financial_status NOT IN ('cancelled','exempted') AND i.amount_due_xof>p.paid
        AND ($2='' OR concat_ws(' ',s.matricule,s.first_name,s.last_name,i.label) ILIKE $3)`;
      const [result,count]=await Promise.all([
        pool.query(`SELECT i.id,i.student_id,i.label,i.due_date,s.first_name,s.last_name,s.matricule,(i.amount_due_xof-p.paid)::bigint::text balance_xof ${base} ORDER BY i.due_date,i.id LIMIT $4 OFFSET $5`,[me.schoolId,q,needle,limit,offset]),
        pool.query(`SELECT count(*)::int total ${base}`,[me.schoolId,q,needle])
      ]);
      json(res,200,{invoices:result.rows,total:count.rows[0].total,limit,offset});return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/students/search'){
      const {limit,offset}=pagination(url.searchParams,{defaultLimit:30,maxLimit:100});
      const q=safeText(url.searchParams.get('q')||'',{max:120}),sort=url.searchParams.get('sort')||'name';
      const order={name:'last_name,first_name',matricule:'matricule',phone:'guardian_phone NULLS LAST',class:'class_name NULLS LAST'}[sort];
      if(!order)throw Error('invalid_body');
      const needle='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
      const where="school_id=$1 AND ($2='' OR concat_ws(' ',matricule,first_name,last_name,class_name,guardian_name,guardian_phone) ILIKE $3)";
      const [result,count]=await Promise.all([
        pool.query(`SELECT id,matricule,first_name,last_name,class_name,guardian_name,guardian_phone,status,created_at FROM students WHERE ${where} ORDER BY ${order},id LIMIT $4 OFFSET $5`,[me.schoolId,q,needle,limit,offset]),
        pool.query(`SELECT count(*)::int total FROM students WHERE ${where}`,[me.schoolId,q,needle])
      ]);
      json(res,200,{students:result.rows,total:count.rows[0].total,limit,offset});return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/platform/overview'){
      if(!me.platformAdmin){json(res,403,{error:'Accès super-administrateur requis.'});return true;}
      const [months,renewals,totals]=await Promise.all([
        pool.query(`WITH months AS (SELECT generate_series(date_trunc('month',now())-interval '11 months',date_trunc('month',now()),interval '1 month') month)
          SELECT to_char(m.month,'YYYY-MM') month,count(p.id)::int payments,COALESCE(sum(p.amount_received_xof),0)::text amount_xof
          FROM months m LEFT JOIN platform_subscription_payments p ON p.status='confirmed' AND p.paid_at>=m.month AND p.paid_at<m.month+interval '1 month' GROUP BY m.month ORDER BY m.month`),
        pool.query(`SELECT s.id,s.name,ss.paid_until,s.subscription_status FROM schools s JOIN school_subscriptions ss ON ss.school_id=s.id
          WHERE NOT ss.is_exempt AND s.deletion_requested_at IS NULL AND s.subscription_status IN ('active','grace_period','suspended') AND ss.paid_until<=now()+interval '14 days'
          ORDER BY ss.paid_until,s.id LIMIT 100`),
        pool.query(`SELECT count(*)::int schools,count(*) FILTER(WHERE s.subscription_status='active')::int active,
          count(*) FILTER(WHERE s.subscription_status IN ('pending_email','pending_review','pending_payment'))::int pending
          FROM schools s WHERE s.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM users u WHERE u.school_id=s.id AND u.is_platform_admin)`)
      ]);
      json(res,200,{months:months.rows,renewals:renewals.rows,totals:totals.rows[0],computedAt:new Date().toISOString()});return true;
    }
    return false;
  };
}
