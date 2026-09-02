# M4 threat model — assessments and grades

## Scope and assets

Protected assets are grade values/statuses, assessment definitions, coefficients/policies, student/enrollment identity, unpublished results, correction history, audit records, exports, authentication material, and tenant boundaries. Trust boundaries are browser→API, API→PostgreSQL, deployment/CI→package registry, teacher→assignment, and tenant→tenant.

Security invariants:

1. Every grade object belongs to exactly one authenticated school.
2. A teacher can act only on an active assignment they own.
3. A result belongs to an enrollment in the assessment's class/year.
4. Draft data is not exposed to future parent/student readers.
5. Published/locked data cannot be silently overwritten.
6. Authoritative arithmetic is decimal-safe and reproducible.
7. History is append-only from application roles.
8. No credential, hash, secret, or complete sensitive payload enters logs.

## Threats and controls

| Threat | Impact | Planned preventive controls | Verification |
|---|---|---|---|
| Cross-school access / IDOR | Critical confidentiality/integrity loss | derive tenant from session; tenant predicates; composite FKs; opaque IDs are not authorization | School A/B negative API + DB tests |
| Role escalation | Unauthorized publication/correction | reuse server RBAC; no client role trust; explicit reopen/lock permissions; privileged MFA/reauth where appropriate | full role matrix |
| Identifier tampering | Grade attached to wrong student/period/assignment | load all referenced rows under tenant/year; derive class/subject/teacher; composite constraints | forged-ID tests |
| Mass assignment | Hidden fields/status/actor/version changed | request DTO allowlist; server-owned actor/timestamps/school; strict JSON/range validation | unexpected-field tests |
| Validation bypass | Invalid scores or dates corrupt averages | PostgreSQL CHECK/trigger + service validation; `NUMERIC`; date inside year and period | boundary/property tests |
| SQL injection | Data disclosure/mutation | parameterized SQL; controlled sort/filter enums | SAST and injection payloads |
| Stored/reflected XSS | Session/data theft | text-node rendering/central escape; CSP; no inline handlers | DOM/XSS browser tests |
| CSRF / Server Action abuse | Unauthorized writes | same-origin checks, secure HttpOnly SameSite cookies, POST/PUT state changes, reauth for sensitive exports/reopen | foreign-origin tests |
| Unauthorized export | Bulk educational-data leak | permission, tenant filter, bounds, pagination, audit, recent reauth as appropriate | cross-tenant/over-limit/export audit tests |
| CSV injection | Spreadsheet code execution | prefix `= + - @`/tab/CR inputs and quote fields | formula fixtures |
| Malicious file upload | Not introduced by M4 | M4 has no upload; do not reuse justification upload path for grades | route inventory |
| Double submission | Duplicate/partial results | unique assessment+student; atomic batch; idempotent/versioned request semantics | repeated batch tests |
| Concurrent edits | Lost grade correction | version predicates, row locks only where needed, HTTP 409, no stale overwrite | two-user test |
| Audit alteration | Hidden misconduct | append-only event rows, restricted API, actor/time/reason, no ordinary delete | authorization/DB tests |
| Time-zone/date error | Assessment placed in wrong period | school-date semantics; ISO dates; server validates period/year; timestamps in UTC | boundary-date tests |
| Retroactive alteration | Official result silently changes | published correction privilege + reason + event; locked reopen separately audited | workflow tests |
| Denial of service | API/database exhaustion | capped 100-row batch, pagination, query indexes, rate limits, timeouts, aggregate budgets | load/EXPLAIN tests |
| Argon2 abuse | Memory/CPU exhaustion on login | explicit password max before verify, account/IP/device limits, concurrency budget | oversized/distributed load tests |
| Secret leakage | Account/system compromise | protected env vars; redacted structured logs; secret scans; no pepper without manager | Gitleaks + log review |
| Compromised dependency | Build/runtime compromise | frozen lock, exact runtime/tool pins, strict versioned lifecycle allowlist, npm audit, OSV, SBOM, provenance | CI supply-chain gate |
| Floating CI action | Workflow takeover risk | pin actions and service images to immutable SHA/digest | workflow policy test |
| Cache/public route leak | Unpublished grades exposed | private routes only; no-store/private; noindex; public HTML contains no grade state | header/public-bundle tests |

## Privacy and logging

Grade/comment payloads are sensitive educational data. Logs may contain action, tenant-safe internal entity ID, status code, duration, result count, and error class. They must not contain scores in bulk, comments, credentials, password/hash/salt, reset/MFA tokens, webhook secrets, or export contents. Audit metadata should store only the minimum previous/new value required for accountability.

## M4.0 remediation status

- Authentication inputs are bounded by UTF-8 bytes and HTTP-body size before Argon2/bcrypt; native concurrency and caller time are bounded.
- Node `24.20.0`, npm `11.19.1`, and `argon2@0.45.1` are exact repository pins.
- The only lifecycle proposal is version-scoped to `argon2@0.45.1`; strict enforcement rejects unknown scripts.
- GitHub Actions and the PostgreSQL 16.15 Bookworm CI image are pinned to immutable SHAs/digest.
- Gitleaks fixtures are limited by exact path/rule/fingerprint entries, and a non-versioned canary is detected.
- Published grading policies, coefficients and calculations use versioned snapshots; correction and workflow histories are append-only for normal application roles.

Human approval of the Argon2 allowlist remains distinct from this technical proposal. Remote CI/CodeQL and authenticated synthetic Preview evidence remain gate conditions.

## Security acceptance gate

M4 security approval requires all critical tenant/RBAC/workflow tests, remediation and load proof for Argon2 abuse, human-approved exact install-script policy, immutable CI pins, clean/accepted secret scans, CodeQL green, isolated authenticated Preview testing, and no production modification. Local M4.0 controls pass; the private Preview gate and remote CI evidence remain pending. Until then: `M4_IMPLEMENTATION_NOT_AUTHORIZED`.
