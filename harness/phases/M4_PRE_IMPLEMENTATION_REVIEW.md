# M4 pre-implementation review

## Status

`M4_PRE_AUDIT_BLOCKERS_REMEDIATED_PENDING_REMOTE_EVIDENCE`

The product scope remains unchanged. M4.0 closes the identified local toolchain, lifecycle, authentication denial-of-service, supply-chain and historical-integrity blockers without adding new M4 business functionality. Remote CI, Preview benchmark/visual evidence and final human approvals remain mandatory gates.

## Business objective

Add private, tenant-isolated assessment and grade management on top of M1–M3: assessment types, configurable scales/policies, assessments, batch grade entry, statuses, weighted averages, publication/locking, traceable corrections, reports, and secured CSV exports. The design must remain reusable by M5 bulletins and future parent/student read-only portals.

## Planned functions

- School grading settings: scale, rounding, absence, and missing-grade policies.
- Controlled assessment types.
- Assessment CRUD and draft/published/locked/cancelled workflow.
- Scores on arbitrary positive maxima and positive assessment coefficients.
- Per-class batch grade entry for current enrollments.
- `scored`, `absent`, `excused`, `exempt`, and `pending` result states.
- Optimistic concurrency and HTTP 409.
- Grade correction reason/history and audit logs.
- Weighted assessment, subject, period, and general averages using decimal-safe arithmetic.
- Student, assessment, subject, and class reports.
- Bounded, authorized, audited, formula-safe CSV export.
- Responsive private UI and a Notes section in the student view.

## Explicit non-scope

No M5 bulletin/PDF, conseil decisions, public ranking, student rank, director general appreciation, full parent/student portal, SMS/WhatsApp publication, courses/exercises, HR/payroll/stock/cards, online payments, native mobile application, or public-homepage announcement.

## Existing foundations and components

- `academic_years`, `academic_periods`, `classes`, `enrollments`, `students`.
- `subjects`, `teaching_assignments`, teacher users, timetable/session services.
- Server-side session authentication, role permissions, audit logs, origin/CSRF controls, private no-store headers, CSV escaping, pagination, tenant-scoped SQL conventions, and M3 optimistic versioning.
- Primary server integration points: `api/src/server.js`, `api/src/security.js`, `api/src/migrate.js`.
- Planned isolated service: `grades-service.js`; planned UI integration: `web/private-app.html` and its existing private application controls.

No effective subject coefficient exists on M3 `teaching_assignments`; `subjects` also has no default coefficient. The M4 plan must use a class/subject/year-effective coefficient, preferably on the teaching assignment only if audit confirms one assignment represents that exact effective context.

## Database plan only — no migration created

Proposed additive objects:

- `grading_settings`: one tenant configuration, decimal scale and explicit policies.
- `assessment_types`: tenant code/name/active.
- `assessments`: school/year/period/teaching assignment/type, date, `NUMERIC` maximum and coefficient, lifecycle timestamps/users, version.
- `assessment_results`: school/assessment/student/enrollment, status, nullable `NUMERIC` score, comment, actors/timestamps, version, unique assessment+student.
- `grade_events`: immutable correction/history entries.
- effective subject coefficient: either additive `teaching_assignments.subject_coefficient NUMERIC` or a separate school/year/class/subject table after explicit design approval.

Required composite foreign keys must carry `school_id` and, where applicable, `academic_year_id`. The assessment must derive class, subject, and teacher from `teaching_assignments`; result eligibility must use the matching enrollment, never `students.current_class`.

Constraints include positive scale/max/coefficient, allowed lifecycle/result states, scored requires a score, non-scored states forbid a score, score within `[0, maximum_score]`, date inside both year and period, one result per assessment/student, and positive version. Indexes should follow measured queries, especially tenant+period/assignment/status/date and assessment+student.

Backfill should be limited to a single default `grading_settings` row per existing school and controlled default assessment types if human-approved. No existing grade data exists to transform. Use expand/migrate/contract: additive expand only in M4; no contract/drop. Estimated DDL should be short on the current small schema, but production lock duration must be measured on a Preview clone. Any destructive migration is `REQUIRES_EXPLICIT_HUMAN_APPROVAL`.

Rollback strategy is roll-forward or application-only rollback while retaining additive M4 tables. Dropping grades/history after users enter data is not an acceptable rollback.

## Formulas and invariants

- `normalized = score / maximum_score × scale_max`.
- `subject_average = Σ(normalized × assessment_coefficient) / Σ(included assessment coefficients)`.
- `general_average = Σ(subject_average × effective subject_coefficient) / Σ(included subject coefficients)`.
- Use PostgreSQL `NUMERIC` or decimal-string/integer-rational logic; never binary `FLOAT/REAL` for authoritative calculations.
- Preserve extra precision internally and round only at the configured display/output boundary.
- Default absence/missing policy is exclusion; zero must be explicit.
- Cancelled assessments, excused, exempt, and pending results are excluded unless an approved explicit policy states otherwise.
- Mandatory fixture: Mathematics 12/20×1 and 8/10×2 → 14.67 display; Math 14.67 coefficient 4 and French 13 coefficient 3 → 13.95 using non-premature internal precision.

## Planned routes and authorization

Route families should be private and tenant-derived: grading settings, assessment types, assessments, batch results, corrections/history, averages/reports, and grade CSV exports. The client must never supply an authoritative `school_id`.

Planned permissions: `assessments.read/create/update/publish/lock/reopen`, `grades.read/enter/correct`, `grade_reports.read/export`, and `grading_settings.manage`.

- owner/director: tenant-wide access according to permission;
- teacher: only own active teaching assignments and their enrolled students;
- accountant: denied by default;
- any future parent/student: no M4 write or broad read access;
- platform admin: explicit, audited privileged path only if the existing security model requires it.

Every service query must bind authenticated tenant. PostgreSQL composite constraints are defense in depth, not a replacement for authorization.

## Personal and sensitive data

Grades, absences during assessments, comments, student identity, enrollment, teacher identity, correction reasons, and audit history are private educational records. Limit response fields, apply no-store headers, prevent public indexing/caching, avoid sensitive audit metadata, and never include full grade datasets in error logs.

## Abuse cases and required controls

- Cross-school identifiers and IDOR: tenant-bound queries + composite FKs + negative tests.
- Teacher accessing another assignment: service-side assignment membership.
- Mass assignment/batch bypass: field allowlist and validate all rows before one atomic transaction.
- Published/locked alteration: version/status predicate, privilege, mandatory reason/history.
- Double submission/concurrency: idempotency/version and 409.
- Numeric manipulation: strict decimal grammar/range; no JS float authority.
- CSV injection: existing formula neutralization and bounded audited exports.
- XSS/injection: parameterized SQL and text-node rendering.
- CSRF: retain origin checks and secure HttpOnly cookies.
- DoS: page/filter reports, cap batch size near documented 100-student classes, bound strings, budget average queries.

The full threat model is in `docs/security/M4_THREAT_MODEL.md`.

## Required tests

- Additive/idempotent schema and complete M1→M2→M3→M4 reconstruction.
- Cross-tenant composite references for period/assignment/student/enrollment/result/export.
- Assessment status/date/max/coefficient validation.
- Result status/score invariants, duplicates, inactive assignment, non-enrollment.
- Owner/director/assigned teacher allowed; unassigned teacher/accountant/other tenant denied.
- Batch atomicity and 100-row behavior.
- Stale assessment/result version returns 409; two-user conflict.
- Correction/event/audit immutability.
- Exact 14.67/13.95 calculations, all absence/missing/cancelled policies, no premature rounding.
- Secured/formula-safe/bounded/audited CSV.
- Non-regression for auth, finance, classes, timetable, attendance, justifications, reports.
- Browser E2E at 1440, 1024, 768, 390, and 375 px; no global mobile overflow.
- Keyboard-only grade entry, labels, visible focus, semantic status text, error association, accessible tables/cards, and adequate touch targets.
- Observability: structured action/outcome/latency/counts only; no grade bodies, credentials, or secrets.

## Acceptance and rollback gates

Before human review: approved pre-audit, migration replay, all legacy/new tests, lint/type/build, tenant/RBAC/concurrency/history/CSV proof, secret/npm/OSV/SAST gates, isolated Preview database, responsive/accessibility checks, and clean runtime logs. Production remains unchanged until a separate explicit approval.

## Required human decisions

1. Resolve whether the existing M4 commits/Preview may be retained for review or must be replaced from the immutable M3 baseline.
2. Approve the effective subject-coefficient model.
3. Approve grading defaults and absence/missing policies.
4. Approve the exact Node/npm/Argon2 install-script policy.
5. Approve remediation of the Argon2 input/DoS finding before M4 resumes.
6. Approve any migration/backfill and later Preview, PR readiness, merge, and production steps separately.
