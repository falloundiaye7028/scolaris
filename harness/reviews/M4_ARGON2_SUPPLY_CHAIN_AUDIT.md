# M4.0 Argon2 and software supply-chain audit

## Mandatory conclusion

`ARGON2_ALLOWLIST_APPROVED_FOR_PROPOSAL`

This is a Codex technical proposal, not final human approval. The exact approved candidate is `argon2@0.45.1`; a future package version requires a new review.

## Immutable dependency evidence

- Runtime: Node.js `24.20.0`; package manager: npm `11.19.1`.
- Direct dependency and allowlist key: `argon2@0.45.1`.
- Registry tarball: `https://registry.npmjs.org/argon2/-/argon2-0.45.1.tgz`.
- Lockfile integrity: `sha512-skm+/WCjkGqCQxF7FG1LuZXM5yvbFjgbfiCGsud2oLgaDhh6b6dbH0b1EkghbM+xx4Bj8Ape+KKgixoIlWZicQ==`.
- Lifecycle command: `cross-env ZERO_AR_DATE=1 node-gyp-build`.
- The lockfile contains no floating Argon2 version and marks this exact package as the only dependency with an install script.
- `.npmrc` enables `strict-allow-scripts=true` and disables `dangerously-allow-all-scripts`.
- `npm approve-scripts --allow-scripts-pending` reports no unreviewed package.

The npm artifact includes its C/C++ source and N-API prebuilds. Included targets are Darwin arm64; FreeBSD arm64/x64; Linux arm/arm64/x64 glibc and musl; and Windows x64. Darwin x64 is not prebuilt, so the audited Intel macOS host compiled the bundled source through `node-gyp-build`. Linux x64, including GitHub Actions and Vercel's Linux runtime, loads the included N-API prebuild. Inspection of the installed package scripts and sources found no secondary download command: the only network artifact is the integrity-checked npm tarball.

The npm registry advertises a package signature and SLSA provenance for the artifact. Those attestations supplement, but do not replace, the committed lock integrity and frozen-install controls.

## Password-hashing policy

The single versioned policy constant is:

- variant `argon2id`;
- Argon2 version `19`;
- memory cost `19,456 KiB`;
- time cost `2`;
- parallelism `1`;
- hash length `32` bytes;
- policy version `1`.

`needsRehash` is evaluated only after successful verification. Valid legacy bcrypt credentials migrate progressively to Argon2id. Invalid bcrypt credentials do not migrate. A native Argon2 error never falls back to bcrypt and returns only a generic external authentication failure. No pepper is present or proposed.

## Anti-denial-of-service controls

Before native verification, passwords are measured as UTF-8 and values above 256 bytes are rejected without truncation. Authentication bodies are capped at 2,048 bytes. Existing persistent limits cover account, address/origin and device. Native work is bounded to four concurrent operations per process and to a five-second caller timeout. The native promise retains its slot until it settles, including after a caller timeout, so a slow native operation cannot free capacity dishonestly. Metrics expose counts only and never passwords, hashes or salts.

Tests cover valid/invalid verification, malformed hashes, native errors, log redaction, `needsRehash`, valid and invalid bcrypt migration, no fallback after Argon2 failure, 255/256/257 UTF-8 bytes, multibyte Unicode, historical bcrypt-length inputs, oversized HTTP bodies, rate limiting, concurrency rejection and timeout.

## Supply-chain gates

- Frozen install under exact Node/npm and strict lifecycle policy: pass.
- Lifecycle policy unit tests, including a synthetic unknown script: pass.
- npm audit high: no vulnerabilities.
- OSV-Scanner: no issue.
- CycloneDX 1.5 SBOM: 61 dependency components.
- Dependency license review: no GPL, AGPL or SSPL; the only missing license field is the private application root.
- Gitleaks: exact current/historical fixture fingerprints documented in `.gitleaksignore`; working tree and history clean after disposition; non-versioned canary detected.
- GitHub Actions: third-party actions pinned to full official SHAs.
- PostgreSQL CI: exact 16.15 Bookworm image and digest.

## Platform behavior and residual approval

Darwin x64 needs local compilation from bundled source. Linux x64 uses the bundled prebuild and does not need a secondary download. Frozen installation and functional tests pass under the exact candidate toolchain. A controlled Preview benchmark is recorded separately in `harness/reviews/M4_ARGON2_PREVIEW_BENCHMARK.md`; it is supporting evidence only and cannot by itself establish production readiness.

The version-pinned allowlist is technically supportable. Human security approval remains required before the Draft PR can be made Ready, merged or deployed.
