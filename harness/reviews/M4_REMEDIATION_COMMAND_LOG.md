# M4.0 remediation command log

Date: 2026-09-01 (Africa/Dakar). `<repository-root>` is the SCOLARIS PAY checkout. `<exact-toolchain-path>` is the isolated Node 24.20.0/npm 11.19.1 PATH. Database URLs below are intentionally represented as `<local-test-database-url>` so no credential-bearing URL is versioned. Every database was local, disposable and synthetic.

## Material successful gates

| Exact command (secret-safe representation) | Directory | Exit | Actual result / proof |
|---|---|---:|---|
| `git status --short --untracked-files=all` | `<repository-root>` | 0 | Initial branch clean except the six untracked pre-audit reports; remediation changes then inspected separately. |
| `git branch --show-current` | `<repository-root>` | 0 | `codex/m4-grades-assessments`. |
| `git rev-parse HEAD` | `<repository-root>` | 0 | `4377b7e0e97b6bebff8a35cee7805a356f65d3b6`. |
| `git rev-parse origin/codex/m4-grades-assessments` | `<repository-root>` | 0 | Same candidate head. |
| `git merge-base HEAD 1e1a4365beed07ba422193f3767f05e65674a03a` | `<repository-root>` | 0 | Exact M3 reference. |
| `npm ci --prefix api` with `<exact-toolchain-path>` | `<repository-root>` | 0 | 62 packages; exact toolchain guard passed; no unknown lifecycle approval. |
| `npm approve-scripts --allow-scripts-pending` with `<exact-toolchain-path>` | `<repository-root>/api` | 0 | `No packages with unreviewed install scripts.` |
| `npm run build` with `<exact-toolchain-path>` | `<repository-root>` | 0 | toolchain/lifecycle/lint/typecheck green; 80 tests, 79 pass, 1 DB-only skip, 0 fail. |
| `TEST_DATABASE_URL=<local-test-database-url> npm --prefix api test` with `<exact-toolchain-path>` | `<repository-root>` | 0 | 80 tests, 80 pass, 0 fail/skip; includes auth, anti-DoS, history, tenant, permission and CSV tests. |
| `DATABASE_URL=<local-test-database-url> npm --prefix api run migrate` executed twice | `<repository-root>` | 0 / 0 | Empty database migrated and replayed successfully. |
| M3 `DATABASE_URL=<local-test-database-url> npm --prefix api run migrate`, then current migration twice | isolated exact M3 checkout, then `<repository-root>` | 0 / 0 / 0 | Exact M3 schema reconstructed; M4.0 migrated and replayed. |
| M3 `npm --prefix api start`, then `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4314/api/health` | isolated exact M3 checkout | 0 / 0 | M3 application on retained M4.0 schema returned HTTP 200; process then stopped intentionally (SIGINT 130). |
| `npm run security:secrets && npm run security:history` with `<exact-toolchain-path>` | `<repository-root>` | 0 | Both internal scans clean. |
| digest-pinned Gitleaks `dir --no-banner --redact=100 --exit-code 1 .` | `<repository-root>` | 0 | Working tree: no leaks found. |
| digest-pinned Gitleaks `git --no-banner --redact=100 --exit-code 1` | `<repository-root>` | 0 | 99 commits scanned; no leaks found after exact fingerprint disposition. |
| digest-pinned Gitleaks against `/private/tmp/scolaris-m40-gitleaks-canary.env` | `<repository-root>` | 1 (expected) | One synthetic leak detected; value never displayed. |
| digest-pinned OSV-Scanner `scan source --recursive /src` | `<repository-root>` mounted read-only | 0 | 61 packages; no issues found. |
| `npm audit --prefix api --audit-level=high` with `<exact-toolchain-path>` | `<repository-root>` | 0 | 0 vulnerabilities. |
| `npm sbom --prefix api --sbom-format cyclonedx` | `<repository-root>` | 0 | `/private/tmp/m4-api-sbom.cdx.json`; CycloneDX 1.5, 61 components. |
| `npm query '*' --prefix api` plus license-policy summary | `<repository-root>` | 0 | 62 dependency records; 0 forbidden and 0 missing dependency licenses. |
| `PREVIEW_URL=<branch-preview> node /private/tmp/scolaris-preview-benchmark.mjs` | `<repository-root>` | 0 | 22 synthetic nonexistent-account operations; p50 122.11 ms, p95 247.77 ms, p99 292.23 ms; 0 errors/timeouts. See `M4_ARGON2_PREVIEW_BENCHMARK.md`. |
| Browser responsive checks at 1440, 1024, 768, 390 and 375 px | existing branch Preview | 0 | Public connection page had no horizontal overflow; visible focus outline; screenshots inspected. Private M4 states were not accessed because no approved fictitious Preview account exists. |

## Initial failures retained

These are not concealed and were followed only by materially justified corrections:

| Command / attempt | Exit | Actual cause and disposition |
|---|---:|---|
| First strict `npm ci --prefix api` | 1 | Sandbox denied native build/cache access (`EPERM`); the same frozen install succeeded with approved local execution. |
| First lifecycle verification | 1 | The repository root package’s own `preinstall` was incorrectly counted as a dependency lifecycle script; the verifier was narrowed to `node_modules/*`, then passed and still rejects a synthetic unknown dependency script. |
| First local migration connection | 1 | Sandbox denied loopback PostgreSQL (`EPERM`); approved local-only execution passed. |
| First attempt to express Gitleaks fingerprints in `.gitleaks.toml` | 1 | Gitleaks v8.30.1 does not accept a `fingerprint` TOML key; canonical exact entries were moved to `.gitleaksignore`, then working/history scans passed. |
| First `npm query '.license' --prefix api` | 1 | Invalid npm query selector (`EQUERYNODEPTYPE`); corrected to `npm query '*' --prefix api`. |
| First final `npm audit --prefix api --audit-level=high` | 1 | Sandbox DNS restriction (`ENOTFOUND registry.npmjs.org`); approved registry access returned 0 vulnerabilities. |
| First final DB integration run | 1 | Sandbox denied loopback (`EPERM`); rerun outside sandbox reached PostgreSQL. |
| Second final DB integration run | 1 | Incorrect synthetic local role name caused PostgreSQL `28P01`; the disposable local role was corrected, and the third run passed 80/80. |
| Direct Vercel CLI availability check | 127 | `vercel` CLI is not installed; no manual deployment was created. The existing branch Preview was used for the required non-production benchmark. |
| Browser attempt to open `/app` unauthenticated | blocked by client | No retry or credential use; private visual state remains a declared evidence blocker. |

## Remote mutation inventory

- Production deployments: zero.
- Preview promotions or aliases: zero.
- Remote database migrations: zero.
- Production environment changes: zero.
- Pushes, commits, PR readiness changes, merges or force-pushes during this log: zero.
