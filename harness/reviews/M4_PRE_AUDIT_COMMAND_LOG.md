# M4 pre-audit command log

This log records the material verification commands used for the gate. No command printed a secret value. Exploratory read-only file searches are summarized by their source paths; the security conclusions rely on the commands below and the referenced generated evidence.

| Exact command | Working directory | Exit | Actual summary | Proof |
|---|---|---:|---|---|
| `git status --short --untracked-files=all` | `<repository-root>` | 0 | Initially empty/clean | Git state; this file and four requested reports are later additions |
| `git branch --show-current` | same | 0 | `codex/m4-grades-assessments` | Git state |
| `git remote -v` | same | 0 | origin is `falloundiaye7028/scolaris` | local Git config; values contain no credential |
| `git log --oneline --decorate -15` | same | 0 | HEAD `4377b7e`; M4 commits exist above M3 | Git history |
| `git show --stat 1e1a4365beed07ba422193f3767f05e65674a03a` | same | 0 | M3 squash exists | Git object database |
| `git show --stat 139dc3b0fc80db67a9e3c7a9095ec430f123cbd6` | same | 0 | M2 rollback exists | Git object database |
| `npm run build` | `<isolated-audit-worktree>/repo` | 0 | M3 lint/typecheck green; 64 tests, 63 pass, 1 skip | `package.json`, test output, `M4_PRE_AUDIT_M3_BASELINE.md` |
| `npm ci --prefix api` | `<isolated-audit-worktree>/rollback` | 0 | Frozen M2 install completed | lockfile and rollback analysis |
| `npm run build` | `<isolated-audit-worktree>/rollback` | 0 | M2 lint/typecheck green; 61 tests, 60 pass, 1 skip | `docs/operations/M3_TO_M2_ROLLBACK_ANALYSIS.md` |
| M3 `npm --prefix api run migrate`, then M2 `npm --prefix api run migrate` against the same local PostgreSQL 16 database | isolated temp checkouts | 0 / 0 | M3 schema created; M2 migrator tolerated retained M3 objects | rollback analysis; no remote database used |
| `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4304/api/health` | isolated M2 API | 0 | HTTP 200 with M2 app on M3 schema | rollback analysis |
| `npm ci --ignore-scripts` | `<isolated-audit-worktree>/argon-blocked` | 0 | 62 packages installed; lifecycle scripts blocked | Argon audit |
| `node -e "require('argon2')"` | same | 1 | no native Darwin x64 build found | Argon audit |
| `npm ci --foreground-scripts` | `<isolated-audit-worktree>/argon-allowed` | 0 | Argon2 compiled bundled source on Darwin x64 | Argon audit |
| `node --test test/auth-security.test.js` | same | 0 | 6/6 Argon/auth tests pass | Argon audit |
| `docker run --rm -v <isolated-audit-worktree>/argon-blocked:/work:ro -w /work node:24.15.0-bookworm-slim node -e "<Argon2 functional probe>"` | M3 audit checkout | 0 | bundled Linux x64 prebuild works with scripts-blocked tree | image digest `sha256:4e6b70d...`; Argon audit |
| `npx --yes npm@11.19.1 ci --foreground-scripts` | `<isolated-audit-worktree>/argon-explicit-npm11191` | 0 | exact version-pinned Argon allow proposal installed | Argon audit |
| `npm install-scripts ls --json` | same | 0 | no unreviewed lifecycle scripts | Argon audit |
| `node --test test/auth-security.test.js` | same | 0 | 6/6 focused tests pass | Argon audit |
| `npm audit --prefix api --audit-level=high --json` | M3 audit checkout | 0 | 0 vulnerabilities, 62 dependencies | Argon audit |
| `docker run --rm -v <isolated-audit-worktree>/repo:/src:ro ghcr.io/google/osv-scanner:v2.5.0 scan source --recursive /src` | M3 audit checkout | 0 | 61 packages scanned; no issues | OSV image digest `sha256:5b8b38e...`; Argon audit |
| `npm run security:secrets` | M3 audit checkout | 0 | no high-confidence secret in tracked files | repository scanner output |
| `npm run security:history` | M3 audit checkout | 0 | no high-confidence secret in history | repository scanner output |
| `docker run --rm -v <repository-root>:/repo:ro -w /repo ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb git --no-banner --redact --exit-code 1` | M3 audit checkout | 1 | 99 commits; 4 redacted matches | `<temporary-evidence>/gitleaks-history-redacted.json` |
| same pinned image with `dir --no-banner --redact=100 --exit-code 1 .` | M3 audit checkout | 1 | 2 current-tree redacted matches | Argon audit disposition |
| `npm sbom --prefix api --sbom-format cyclonedx` | M3 audit checkout | 0 | CycloneDX 1.5, 61 components | `<temporary-evidence>/m3-api-sbom.cdx.json` |
| `npm view argon2@0.45.1 time repository maintainers engines scripts dist --json` | M3 audit checkout | 0 | upstream, scripts, integrity, signature, SLSA provenance inspected | `M4_ARGON2_SUPPLY_CHAIN_AUDIT.md`; no secret |

One isolated `npm run build` inside an API-only copied fixture exited 1 because repository-level web/vercel test files were intentionally absent. This is not a product failure: the full detached M3 repository build passed, and the focused Argon tests in that fixture passed. The failed fixture command is retained here to avoid concealing contrary evidence.

Remote state-changing command count: zero. Deployment command count: zero. Migration commands against remote databases: zero.
