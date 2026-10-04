import { canUseAmy } from './amy-service.js';

export function documentInput(value) {
  if (!value || Object.keys(value).some(k=>!['title','content'].includes(k))) throw Error('invalid_body');
  const title=typeof value.title==='string'?value.title.trim():'';
  const content=typeof value.content==='string'?value.content.trim():'';
  if (!title || title.length>160 || !content || content.length>50000 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(title+content)) throw Error('invalid_body');
  return {title,content};
}

export function documentChunks(content) {
  const chunks=[];
  for(let start=0;start<content.length;start+=1500)chunks.push(content.slice(start,start+1800));
  return chunks;
}

export async function findAmySources(pool,schoolId,question) {
  const terms=question.replace(/[^\p{L}\p{N}\s]/gu,' ').trim().split(/\s+/).filter(w=>w.length>2).slice(0,25).join(' OR ');
  if(!terms)return [];
  const {rows}=await pool.query(`SELECT d.title,c.content,c.position
    FROM amy_document_chunks c JOIN amy_documents d ON d.id=c.document_id AND d.school_id=c.school_id
    WHERE c.school_id=$1 AND c.search_vector @@ websearch_to_tsquery('french',$2)
    ORDER BY ts_rank(c.search_vector,websearch_to_tsquery('french',$2)) DESC,d.created_at DESC,c.position LIMIT 5`,[schoolId,terms]);
  return rows.map((r,i)=>({reference:'D'+(i+1),title:r.title,excerpt:r.content}));
}

export function createKnowledgeRouter({pool,json,body,identifier}) {
  return async(req,res,url,me)=>{
    if(!url.pathname.startsWith('/api/amy/documents'))return false;
    if(!canUseAmy(me)){json(res,403,{error:'Accès documentaire non autorisé.'});return true;}
    if(req.method==='GET'&&url.pathname==='/api/amy/documents'){
      const {rows}=await pool.query('SELECT id,title,length(content) characters,created_at FROM amy_documents WHERE school_id=$1 ORDER BY created_at DESC',[me.schoolId]);
      json(res,200,{documents:rows,canManage:me.platformAdmin||['owner','director'].includes(me.role),limits:{documents:50,characters:50000}});return true;
    }
    if(!me.platformAdmin&&!['owner','director'].includes(me.role)){json(res,403,{error:'La direction gère les documents partagés avec AMY.'});return true;}
    if(req.method==='POST'&&url.pathname==='/api/amy/documents'){
      const input=documentInput(await body(req,{maxBytes:210000,maxStringLength:50000})),client=await pool.connect();
      try{
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['amy-documents:'+me.schoolId]);
        const usage=(await client.query('SELECT count(*)::int count,COALESCE(sum(length(content)),0)::int size FROM amy_documents WHERE school_id=$1',[me.schoolId])).rows[0];
        if(usage.count>=50||usage.size+input.content.length>1000000){await client.query('ROLLBACK');json(res,409,{error:'Limite documentaire atteinte : 50 documents ou 1 million de caractères.'});return true;}
        const doc=(await client.query('INSERT INTO amy_documents(school_id,title,content,created_by) VALUES($1,$2,$3,$4) RETURNING id,title,created_at',[me.schoolId,input.title,input.content,me.sub])).rows[0];
        for(const [i,chunk] of documentChunks(input.content).entries())await client.query('INSERT INTO amy_document_chunks(school_id,document_id,position,content) VALUES($1,$2,$3,$4)',[me.schoolId,doc.id,i,chunk]);
        await client.query("INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id) VALUES($1,$2,'amy.document_added','amy_document',$3)",[me.schoolId,me.sub,doc.id]);
        await client.query('COMMIT');json(res,201,doc);
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      return true;
    }
    if(req.method==='DELETE'&&/^\/api\/amy\/documents\/[^/]+$/.test(url.pathname)){
      const id=identifier(url.pathname.split('/').pop());
      const result=await pool.query('DELETE FROM amy_documents WHERE id=$1 AND school_id=$2 RETURNING id',[id,me.schoolId]);
      json(res,result.rowCount?200:404,result.rowCount?{deleted:true}:{error:'Document introuvable.'});return true;
    }
    json(res,405,{error:'Méthode non autorisée.'});return true;
  };
}
