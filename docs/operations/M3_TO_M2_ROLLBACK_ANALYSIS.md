# M3 to M2 rollback analysis

## Classification

`CONDITIONALLY_READY`

Application rollback is locally proven against the retained M3 database schema. Database rollback is not authorized or considered safe.

## References and isolated proof

- M3: `1e1a4365beed07ba422193f3767f05e65674a03a`
- M2: `139dc3b0fc80db67a9e3c7a9095ec430f123cbd6`
- isolated M3 checkout: `<isolated-audit-worktree>/repo`
- isolated M2 checkout: `<isolated-audit-worktree>/rollback`

Both commits could be checked out in independent local clones. M2 installed and built successfully: 61 tests, 60 passed, 1 skipped, 0 failed. A local PostgreSQL 16 instance was migrated to M3, then the M2 migration runner was executed against that already-M3 schema. It completed successfully. The M2 API then started against the M3 schema and returned HTTP 200 on `/api/health`.

No production service, database, environment, branch, or deployment was modified.

## Schema compatibility

M3 adds only attendance-related structures over M2:

- `academic_periods`;
- `attendance_justification_documents`;
- `attendance_records`;
- `attendance_record_events`;
- `attendance_domain_events`;
- related indexes, composite foreign keys, function, and triggers.

M2 does not reference these objects and can operate while they remain present. Authentication, sessions, academic M1 objects, timetable M2 objects, and finance tables retain their M2-compatible shapes.

## Data behavior

An application-only rollback preserves M3 attendance data but makes it temporarily inaccessible to the M2 application. It does not erase it. A database rollback that drops M3 objects would destroy or orphan attendance records, justification binaries, event history, and academic periods. Therefore:

- keep the database at the M3 schema;
- roll back only the application artifact/commit;
- never run ad-hoc `DROP` statements;
- preserve backups and M3 data for roll-forward.

## Recommended application rollback procedure

1. Declare the incident and stop writes only if the failure mode requires it.
2. Record current production deployment ID, commit, database migration state, and time.
3. Verify a recent restorable backup and ownership before proceeding.
4. Promote/redeploy the known M2 artifact from `139dc3b0...`; do not rebuild from an unpinned dependency graph if an immutable artifact is available.
5. Keep the M3 database schema and data unchanged.
6. Verify health, login, tenant isolation, finance, classes, timetable, and session flows.
7. Verify that no M2 endpoint mutates M3-only tables.
8. Monitor HTTP 5xx, SQL errors, authentication failures, and write latency.
9. Roll forward to M3 after the incident is corrected; do not “clean up” M3 tables.

## Environment requirements

M2 requires the same core database/auth/session configuration as M3. M3-only attendance functionality does not introduce a mandatory new runtime secret. Configuration values must be sourced from the existing protected production environment; none should be copied into rollback logs or commands.

## Risk matrix

| Scenario | Assessment | Required control |
|---|---|---|
| M2 application + M3 database | Locally compatible | Retain M3 schema; smoke test core flows |
| M3 application + M2 database | Unsafe | M3 queries require M3 objects; migrate/roll forward first |
| M2 application + destructive DB rollback | Not safe | Prohibited without explicit human approval and restore proof |
| Application rollback with active M3 writes | Possible temporary feature loss | Quiesce attendance writes if consistency is uncertain |
| Session continuity | Schema-compatible | Reauthentication may still be required operationally |
| Backup restore | Not verified | Restore drill required before `READY` |

## Conditions preventing READY

- No production-like backup restoration drill was performed.
- RPO/RTO and responsible operator are not documented with evidence.
- The exact immutable M2 deployment artifact was not promoted in this audit.
- Runtime load and long-duration behavior were not exercised.

Final classification remains `CONDITIONALLY_READY`.
