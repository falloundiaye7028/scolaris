import http from 'node:http';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const port = Number(process.env.PORT || 3000);
const secret = process.env.JWT_SECRET || 'development-only-change-me';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://scolaris:scolaris_dev@localhost:5432/scolaris' });
const json = (res,status,data) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-headers':'content-type, authorization'}); res.end(JSON.stringify(data)); };
const body = async req => { let raw=''; for await (const c of req) raw+=c; return raw ? JSON.parse(raw) : {}; };
const auth = req => { const token=req.headers.authorization?.replace(/^Bearer /,''); if(!token) throw Error('unauthorized'); return jwt.verify(token,secret); };
const route = (method,path) => `${method} ${path}`;

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS') return json(res,204,{});
  try {
    const url=new URL(req.url,'http://localhost');
    if(route(req.method,url.pathname)==='GET /api/health') { await pool.query('SELECT 1'); return json(res,200,{status:'ok',service:'scolaris-api'}); }
    if(route(req.method,url.pathname)==='POST /api/auth/bootstrap') {
      const b=await body(req); if(!b.schoolName||!b.name||!b.email||!b.password) return json(res,400,{error:'Champs requis manquants'});
      const client=await pool.connect(); try { await client.query('BEGIN');
        const school=(await client.query('INSERT INTO schools(name,slug,currency) VALUES($1,$2,$3) RETURNING *',[b.schoolName,b.slug||b.schoolName.toLowerCase().replace(/[^a-z0-9]+/g,'-'),b.currency||'XOF'])).rows[0];
        const hash=await bcrypt.hash(b.password,12); const user=(await client.query('INSERT INTO users(school_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role',[school.id,b.name,b.email.toLowerCase(),hash,'owner'])).rows[0];
        await client.query('COMMIT'); return json(res,201,{school,user,token:jwt.sign({sub:user.id,schoolId:school.id,role:user.role},secret,{expiresIn:'8h'})});
      } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
    }
    if(route(req.method,url.pathname)==='POST /api/auth/login') { const b=await body(req); const q=await pool.query('SELECT * FROM users WHERE email=$1',[String(b.email||'').toLowerCase()]); const u=q.rows[0]; if(!u||!await bcrypt.compare(b.password||'',u.password_hash)) return json(res,401,{error:'Identifiants invalides'}); return json(res,200,{token:jwt.sign({sub:u.id,schoolId:u.school_id,role:u.role},secret,{expiresIn:'8h'}),user:{id:u.id,name:u.name,email:u.email,role:u.role}}); }
    const me=auth(req);
    if(route(req.method,url.pathname)==='GET /api/me') { const q=await pool.query('SELECT id,name,email,role FROM users WHERE id=$1 AND school_id=$2',[me.sub,me.schoolId]); return json(res,200,q.rows[0]); }
    if(route(req.method,url.pathname)==='GET /api/students') { const q=await pool.query('SELECT * FROM students WHERE school_id=$1 ORDER BY last_name,first_name',[me.schoolId]); return json(res,200,q.rows); }
    if(route(req.method,url.pathname)==='POST /api/students') { const b=await body(req); const q=await pool.query('INSERT INTO students(school_id,matricule,first_name,last_name,class_name,guardian_name,guardian_phone) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[me.schoolId,b.matricule,b.firstName,b.lastName,b.className,b.guardianName,b.guardianPhone]); return json(res,201,q.rows[0]); }
    if(route(req.method,url.pathname)==='GET /api/dashboard') { const q=await pool.query(`SELECT COALESCE(sum(amount_minor),0)::text expected,COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0)::text paid,COUNT(*) FILTER(WHERE status!='paid')::int unpaid_count FROM invoices WHERE school_id=$1`,[me.schoolId]); return json(res,200,q.rows[0]); }
    return json(res,404,{error:'Route introuvable'});
  } catch(e){ console.error(e); return json(res,e.message==='unauthorized'?401:500,{error:e.message==='unauthorized'?'Authentification requise':'Erreur interne'}); }
});
server.listen(port,'0.0.0.0',()=>console.log(`SCOLARIS API : http://localhost:${port}`));
