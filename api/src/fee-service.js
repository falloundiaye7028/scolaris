import crypto from "node:crypto";

export const FEE_TYPES = Object.freeze(["tuition", "registration", "uniform", "transport", "other"]);
export const FEE_TYPE_LABELS = Object.freeze({
  tuition: "Mensualité",
  registration: "Frais d’inscription",
  uniform: "Tenue scolaire",
  transport: "Transport",
  other: "Autre",
});
export const FINANCIAL_STATUSES = Object.freeze(["unpaid", "partially_paid", "paid", "cancelled", "exempted"]);
export const DELIVERY_STATUSES = Object.freeze(["not_applicable", "to_prepare", "available", "delivered"]);
export const UNIFORM_ITEM_TYPES = Object.freeze(["Uniforme complet", "Chemise", "Pantalon", "Jupe", "Robe", "Tenue de sport", "Autre"]);

export function financialStatus({ amountDueXof, amountPaidXof, cancelled = false, exempted = false }) {
  if (cancelled) return "cancelled";
  if (exempted) return "exempted";
  if (amountPaidXof <= 0) return "unpaid";
  if (amountPaidXof < amountDueXof) return "partially_paid";
  return "paid";
}

export function xofFromMinor(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 100 !== 0) throw new Error("invalid_body");
  return amount / 100;
}

const MAX_XOF = 90_000_000_000;
const PAYMENT_METHODS = ["Espèces", "Wave", "Orange Money", "Virement", "Carte bancaire", "Chèque", "Autre"];
const ownerOrDirector = (me) => ["owner", "director"].includes(me.role);
const cashier = (me) => ["owner", "director", "accountant"].includes(me.role);
const minor = (xof) => (BigInt(xof) * 100n).toString();
const legacyStatus = (status) => status === "partially_paid" ? "partial" : status === "exempted" ? "paid" : status;

export function createFeeRouter({ pool, authService, body, json, csv, identifier, isoDate, positiveInteger, safeText, oneOf }) {
  const audit = (client, me, action, entity, entityId, metadata = {}) => client.query(
    "INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [me.schoolId, me.sub, action, entity, entityId || null, JSON.stringify(metadata)],
  );

  const optionalId = (value) => value ? identifier(value) : null;
  const optionalDate = (value) => value ? isoDate(value) : null;
  const amountXof = (value, { min = 1 } = {}) => positiveInteger(value, { min, max: MAX_XOF });
  const textOrNull = (value, max = 500) => value ? safeText(value, { min: 1, max }) : null;
  const parseIds = (values, max) => {
    if (!Array.isArray(values) || values.length < 1 || values.length > max) throw new Error("invalid_body");
    return [...new Set(values.map(identifier))];
  };

  const readDefinitionInput = (source) => ({
    academicYearId: identifier(source.academicYearId),
    categoryId: optionalId(source.categoryId),
    name: safeText(source.name, { min: 1, max: 180 }),
    feeType: oneOf(source.feeType, FEE_TYPES),
    amountXof: amountXof(source.amountXof),
    classId: optionalId(source.classId),
    isMandatory: source.isMandatory !== false,
  });

  const validateDefinitionReferences = async (client, schoolId, definition) => {
    const year = (await client.query("SELECT id,label FROM academic_years WHERE id=$1 AND school_id=$2", [definition.academicYearId, schoolId])).rows[0];
    if (!year) return null;
    if (definition.classId) {
      const validClass = await client.query("SELECT 1 FROM classes WHERE id=$1 AND school_id=$2 AND academic_year_id=$3", [definition.classId, schoolId, definition.academicYearId]);
      if (!validClass.rowCount) return null;
    }
    const category = definition.categoryId
      ? (await client.query("SELECT id,system_fee_type,is_system FROM fee_categories WHERE id=$1 AND is_active=true AND (is_system=true OR school_id=$2)", [definition.categoryId, schoolId])).rows[0]
      : (await client.query("SELECT id,system_fee_type,is_system FROM fee_categories WHERE code=$1 AND is_system=true AND is_active=true", [definition.feeType])).rows[0];
    if (!category || (category.system_fee_type && category.system_fee_type !== definition.feeType)) return null;
    return { year, category };
  };

  const resolveTargets = async (client, schoolId, input) => {
    const academicYearId = identifier(input.academicYearId);
    const scope = oneOf(input.scope, ["student", "students", "class", "classes", "all_active"]);
    let studentIds = [], classIds = [];
    if (scope === "student") studentIds = [identifier(input.studentId || input.studentIds?.[0])];
    if (scope === "students") studentIds = parseIds(input.studentIds, 500);
    if (scope === "class") classIds = [identifier(input.classId || input.classIds?.[0])];
    if (scope === "classes") classIds = parseIds(input.classIds, 100);
    let query;
    if (studentIds.length) {
      query = await client.query(`SELECT s.id student_id,e.class_id,c.name class_name
        FROM students s LEFT JOIN enrollments e ON e.student_id=s.id AND e.school_id=$1 AND e.academic_year_id=$2 AND e.status='active'
        LEFT JOIN classes c ON c.id=e.class_id AND c.school_id=$1
        WHERE s.school_id=$1 AND s.status='active' AND s.id=ANY($3::uuid[]) ORDER BY s.id`, [schoolId, academicYearId, studentIds]);
      if (query.rowCount !== studentIds.length) return null;
    } else if (classIds.length) {
      const validClasses = await client.query("SELECT id FROM classes WHERE school_id=$1 AND academic_year_id=$2 AND id=ANY($3::uuid[])", [schoolId, academicYearId, classIds]);
      if (validClasses.rowCount !== classIds.length) return null;
      query = await client.query(`SELECT s.id student_id,e.class_id,c.name class_name
        FROM enrollments e JOIN students s ON s.id=e.student_id AND s.school_id=$1 AND s.status='active'
        JOIN classes c ON c.id=e.class_id AND c.school_id=$1
        WHERE e.school_id=$1 AND e.academic_year_id=$2 AND e.status='active' AND e.class_id=ANY($3::uuid[]) ORDER BY s.id`, [schoolId, academicYearId, classIds]);
    } else {
      query = await client.query(`SELECT s.id student_id,e.class_id,c.name class_name
        FROM enrollments e JOIN students s ON s.id=e.student_id AND s.school_id=$1 AND s.status='active'
        JOIN classes c ON c.id=e.class_id AND c.school_id=$1
        WHERE e.school_id=$1 AND e.academic_year_id=$2 AND e.status='active' ORDER BY s.id`, [schoolId, academicYearId]);
    }
    return { academicYearId, scope, rows: query.rows, studentIds, classIds };
  };

  const paidForInvoice = async (client, schoolId, invoiceId) => Number((await client.query(
    "SELECT (COALESCE(sum(amount_minor),0)/100)::text paid FROM student_fee_payments WHERE school_id=$1 AND invoice_id=$2",
    [schoolId, invoiceId],
  )).rows[0].paid);

  const syncInvoice = async (client, schoolId, invoiceId) => {
    const invoice = (await client.query("SELECT id,amount_expected_xof,discount_xof,financial_status FROM invoices WHERE id=$1 AND school_id=$2 FOR UPDATE", [invoiceId, schoolId])).rows[0];
    if (!invoice) return null;
    const paid = await paidForInvoice(client, schoolId, invoiceId);
    const due = Math.max(0, Number(invoice.amount_expected_xof) - Number(invoice.discount_xof));
    const status = financialStatus({ amountDueXof: due, amountPaidXof: paid, cancelled: invoice.financial_status === "cancelled", exempted: invoice.financial_status === "exempted" });
    return (await client.query(`UPDATE invoices SET amount_due_xof=$1,amount_paid_xof=$2,balance_xof=$3,financial_status=$4,status=$5,updated_at=now()
      WHERE id=$6 AND school_id=$7 RETURNING id,amount_expected_xof,discount_xof,amount_due_xof,amount_paid_xof,balance_xof,financial_status,status`,
    [due, paid, Math.max(0, due - paid), status, legacyStatus(status), invoiceId, schoolId])).rows[0];
  };

  const invoiceFilters = (url, schoolId) => {
    const values = [schoolId], clauses = ["i.school_id=$1"];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
    const feeType = url.searchParams.get("feeType");
    const financial = url.searchParams.get("status");
    if (feeType) add("i.fee_type=?", oneOf(feeType, FEE_TYPES));
    if (financial) add("i.financial_status=?", oneOf(financial, FINANCIAL_STATUSES));
    if (url.searchParams.get("academicYearId")) add("i.academic_year_id=?", identifier(url.searchParams.get("academicYearId")));
    if (url.searchParams.get("classId")) add("i.class_id=?", identifier(url.searchParams.get("classId")));
    if (url.searchParams.get("studentId")) add("i.student_id=?", identifier(url.searchParams.get("studentId")));
    if (url.searchParams.get("dueFrom")) add("i.due_date>=?", isoDate(url.searchParams.get("dueFrom")));
    if (url.searchParams.get("dueTo")) add("i.due_date<=?", isoDate(url.searchParams.get("dueTo")));
    if (url.searchParams.get("q")) add("(s.first_name||' '||s.last_name||' '||s.matricule||' '||COALESCE(c.name,s.class_name,'')||' '||i.label) ILIKE ?", `%${safeText(url.searchParams.get("q"), { max: 120 }).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    return { values, where: clauses.join(" AND ") };
  };

  const selectInvoices = async (url, schoolId, limit = 500) => {
    const filter = invoiceFilters(url, schoolId);
    filter.values.push(limit);
    return (await pool.query(`SELECT i.id,i.student_id,i.fee_definition_id,i.academic_year_id,i.class_id,i.label,i.description,i.amount_minor,i.currency,i.due_date,i.status,i.fee_type,i.is_mandatory,i.amount_expected_xof,i.discount_xof,i.amount_due_xof,
      COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0)::text amount_paid_xof,
      GREATEST(i.amount_due_xof-COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0),0)::text balance_xof,
      CASE WHEN i.financial_status IN ('cancelled','exempted') THEN i.financial_status WHEN COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0)=0 THEN 'unpaid' WHEN COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0)<i.amount_due_xof THEN 'partially_paid' ELSE 'paid' END financial_status,
      i.exemption_reason,i.cancelled_at,i.cancellation_reason,i.created_at,i.updated_at,s.first_name,s.last_name,s.matricule,COALESCE(c.name,s.class_name) class_name,a.label academic_year,
      u.item_type,u.size,u.quantity,u.unit_price_xof,u.total_amount_xof,u.delivery_status,u.delivered_at,u.delivery_note
      FROM invoices i JOIN students s ON s.id=i.student_id AND s.school_id=$1 LEFT JOIN classes c ON c.id=i.class_id AND c.school_id=$1 LEFT JOIN academic_years a ON a.id=i.academic_year_id AND a.school_id=$1 LEFT JOIN uniform_fee_items u ON u.invoice_id=i.id AND u.school_id=$1
      WHERE ${filter.where} ORDER BY i.due_date,i.created_at LIMIT $${filter.values.length}`, filter.values)).rows;
  };

  const createDefinition = async (client, me, definition) => {
    const refs = await validateDefinitionReferences(client, me.schoolId, definition);
    if (!refs) return null;
    const existing = (await client.query(`SELECT id,amount_xof,is_mandatory,category_id FROM fee_definitions WHERE school_id=$1 AND academic_year_id=$2 AND fee_type=$3 AND lower(name)=lower($4)
      AND COALESCE(class_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'::uuid) FOR UPDATE`,
    [me.schoolId, definition.academicYearId, definition.feeType, definition.name, definition.classId])).rows[0];
    if (existing) {
      if (Number(existing.amount_xof) !== definition.amountXof || Boolean(existing.is_mandatory) !== definition.isMandatory || existing.category_id !== refs.category.id) return { conflict: true };
      return existing;
    }
    return (await client.query(`INSERT INTO fee_definitions(school_id,academic_year_id,category_id,name,fee_type,amount_xof,class_id,is_mandatory,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,academic_year_id,category_id,name,fee_type,amount_xof,class_id,is_mandatory,is_active,created_at`,
    [me.schoolId, definition.academicYearId, refs.category.id, definition.name, definition.feeType, definition.amountXof, definition.classId, definition.isMandatory, me.sub])).rows[0];
  };

  const handle = async (req, res, url, me) => {
    const key = `${req.method} ${url.pathname}`;

    if (key === "GET /api/fee-categories") {
      const rows = (await pool.query("SELECT id,code,name,system_fee_type fee_type,is_system,is_active FROM fee_categories WHERE is_active=true AND (is_system=true OR school_id=$1) ORDER BY is_system DESC,name", [me.schoolId])).rows;
      json(res, 200, rows); return true;
    }
    if (key === "POST /api/fee-categories") {
      if (!ownerOrDirector(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      const input = await body(req), code = safeText(input.code, { min: 2, max: 60, pattern: /^[a-z0-9]+(?:_[a-z0-9]+)*$/ }), name = safeText(input.name, { min: 1, max: 120 });
      const row = (await pool.query("INSERT INTO fee_categories(school_id,code,name,system_fee_type,is_system,created_by) VALUES($1,$2,$3,'other',false,$4) RETURNING id,code,name,system_fee_type fee_type,is_system,is_active", [me.schoolId, code, name, me.sub])).rows[0];
      json(res, 201, row); return true;
    }
    if (key === "GET /api/fee-definitions") {
      const params = [me.schoolId], where = ["d.school_id=$1"];
      if (url.searchParams.get("academicYearId")) { params.push(identifier(url.searchParams.get("academicYearId"))); where.push(`d.academic_year_id=$${params.length}`); }
      if (url.searchParams.get("feeType")) { params.push(oneOf(url.searchParams.get("feeType"), FEE_TYPES)); where.push(`d.fee_type=$${params.length}`); }
      const rows = (await pool.query(`SELECT d.id,d.academic_year_id,d.category_id,d.name,d.fee_type,d.amount_xof,d.class_id,d.is_mandatory,d.is_active,d.created_at,d.updated_at,a.label academic_year,c.name class_name,fc.name category_name
        FROM fee_definitions d JOIN academic_years a ON a.id=d.academic_year_id AND a.school_id=$1 LEFT JOIN classes c ON c.id=d.class_id AND c.school_id=$1 JOIN fee_categories fc ON fc.id=d.category_id
        WHERE ${where.join(" AND ")} ORDER BY a.starts_on DESC,d.fee_type,d.name`, params)).rows;
      json(res, 200, rows); return true;
    }
    if (key === "POST /api/fee-definitions") {
      if (!ownerOrDirector(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      const definition = readDefinitionInput(await body(req)), client = await pool.connect();
      try {
        await client.query("BEGIN"); const created = await createDefinition(client, me, definition);
        if (!created) { await client.query("ROLLBACK"); json(res, 404, { error: "Année, classe ou catégorie introuvable" }); return true; }
        if (created.conflict) { await client.query("ROLLBACK"); json(res, 409, { error: "Une définition portant ce nom existe avec une autre configuration" }); return true; }
        await audit(client, me, "fee_definition.created", "fee_definition", created.id, { feeType: definition.feeType, academicYearId: definition.academicYearId, amountXof: definition.amountXof });
        await client.query("COMMIT"); json(res, 201, created); return true;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    if (["POST /api/fee-assignments/preview", "POST /api/fee-assignments/bulk"].includes(key)) {
      if (!ownerOrDirector(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      const input = await body(req), definition = readDefinitionInput(input.definition || input), dueDate = isoDate(input.dueDate), client = await pool.connect();
      try {
        const targets = await resolveTargets(client, me.schoolId, { ...input, academicYearId: definition.academicYearId });
        if (!targets) { json(res, 404, { error: "Sélection d’élèves, de classes ou d’année introuvable" }); return true; }
        if (!targets.rows.length) { json(res, 400, { error: "Aucun élève actif ne correspond à cette sélection" }); return true; }
        const preview = { feeType: definition.feeType, feeTypeLabel: FEE_TYPE_LABELS[definition.feeType], academicYearId: definition.academicYearId, scope: targets.scope, studentCount: targets.rows.length, amountUnitXof: definition.amountXof, amountTotalXof: definition.amountXof * targets.rows.length, dueDate, classIds: targets.classIds, studentIds: targets.studentIds };
        if (key.endsWith("/preview")) { json(res, 200, preview); return true; }
        if (input.confirmed !== true) { json(res, 400, { error: "La création collective doit être confirmée" }); return true; }
        await client.query("BEGIN");
        const createdDefinition = await createDefinition(client, me, definition);
        if (!createdDefinition) { await client.query("ROLLBACK"); json(res, 404, { error: "Année, classe ou catégorie introuvable" }); return true; }
        if (createdDefinition.conflict) { await client.query("ROLLBACK"); json(res, 409, { error: "Une définition portant ce nom existe avec une autre configuration" }); return true; }
        const created = [];
        for (const target of targets.rows) {
          const row = (await client.query(`INSERT INTO invoices(school_id,student_id,label,description,amount_minor,currency,due_date,status,fee_type,fee_definition_id,academic_year_id,class_id,amount_expected_xof,discount_xof,amount_due_xof,amount_paid_xof,balance_xof,financial_status,is_mandatory,created_by)
            VALUES($1,$2,$3,$3,$4,'XOF',$5,'unpaid',$6,$7,$8,$9,$10,0,$10,0,$10,'unpaid',$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
          [me.schoolId, target.student_id, definition.name, minor(definition.amountXof), dueDate, definition.feeType, createdDefinition.id, definition.academicYearId, target.class_id, definition.amountXof, definition.isMandatory, me.sub])).rows[0];
          if (!row) continue;
          created.push(row.id);
          if (definition.feeType === "uniform") {
            const item = input.uniformItem || {};
            const itemType = item.itemType ? oneOf(item.itemType, UNIFORM_ITEM_TYPES) : null;
            const size = textOrNull(item.size, 40), quantity = item.quantity ? positiveInteger(item.quantity, { max: 100 }) : 1;
            const unitPrice = item.unitPriceXof ? amountXof(item.unitPriceXof, { min: 0 }) : null;
            await client.query(`INSERT INTO uniform_fee_items(invoice_id,school_id,item_type,size,quantity,unit_price_xof,total_amount_xof,delivery_status)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, me.schoolId, itemType, size, quantity, unitPrice, definition.amountXof, oneOf(item.deliveryStatus || "to_prepare", DELIVERY_STATUSES)]);
          }
        }
        await audit(client, me, "fee_assignments.bulk_created", "invoice", createdDefinition.id, { feeType: definition.feeType, academicYearId: definition.academicYearId, requested: targets.rows.length, created: created.length, skippedDuplicates: targets.rows.length - created.length, amountUnitXof: definition.amountXof });
        await client.query("COMMIT");
        json(res, 201, { ...preview, feeDefinitionId: createdDefinition.id, created: created.length, skippedDuplicates: targets.rows.length - created.length, invoiceIds: created }); return true;
      } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); }
    }
    if (["POST /api/invoices", "POST /api/invoices/bulk"].includes(key)) {
      const input = await body(req), feeType = oneOf(input.feeType || "other", FEE_TYPES), label = safeText(input.label, { min: 1, max: 180 }), dueDate = isoDate(input.dueDate);
      if (String(input.currency || "XOF").trim().toUpperCase() !== "XOF") { json(res, 400, { error: "Les nouveaux frais doivent être enregistrés en XOF" }); return true; }
      const expected = input.amountXof ? amountXof(input.amountXof) : xofFromMinor(input.amountMinor);
      if (key.endsWith("/bulk")) {
        const result = await pool.query(`INSERT INTO invoices(school_id,student_id,label,description,amount_minor,currency,due_date,status,fee_type,amount_expected_xof,amount_due_xof,balance_xof,financial_status,is_mandatory,created_by)
          SELECT $1,s.id,$2,$2,$3,'XOF',$4,'unpaid',$5,$6,$6,$6,'unpaid',true,$7 FROM students s WHERE s.school_id=$1 AND s.status='active' RETURNING id`, [me.schoolId, label, minor(expected), dueDate, feeType, expected, me.sub]);
        await audit(pool, me, "invoices.bulk_created", "invoice", null, { count: result.rowCount, feeType, amountXof: expected });
        json(res, 201, { created: result.rowCount, invoiceIds: result.rows.map((row) => row.id) }); return true;
      }
      const studentId = identifier(input.studentId), row = (await pool.query(`INSERT INTO invoices(school_id,student_id,label,description,amount_minor,currency,due_date,status,fee_type,amount_expected_xof,amount_due_xof,balance_xof,financial_status,is_mandatory,created_by)
        SELECT $1,$2,$3,$3,$4,'XOF',$5,'unpaid',$6,$7,$7,$7,'unpaid',true,$8 WHERE EXISTS(SELECT 1 FROM students WHERE id=$2 AND school_id=$1)
        RETURNING id,student_id,label,amount_minor,currency,due_date,status,fee_type,amount_expected_xof,amount_due_xof,balance_xof,financial_status,created_at`, [me.schoolId, studentId, label, minor(expected), dueDate, feeType, expected, me.sub])).rows[0];
      if (!row) { json(res, 404, { error: "Élève introuvable" }); return true; }
      json(res, 201, row); return true;
    }
    if (key === "GET /api/invoices") { json(res, 200, await selectInvoices(url, me.schoolId, 500)); return true; }
    if (req.method === "POST" && /^\/api\/fee-assignments\/[^/]+\/adjust$/.test(url.pathname)) {
      if (!ownerOrDirector(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      authService.requireRecentAuthentication(me);
      const invoiceId = identifier(url.pathname.split("/")[3]), input = await body(req), action = oneOf(input.action, ["discount", "exempt", "cancel"]), reason = safeText(input.reason, { min: 8, max: 500 }), client = await pool.connect();
      try {
        await client.query("BEGIN");
        const invoice = (await client.query("SELECT id,amount_expected_xof,discount_xof,financial_status FROM invoices WHERE id=$1 AND school_id=$2 FOR UPDATE", [invoiceId, me.schoolId])).rows[0];
        if (!invoice) { await client.query("ROLLBACK"); json(res, 404, { error: "Échéance introuvable" }); return true; }
        if (["cancelled", "exempted"].includes(invoice.financial_status)) { await client.query("ROLLBACK"); json(res, 409, { error: "Cette échéance ne peut plus être modifiée" }); return true; }
        const paid = await paidForInvoice(client, me.schoolId, invoiceId), expected = Number(invoice.amount_expected_xof), previous = Number(invoice.discount_xof);
        let adjustment = 0, resultingStatus = invoice.financial_status;
        if (action === "discount") {
          adjustment = input.discountPercent ? Math.round(expected * positiveInteger(input.discountPercent, { max: 100 }) / 100) : amountXof(input.discountXof);
          if (adjustment <= previous || expected - adjustment < paid) { await client.query("ROLLBACK"); json(res, 400, { error: "La remise est incompatible avec les paiements déjà enregistrés" }); return true; }
          await client.query("UPDATE invoices SET discount_xof=$1,amount_due_xof=$2,balance_xof=$3,updated_at=now() WHERE id=$4", [adjustment, expected - adjustment, expected - adjustment - paid, invoiceId]);
        } else if (action === "exempt") {
          if (paid > 0) { await client.query("ROLLBACK"); json(res, 400, { error: "Annulez d’abord les paiements avant d’exonérer cette échéance" }); return true; }
          adjustment = expected; resultingStatus = "exempted";
          await client.query("UPDATE invoices SET discount_xof=amount_expected_xof,amount_due_xof=0,balance_xof=0,financial_status='exempted',status='paid',exemption_reason=$1,updated_at=now() WHERE id=$2", [reason, invoiceId]);
        } else {
          resultingStatus = "cancelled";
          await client.query("UPDATE invoices SET financial_status='cancelled',status='cancelled',cancelled_at=now(),cancelled_by=$1,cancellation_reason=$2,updated_at=now() WHERE id=$3", [me.sub, reason, invoiceId]);
        }
        await client.query("INSERT INTO fee_adjustments(school_id,invoice_id,adjustment_type,original_amount_expected_xof,previous_discount_xof,adjustment_xof,reason,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [me.schoolId, invoiceId, action === "exempt" ? "exemption" : action === "cancel" ? "cancellation" : "discount", expected, previous, adjustment, reason, me.sub]);
        if (action === "discount") resultingStatus = (await syncInvoice(client, me.schoolId, invoiceId)).financial_status;
        await audit(client, me, `fee_assignment.${action === "exempt" ? "exempted" : action === "cancel" ? "cancelled" : "discounted"}`, "invoice", invoiceId, { reason, previousDiscountXof: previous, adjustmentXof: adjustment });
        await client.query("COMMIT"); json(res, 200, { id: invoiceId, financialStatus: resultingStatus, discountXof: adjustment }); return true;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    if (req.method === "PUT" && /^\/api\/uniform-assignments\/[^/]+\/delivery$/.test(url.pathname)) {
      if (!ownerOrDirector(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      const invoiceId = identifier(url.pathname.split("/")[3]), input = await body(req), deliveryStatus = oneOf(input.deliveryStatus, DELIVERY_STATUSES), note = textOrNull(input.deliveryNote, 500), client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await client.query(`SELECT u.delivery_status FROM uniform_fee_items u JOIN invoices i ON i.id=u.invoice_id AND i.school_id=$2 AND i.fee_type='uniform'
          WHERE u.invoice_id=$1 AND u.school_id=$2 FOR UPDATE`, [invoiceId, me.schoolId])).rows[0];
        if (!current) { await client.query("ROLLBACK"); json(res, 404, { error: "Frais de tenue introuvable" }); return true; }
        if (current.delivery_status === "delivered" && deliveryStatus !== "delivered" && (!note || note.length < 8)) {
          await client.query("ROLLBACK"); json(res, 400, { error: "Un motif d’au moins 8 caractères est obligatoire pour annuler une remise" }); return true;
        }
        const row = (await client.query(`UPDATE uniform_fee_items SET delivery_status=$1,delivered_at=CASE WHEN $1='delivered' THEN now() ELSE NULL END,delivered_by=CASE WHEN $1='delivered' THEN $2::uuid ELSE NULL END,delivery_note=$3,updated_at=now()
          WHERE invoice_id=$4 AND school_id=$5 RETURNING invoice_id,delivery_status,delivered_at,delivered_by,delivery_note`, [deliveryStatus, me.sub, note, invoiceId, me.schoolId])).rows[0];
        await client.query("INSERT INTO uniform_delivery_events(school_id,invoice_id,previous_status,new_status,note,changed_by) VALUES($1,$2,$3,$4,$5,$6)", [me.schoolId, invoiceId, current.delivery_status, deliveryStatus, note, me.sub]);
        await audit(client, me, "uniform.delivery_status_changed", "invoice", invoiceId, { previousStatus: current.delivery_status, deliveryStatus, note: Boolean(note) });
        await client.query("COMMIT"); json(res, 200, row); return true;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    if (["POST /api/payments", "POST /api/student-fee-payments"].includes(key)) {
      if (!cashier(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      authService.requireRecentAuthentication(me);
      const input = await body(req), method = oneOf(input.method, PAYMENT_METHODS), reference = safeText(input.reference || `PAY-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(Date.now()).slice(-7)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`, { min: 3, max: 120 });
      let allocations;
      if (Array.isArray(input.allocations)) allocations = input.allocations.map((item) => ({ invoiceId: identifier(item.invoiceId), amountXof: amountXof(item.amountXof) }));
      else allocations = [{ invoiceId: identifier(input.invoiceId), amountXof: input.amountXof ? amountXof(input.amountXof) : xofFromMinor(input.amountMinor) }];
      if (!allocations.length || allocations.length > 50) throw new Error("invalid_body");
      const merged = new Map(); for (const item of allocations) merged.set(item.invoiceId, (merged.get(item.invoiceId) || 0) + item.amountXof);
      allocations = [...merged].map(([invoiceId, value]) => ({ invoiceId, amountXof: amountXof(value) }));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const ids = allocations.map((item) => item.invoiceId), invoices = (await client.query("SELECT id,student_id,amount_expected_xof,discount_xof,currency,financial_status FROM invoices WHERE school_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE", [me.schoolId, ids])).rows;
        if (invoices.length !== ids.length) { await client.query("ROLLBACK"); json(res, 404, { error: "Échéance introuvable" }); return true; }
        if (new Set(invoices.map((item) => item.student_id)).size !== 1) { await client.query("ROLLBACK"); json(res, 400, { error: "Un paiement ventilé doit concerner un seul élève" }); return true; }
        const receiptSnapshots = new Map();
        for (const allocation of allocations) {
          const invoice = invoices.find((item) => item.id === allocation.invoiceId);
          if (String(invoice.currency).trim() !== "XOF" || ["cancelled", "exempted"].includes(invoice.financial_status)) { await client.query("ROLLBACK"); json(res, 400, { error: "Paiement incompatible avec cette échéance" }); return true; }
          const paid = await paidForInvoice(client, me.schoolId, invoice.id), expected = Number(invoice.amount_expected_xof), due = expected - Number(invoice.discount_xof), remaining = due - paid;
          if (allocation.amountXof > remaining) { await client.query("ROLLBACK"); json(res, 400, { error: "Le montant dépasse le solde restant" }); return true; }
          receiptSnapshots.set(invoice.id, { expected, totalPaidAfter: paid + allocation.amountXof, balanceAfter: remaining - allocation.amountXof });
        }
        const total = allocations.reduce((sum, item) => sum + item.amountXof, 0), studentId = invoices[0].student_id;
        const batch = (await client.query(`INSERT INTO student_payment_batches(school_id,student_id,total_amount_xof,method,reference,paid_at,recorded_by)
          VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()),$7) RETURNING id,student_id,total_amount_xof,currency,method,reference,paid_at,recorded_by,status`,
        [me.schoolId, studentId, total, method, reference, input.paidAt || null, me.sub])).rows[0];
        const inserted = [];
        for (const allocation of allocations) {
          const snapshot = receiptSnapshots.get(allocation.invoiceId);
          inserted.push((await client.query(`INSERT INTO student_payment_allocations(school_id,payment_batch_id,invoice_id,amount_xof,amount_expected_xof_snapshot,total_paid_after_xof,balance_after_xof)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,invoice_id,amount_xof`, [me.schoolId, batch.id, allocation.invoiceId, allocation.amountXof, snapshot.expected, snapshot.totalPaidAfter, snapshot.balanceAfter])).rows[0]);
        }
        const receiptNumber = `SCP-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-8)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
        const receipt = (await client.query("INSERT INTO receipts(school_id,payment_id,payment_batch_id,number) VALUES($1,NULL,$2,$3) RETURNING id,payment_batch_id,number,issued_at", [me.schoolId, batch.id, receiptNumber])).rows[0];
        const states = []; for (const allocation of allocations) states.push(await syncInvoice(client, me.schoolId, allocation.invoiceId));
        await audit(client, me, "student_fee_payment.created", "student_payment_batch", batch.id, { totalAmountXof: total, method, allocations: allocations.map((item) => ({ invoiceId: item.invoiceId, amountXof: item.amountXof })) });
        await client.query("COMMIT");
        await authService.securityEvent(req, { type: "student_fee_payment.created", severity: "warning", outcome: "success", userId: me.sub, schoolId: me.schoolId, metadata: { paymentBatchId: batch.id, totalAmountXof: total, allocationCount: allocations.length } });
        const first = inserted[0], firstState = states[0];
        json(res, 201, { payment: { id: first.id, student_id: studentId, invoice_id: first.invoice_id, amount_minor: minor(first.amount_xof), currency: "XOF", method, reference, paid_at: batch.paid_at, payment_batch_id: batch.id }, paymentBatch: batch, allocations: inserted, receipt, invoiceStatus: legacyStatus(firstState.financial_status), financialStatus: firstState.financial_status }); return true;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    if (req.method === "POST" && /^\/api\/student-payments\/[^/]+\/cancel$/.test(url.pathname)) {
      if (!ownerOrDirector(me)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      authService.requireRecentAuthentication(me);
      const batchId = identifier(url.pathname.split("/")[3]), input = await body(req), reason = safeText(input.reason, { min: 8, max: 500 }), client = await pool.connect();
      try {
        await client.query("BEGIN");
        const batch = (await client.query("UPDATE student_payment_batches SET status='cancelled',cancelled_at=now(),cancelled_by=$1,cancellation_reason=$2,updated_at=now() WHERE id=$3 AND school_id=$4 AND status='confirmed' RETURNING id", [me.sub, reason, batchId, me.schoolId])).rows[0];
        let ids;
        if (batch) ids = (await client.query("SELECT invoice_id FROM student_payment_allocations WHERE payment_batch_id=$1 AND school_id=$2", [batchId, me.schoolId])).rows.map((row) => row.invoice_id);
        else {
          const legacy = (await client.query("UPDATE payments SET status='cancelled',cancelled_at=now(),cancelled_by=$1,cancellation_reason=$2 WHERE id=$3 AND school_id=$4 AND status='confirmed' RETURNING invoice_id", [me.sub, reason, batchId, me.schoolId])).rows[0];
          if (!legacy) { await client.query("ROLLBACK"); json(res, 404, { error: "Paiement confirmé introuvable" }); return true; }
          ids = legacy.invoice_id ? [legacy.invoice_id] : [];
        }
        for (const id of ids) await syncInvoice(client, me.schoolId, id);
        await audit(client, me, "student_fee_payment.cancelled", "student_payment_batch", batchId, { reason, invoiceIds: ids });
        await client.query("COMMIT"); json(res, 200, { id: batchId, status: "cancelled" }); return true;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    if (key === "GET /api/receipts") {
      const current = (await pool.query(`SELECT r.id,r.number,r.issued_at,b.id payment_batch_id,b.paid_at,(b.total_amount_xof::bigint*100)::text amount_minor,b.total_amount_xof,b.currency,b.method,b.reference,b.status,s.matricule,s.first_name,s.last_name,MAX(COALESCE(c.name,s.class_name)) class_name,sc.name school_name,u.name recorded_by_name,
        json_agg(json_build_object('invoiceId',i.id,'feeType',i.fee_type,'category',CASE i.fee_type WHEN 'tuition' THEN 'Mensualité' WHEN 'registration' THEN 'Frais d’inscription' WHEN 'uniform' THEN 'Tenue scolaire' WHEN 'transport' THEN 'Transport' ELSE 'Autre' END,'academicYear',ay.label,'description',i.description,'amountExpectedXof',COALESCE(a.amount_expected_xof_snapshot,i.amount_expected_xof),'paymentAmountXof',a.amount_xof,'totalPaidXof',COALESCE(a.total_paid_after_xof,i.amount_paid_xof),'balanceXof',COALESCE(a.balance_after_xof,i.balance_xof),'itemType',ui.item_type,'size',ui.size,'quantity',ui.quantity,'deliveryStatus',ui.delivery_status) ORDER BY i.due_date) allocations
        FROM receipts r JOIN student_payment_batches b ON b.id=r.payment_batch_id AND b.school_id=$1 JOIN students s ON s.id=b.student_id AND s.school_id=$1 JOIN schools sc ON sc.id=b.school_id JOIN users u ON u.id=b.recorded_by
        JOIN student_payment_allocations a ON a.payment_batch_id=b.id AND a.school_id=$1 JOIN invoices i ON i.id=a.invoice_id AND i.school_id=$1 LEFT JOIN classes c ON c.id=i.class_id AND c.school_id=$1 LEFT JOIN academic_years ay ON ay.id=i.academic_year_id AND ay.school_id=$1 LEFT JOIN uniform_fee_items ui ON ui.invoice_id=i.id AND ui.school_id=$1
        WHERE r.school_id=$1 GROUP BY r.id,b.id,s.id,sc.id,u.id ORDER BY r.issued_at DESC LIMIT 500`, [me.schoolId])).rows;
      const legacy = (await pool.query(`SELECT r.id,r.number,r.issued_at,p.paid_at,p.amount_minor,p.currency,p.method,p.reference,p.status,s.matricule,s.first_name,s.last_name,s.class_name,sc.name school_name,u.name recorded_by_name,
        json_build_array(json_build_object('invoiceId',i.id,'feeType',i.fee_type,'category',CASE i.fee_type WHEN 'tuition' THEN 'Mensualité' WHEN 'registration' THEN 'Frais d’inscription' WHEN 'uniform' THEN 'Tenue scolaire' WHEN 'transport' THEN 'Transport' ELSE 'Autre' END,'academicYear',ay.label,'description',i.description,'amountExpectedXof',i.amount_expected_xof,'paymentAmountXof',(p.amount_minor/100),'totalPaidXof',i.amount_paid_xof,'balanceXof',i.balance_xof)) allocations
        FROM receipts r JOIN payments p ON p.id=r.payment_id AND p.school_id=$1 JOIN students s ON s.id=p.student_id AND s.school_id=$1 LEFT JOIN invoices i ON i.id=p.invoice_id AND i.school_id=$1 LEFT JOIN academic_years ay ON ay.id=i.academic_year_id AND ay.school_id=$1 JOIN schools sc ON sc.id=r.school_id LEFT JOIN users u ON u.id=p.recorded_by WHERE r.school_id=$1 AND r.payment_id IS NOT NULL ORDER BY r.issued_at DESC LIMIT 500`, [me.schoolId])).rows;
      json(res, 200, [...current, ...legacy].sort((a, b) => new Date(b.issued_at) - new Date(a.issued_at)).slice(0, 500)); return true;
    }
    if (key === "GET /api/collections/overdue") {
      const rows = await selectInvoices(new URL(`${url.origin}${url.pathname}?status=unpaid`), me.schoolId, 500);
      const partial = await selectInvoices(new URL(`${url.origin}${url.pathname}?status=partially_paid`), me.schoolId, 500);
      json(res, 200, [...rows, ...partial].filter((item) => new Date(item.due_date) < new Date(new Date().toISOString().slice(0, 10))).map((item) => ({ ...item, paid_minor: minor(item.amount_paid_xof), balance_minor: minor(item.balance_xof), days_overdue: Math.floor((Date.now() - new Date(`${item.due_date}T00:00:00Z`).getTime()) / 86_400_000) }))); return true;
    }
    if (key === "GET /api/reports/fees") {
      const feeType = oneOf(url.searchParams.get("feeType"), ["registration", "uniform"]), params = [me.schoolId, feeType], where = ["i.school_id=$1", "i.fee_type=$2"];
      if (url.searchParams.get("academicYearId")) { params.push(identifier(url.searchParams.get("academicYearId"))); where.push(`i.academic_year_id=$${params.length}`); }
      const summary = (await pool.query(`WITH x AS (SELECT i.*,COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0)::integer paid FROM invoices i WHERE ${where.join(" AND ")})
        SELECT COALESCE(sum(amount_due_xof) FILTER(WHERE financial_status<>'cancelled'),0)::text expected_xof,COALESCE(sum(paid) FILTER(WHERE financial_status<>'cancelled'),0)::text paid_xof,
        COALESCE(sum(GREATEST(amount_due_xof-paid,0)) FILTER(WHERE financial_status NOT IN ('cancelled','exempted')),0)::text balance_xof,count(DISTINCT student_id) FILTER(WHERE financial_status='paid')::int paid_students,
        count(DISTINCT student_id) FILTER(WHERE financial_status='partially_paid' OR (paid>0 AND paid<amount_due_xof))::int partial_count,count(DISTINCT student_id) FILTER(WHERE financial_status='unpaid' AND paid=0)::int unpaid_count,count(DISTINCT student_id) FILTER(WHERE financial_status='exempted')::int exempted_count FROM x`, params)).rows[0];
      let delivery = null;
      if (feeType === "uniform") {
        const deliveryParams = [me.schoolId], deliveryWhere = ["u.school_id=$1", "i.financial_status<>'cancelled'"];
        if (url.searchParams.get("academicYearId")) { deliveryParams.push(identifier(url.searchParams.get("academicYearId"))); deliveryWhere.push(`i.academic_year_id=$${deliveryParams.length}`); }
        delivery = (await pool.query(`SELECT count(*) FILTER(WHERE u.delivery_status='to_prepare')::int to_prepare,count(*) FILTER(WHERE u.delivery_status='available')::int available,count(*) FILTER(WHERE u.delivery_status='delivered')::int delivered,
        COALESCE(json_agg(json_build_object('itemType',u.item_type,'size',u.size,'quantity',u.quantity,'deliveryStatus',u.delivery_status) ORDER BY u.item_type,u.size) FILTER(WHERE u.invoice_id IS NOT NULL),'[]') details
        FROM uniform_fee_items u JOIN invoices i ON i.id=u.invoice_id AND i.school_id=$1 WHERE ${deliveryWhere.join(" AND ")}`, deliveryParams)).rows[0];
      }
      json(res, 200, { feeType, label: FEE_TYPE_LABELS[feeType], ...summary, delivery }); return true;
    }
    if (key === "GET /api/exports/fees.csv") {
      authService.requireRecentAuthentication(me); const rows = await selectInvoices(url, me.schoolId, 5001);
      if (rows.length > 5000) { json(res, 413, { error: "Export trop volumineux. Réduisez les filtres." }); return true; }
      await audit(pool, me, "fees.exported", "invoice", null, { rows: rows.length, filters: Object.fromEntries(url.searchParams) });
      csv(res, "frais-scolaires.csv", [["Catégorie", "Année scolaire", "Classe", "Matricule", "Prénom", "Nom", "Description", "Montant attendu XOF", "Remise XOF", "Montant dû XOF", "Payé XOF", "Solde XOF", "Statut financier", "Échéance", "Article", "Taille", "Quantité", "Statut de remise"], ...rows.map((item) => [FEE_TYPE_LABELS[item.fee_type], item.academic_year, item.class_name, item.matricule, item.first_name, item.last_name, item.description, item.amount_expected_xof, item.discount_xof, item.amount_due_xof, item.amount_paid_xof, item.balance_xof, item.financial_status, item.due_date, item.item_type, item.size, item.quantity, item.delivery_status])]); return true;
    }
    if (key === "GET /api/exports/payments.csv") {
      authService.requireRecentAuthentication(me);
      const rows = (await pool.query(`SELECT * FROM (SELECT b.paid_at,s.matricule,s.first_name,s.last_name,COALESCE(c.name,s.class_name) class_name,i.fee_type,i.description,a.amount_xof,b.method,b.reference,r.number receipt,u.name recorded_by_name
        FROM student_payment_batches b JOIN student_payment_allocations a ON a.payment_batch_id=b.id AND a.school_id=$1 JOIN invoices i ON i.id=a.invoice_id AND i.school_id=$1 JOIN students s ON s.id=b.student_id AND s.school_id=$1 LEFT JOIN classes c ON c.id=i.class_id AND c.school_id=$1 LEFT JOIN receipts r ON r.payment_batch_id=b.id AND r.school_id=$1 JOIN users u ON u.id=b.recorded_by
        WHERE b.school_id=$1 AND b.status='confirmed'
        UNION ALL SELECT p.paid_at,s.matricule,s.first_name,s.last_name,s.class_name,i.fee_type,COALESCE(i.description,i.label),(p.amount_minor/100)::bigint amount_xof,p.method,p.reference,r.number receipt,u.name recorded_by_name
        FROM payments p JOIN invoices i ON i.id=p.invoice_id AND i.school_id=$1 JOIN students s ON s.id=p.student_id AND s.school_id=$1 LEFT JOIN receipts r ON r.payment_id=p.id AND r.school_id=$1 LEFT JOIN users u ON u.id=p.recorded_by
        WHERE p.school_id=$1 AND p.status='confirmed') history ORDER BY paid_at DESC LIMIT 5001`, [me.schoolId])).rows;
      if (rows.length > 5000) { json(res, 413, { error: "Export trop volumineux. Réduisez la période." }); return true; }
      await audit(pool, me, "student_fee_payments.exported", "student_payment_batch", null, { rows: rows.length });
      csv(res, "bilan-paiements-scolaires.csv", [["Date", "Matricule", "Prénom", "Nom", "Classe", "Catégorie", "Description", "Montant XOF", "Méthode", "Référence", "Reçu", "Enregistré par"], ...rows.map((item) => [item.paid_at.toISOString(), item.matricule, item.first_name, item.last_name, item.class_name, FEE_TYPE_LABELS[item.fee_type], item.description, item.amount_xof, item.method, item.reference, item.receipt, item.recorded_by_name])]); return true;
    }
    if (key === "GET /api/dashboard") {
      const row = (await pool.query(`WITH x AS (SELECT i.*,COALESCE((SELECT sum(p.amount_minor)/100 FROM student_fee_payments p WHERE p.invoice_id=i.id AND p.school_id=$1),0)::integer paid FROM invoices i WHERE i.school_id=$1 AND i.financial_status<>'cancelled')
        SELECT (COALESCE(sum(amount_due_xof),0)*100)::text expected,(COALESCE(sum(paid),0)*100)::text paid,count(*) FILTER(WHERE financial_status NOT IN ('paid','exempted'))::int unpaid_count FROM x`, [me.schoolId])).rows[0];
      json(res, 200, row); return true;
    }
    if (req.method === "GET" && /^\/api\/students\/[^/]+\/statement$/.test(url.pathname)) {
      const studentId = identifier(url.pathname.split("/")[3]), student = (await pool.query("SELECT id,matricule,first_name,last_name,class_name,guardian_name,guardian_phone,status,created_at FROM students WHERE id=$1 AND school_id=$2", [studentId, me.schoolId])).rows[0];
      if (!student) { json(res, 404, { error: "Élève introuvable" }); return true; }
      const statementUrl = new URL(`${url.origin}/api/invoices?studentId=${studentId}`), invoices = await selectInvoices(statementUrl, me.schoolId, 500);
      const currentPayments = (await pool.query(`SELECT b.id payment_batch_id,b.total_amount_xof,(b.total_amount_xof::bigint*100)::text amount_minor,b.currency,b.method,b.reference,b.paid_at,r.id receipt_id,r.number receipt_number,u.name recorded_by_name,
        json_agg(json_build_object('invoiceId',i.id,'feeType',i.fee_type,'description',i.description,'amountXof',a.amount_xof) ORDER BY i.due_date) allocations
        FROM student_payment_batches b JOIN student_payment_allocations a ON a.payment_batch_id=b.id AND a.school_id=$2 JOIN invoices i ON i.id=a.invoice_id AND i.school_id=$2 LEFT JOIN receipts r ON r.payment_batch_id=b.id AND r.school_id=$2 JOIN users u ON u.id=b.recorded_by
        WHERE b.student_id=$1 AND b.school_id=$2 AND b.status='confirmed' GROUP BY b.id,r.id,u.id ORDER BY b.paid_at DESC LIMIT 500`, [studentId, me.schoolId])).rows;
      const legacyPayments = (await pool.query(`SELECT NULL payment_batch_id,(p.amount_minor/100)::bigint total_amount_xof,p.amount_minor,p.currency,p.method,p.reference,p.paid_at,r.id receipt_id,r.number receipt_number,u.name recorded_by_name,
        json_build_array(json_build_object('invoiceId',i.id,'feeType',i.fee_type,'description',COALESCE(i.description,i.label),'amountXof',(p.amount_minor/100))) allocations
        FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id AND i.school_id=$2 LEFT JOIN receipts r ON r.payment_id=p.id AND r.school_id=$2 LEFT JOIN users u ON u.id=p.recorded_by
        WHERE p.student_id=$1 AND p.school_id=$2 AND p.status='confirmed' ORDER BY p.paid_at DESC LIMIT 500`, [studentId, me.schoolId])).rows;
      const payments = [...currentPayments, ...legacyPayments].sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at)).slice(0, 500);
      const summary = Object.fromEntries(FEE_TYPES.map((type) => { const rows = invoices.filter((item) => item.fee_type === type && item.financial_status !== "cancelled"); return [type, { expectedXof: rows.reduce((sum, item) => sum + Number(item.amount_due_xof), 0), paidXof: rows.reduce((sum, item) => sum + Number(item.amount_paid_xof), 0), balanceXof: rows.reduce((sum, item) => sum + Number(item.balance_xof), 0), deliveryStatuses: rows.filter((item) => item.delivery_status).map((item) => item.delivery_status) }]; }));
      json(res, 200, { student, summary, invoices, payments }); return true;
    }
    return false;
  };

  return { handle };
}
