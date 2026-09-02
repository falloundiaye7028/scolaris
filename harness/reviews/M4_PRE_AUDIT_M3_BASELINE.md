# M4 pre-audit — immutable M3 baseline

Date: 2026-09-01 (Africa/Dakar)

## Authorized references

- Repository: `falloundiaye7028/scolaris`
- Production branch: `main`
- Immutable M3 baseline: `1e1a4365beed07ba422193f3767f05e65674a03a`
- M2 application rollback: `139dc3b0fc80db67a9e3c7a9095ec430f123cbd6`
- Production state: not modified by this pre-audit.

Both commits exist locally. `origin/main`, local `main`, and the authorized M3 reference resolve to the same commit. The isolated audit checkout was detached at M3; the production commit was not rewritten.

## Repository state and divergence

The initial repository state observed for this pre-audit was:

- path: `<repository-root>`;
- branch: `codex/m4-grades-assessments`;
- HEAD: `4377b7e0e97b6bebff8a35cee7805a356f65d3b6`;
- working tree: clean before these audit documents were created;
- remote: `origin` points to `https://github.com/falloundiaye7028/scolaris.git`.

This is a material gate divergence: two M4 implementation commits already exist on the branch (`4c79adb`, `4377b7e`) and a Preview had already been created before the current pre-audit instruction. They are preserved, not amended, merged, deployed to production, or treated as authorized. The audit itself was executed against isolated checkouts of the exact M3 and M2 references.

Applicable repository documents read: `README.md`, `docs/M0_AUDIT.md`, `docs/M2_TIMETABLE.md`, `docs/M3_ATTENDANCE.md`, `docs/DEPLOYMENT_CHECKLIST.md`, `docs/OPERATIONS_SECURITY.md`, and `docs/SECURITY_MIGRATION.md`. No applicable `AGENTS.md`, `SECURITY.md`, `ARCHITECTURE.md`, or `PLANS.md` exists in the repository baseline.

## M3 migrations and expected schema

M3 is additive over M2. `api/src/migrate.js` applies `attendance-schema.sql`, which adds:

- `academic_periods`;
- `attendance_justification_documents`;
- `attendance_records`;
- `attendance_record_events`;
- `attendance_domain_events`;
- tenant-scoped unique keys and indexes;
- composite foreign keys binding school, year, session, student, enrollment, document, and user;
- `validate_m3_attendance_reference()` and its validation triggers.

No M2 table or column is dropped by M3. The expected pre-M4 academic graph is:

`schools → academic_years → classes/enrollments → teaching_assignments → lesson_sessions → attendance_records`, with `academic_periods` tied to the same school and year.

## M3 delivered capabilities

- Attendance call by class/session.
- Present, absent, late, and excused states.
- Batch marking and “all present”.
- Optimistic concurrency with version checks and HTTP 409.
- Private PDF/JPEG/PNG justification documents, maximum 2 MiB.
- Event/history records and domain events.
- Student/class attendance reports and secured CSV export.
- Server-side RBAC and teacher-assignment checks.
- PostgreSQL and service-level tenant isolation.
- Responsive/private UI integration without exposing attendance data publicly.

## M3 tests and local baseline proof

On the detached M3 checkout, `npm run build` completed with lint and type checks green and 64 tests: 63 passed, 1 skipped, 0 failed. The skipped test is the database integration suite unless an isolated `TEST_DATABASE_URL` is supplied. The M2 rollback checkout also built successfully with 61 tests: 60 passed, 1 skipped, 0 failed. The separate local PostgreSQL rollback exercise is documented in `docs/operations/M3_TO_M2_ROLLBACK_ANALYSIS.md`.

## Required configuration names

Only names were inspected; no value was printed. Relevant M3 names are:

- core: `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`, `PORT`, `ALLOWED_ORIGINS`;
- MFA/auth: `MFA_ENCRYPTION_KEY`, `MFA_ENFORCEMENT`, `MFA_ISSUER`, password-reset webhook URL/secret;
- registration/email: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, school-registration and school-notification webhook URL/secrets;
- security/operations: `CRON_SECRET`, security-alert webhook URL/secret, `BOOTSTRAP_SECRET`;
- platform: `SCOLARIS_MONTHLY_PRICE_XOF`, `SCOLARIS_GRACE_PERIOD_DAYS`;
- tests/deployment: `TEST_DATABASE_URL`, `VERCEL`, `VERCEL_ENV`.

No remote environment value was read or changed. M4, as documented, should not require a new secret merely to store grades.

## Critical dependencies and known limitations

- Node runtime observed locally: `v24.15.0`; CI requests floating major `24`, not an exact patch.
- npm observed locally: `11.12.1`; the repository does not pin npm exactly.
- PostgreSQL: CI uses floating `postgres:16`.
- Direct native dependency: `argon2@0.45.1` with an install lifecycle script.
- Authentication uses Argon2id and supports progressive bcrypt migration.
- The API JSON body ceiling is 4.5 MB for attendance Base64 documents. Login password verification is not separately bounded before Argon2; this creates a resource-abuse concern.
- GitHub Actions use floating major tags rather than full immutable SHAs.
- Operational backup restore, RPO, and RTO have not been demonstrated.
- A Gitleaks scan reports two current-tree matches and four historical matches; analysis identifies repeated placeholder/test fixtures, but a human security owner must formally accept or suppress them without hiding future real leaks.

## Debt transferred to the M4 gate

1. Pin Node and npm exactly before relying on npm install-script policy.
2. Review and human-approve a version-pinned `allowScripts` entry, or reject it; do not approve all scripts.
3. Bound login/reauthentication password input before any Argon2/bcrypt work and add concurrency/load limits.
4. Pin GitHub Actions and PostgreSQL service images by immutable references where practical.
5. Add OSV/Gitleaks/SBOM gates to CI and document false-positive handling.
6. Prove backup restoration before calling application rollback fully READY.
7. Reconcile the pre-existing M4 commits/Preview with the human authorization gate before any further M4 work.

## Baseline decision

The immutable M3 code baseline is confirmed and healthy locally. The overall M4 pre-audit is not PASS because authorization-order and security/reproducibility blockers remain. No business implementation is authorized by this document.
