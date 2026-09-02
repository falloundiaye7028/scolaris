# M4.0 Argon2 Preview benchmark

Date: 2026-09-01 (Africa/Dakar)

## Scope and safety

Target: the existing non-production branch Preview at `https://scolaris-pay-git-codex-m4-grades-assessments-touba-visuel.vercel.app` (candidate Preview; never the production domain).

The probe used only unique, nonexistent `example.test` accounts and a synthetic password. It neither authenticated nor read/wrote school, student or grade data. Expected generic HTTP 401 responses count as completed Argon2/dummy-verification operations. Network errors, timeouts, unexpected statuses and HTTP 5xx count as errors. The run stopped automatically at the first unstable concurrency group.

## Results

| Metric | Result |
|---|---:|
| Operations | 22 |
| Concurrency levels | 1, 2, 5, 10 |
| Overall p50 | 122.11 ms |
| Overall p95 | 247.77 ms |
| Overall p99 | 292.23 ms |
| Errors | 0 |
| Timeouts | 0 |
| Expected generic rejections | 22 × HTTP 401 |
| First request | 292.23 ms |
| Warm p50 after first request | 122.11 ms |
| Maximum observable memory | Not exposed by the public Preview endpoint |

Per-concurrency latency:

| Concurrency | Operations | p50 | p95 | p99 |
|---:|---:|---:|---:|---:|
| 1 | 3 | 224.07 ms | 292.23 ms | 292.23 ms |
| 2 | 4 | 75.75 ms | 227.84 ms | 227.84 ms |
| 5 | 5 | 214.20 ms | 245.46 ms | 245.46 ms |
| 10 | 10 | 83.41 ms | 247.77 ms | 247.77 ms |

The first request was slower than the warm median, which is compatible with—but does not prove—a cold start. No timeout, instability or anomalous response appeared when concurrency increased to 10.

## Limitations and conclusion

This small, controlled run supports the candidate’s basic runtime stability only. It does not expose server memory, cannot prove the remediated code before that code receives its own Preview, and is not evidence of production capacity. Local tests separately verify the M4.0 concurrency limit and timeout behavior. Production readiness must not be inferred from this benchmark alone.

Conclusion: `PREVIEW_BENCHMARK_STABLE_WITH_LIMITATIONS`.
