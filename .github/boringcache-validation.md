# host-rust-core prospect validation

## Verdict

Keep this repository on the watchlist. Do not contact the maintainers from this
evidence.

BoringCache recorded lower compiler-cache read time than GitHub's sccache
backend once both caches were populated. Across the five rolling commits,
BoringCache recorded 28.96 seconds of aggregate cache-hit read time versus
798.84 seconds for GitHub. The BoringCache workloads totaled 29m01s versus
30m05s for GitHub, a 3.5% reduction.

That cache advantage did not improve whole-job time. The five BoringCache jobs
totaled 41m03s versus 33m51s for GitHub, so BoringCache was 7m12s, or 21.3%,
slower. The BoringCache proxy took 434.9 seconds in total to become ready across
those five runs. Its individual readiness waits were 81.8, 167.5, 81.9, 90.3,
and 13.4 seconds. The 81.9-second median startup delay consumes most of the
cache-path benefit.

The upstream pain report is also stale. The current iOS workflow builds the Rust
core once and shares the artifact with the downstream application jobs. The
original claim that three jobs rebuild the core independently no longer
describes the repository. Four commits in this rolling window change workflows
or documentation. The fifth changes Rust CLI and JavaScript code, but it does
not enter the measured iOS build graph: both providers retained all 1,287
cacheable compilations. This series therefore does not satisfy the requirement
for several build-relevant changed revisions.

## Upstream pain review

[Issue #875](https://github.com/paritytech/host-rust-core/issues/875) estimates
108,500 adjusted paid runner minutes per week. Do not use that estimate for
prospecting. It assumes three independent Rust core builds, but
[commit `13aa9e44`](https://github.com/paritytech/host-rust-core/commit/13aa9e44559393229e83cab089c783a8ae7f795b)
changed the workflow to build the core once and share its artifact with three
application jobs. [Commit `6882a2a2`](https://github.com/paritytech/host-rust-core/commit/6882a2a23330ebc2b465e0155a51012126f46101)
also added main-branch warming for Swift package dependencies.

A current upstream
[iOS run](https://github.com/paritytech/host-rust-core/actions/runs/35535596861)
shows the remaining shape: one 3m38s core bootstrap on `macos-26-xlarge`, then
downstream jobs lasting 4m58s, 6m00s, and 9m32s. BoringCache can address repeated
core compilation across revisions; it does not remove the three downstream
application jobs. Issue #875 was opened by an automated audit account and had
no maintainer comment when this validation ran, so it provides weak human pain
evidence.

## Method

- Fork: [boringcache/host-rust-core](https://github.com/boringcache/host-rust-core/tree/boringcache-validation)
- Branch: `boringcache-validation`
- Runner: standard `macos-26`, Apple M1 virtual hardware
- Toolchain: Xcode 26.4.1, sccache 0.17.0, the repository's stable and nightly
  Rust setup, and BoringCache One v1.31.0
- GitHub provider: sccache's GitHub Actions cache backend
- BoringCache provider: One in `sccache` mode with strict cache-error handling
- Workload: the upstream iOS core bootstrap stages: `npm ci`, code generation,
  host XCFramework rebuild, provider Swift bindings, and binding sync
- Source control: each run verifies that the checked-out source matches its
  recorded upstream commit outside the validation harness
- Output check: the expected XCFramework, FFI headers, and provider source
  directories must exist. This validation does not compare byte-level output
  hashes between providers.

The paid `macos-26-xlarge` runner used upstream could not start in this fork
because GitHub rejected the job for an account billing or spending-limit issue.
The measurements therefore use `macos-26`. They test cache behavior on the same
source and workload, but they are not an exact production-runner timing claim.

## Measurements

Job time includes checkout, environment setup, cache setup, workload, artifact
upload, and cleanup. Workload time covers only the five build stages above.

| Phase | Upstream source | Change relevance | GitHub job | BoringCache job | GitHub workload | BoringCache workload | GitHub hits/misses | BoringCache hits/misses | BoringCache proxy ready |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | `94a913de` | Initial population | 12m15s | 10m02s | 649s | 527s | 2 / 1,285 | 2 / 1,285 | 0.6s |
| Warm | `94a913de` | Same source | 4m51s | 8m57s | 256s | 362s | 1,112 / 175 | 1,220 / 67 | 120.5s |
| Change 1 | `706fa1d5` | iOS device-registration workflow | 6m38s | 9m23s | 357s | 412s | 1,112 / 175 | 1,220 / 67 | 81.8s |
| Change 2 | `5b647fda` | Pinned iOS action references | 6m17s | 8m35s | 337s | 302s | 1,287 / 0 | 1,287 / 0 | 167.5s |
| Change 3 | `4c8bb6b4` | Android workflows and README | 7m03s | 7m03s | 374s | 280s | 1,287 / 0 | 1,287 / 0 | 81.9s |
| Change 4 | `5e298322` | Workflow secrets and iOS install action | 6m23s | 8m27s | 337s | 364s | 1,287 / 0 | 1,287 / 0 | 90.3s |
| Change 5 | `303b1633` | CLI Rust, JavaScript, and build scripts | 7m30s | 7m35s | 400s | 383s | 1,287 / 0 | 1,287 / 0 | 13.4s |

The median rolling job was 6m38s for GitHub and 8m27s for BoringCache. For the
four full-hit changes, BoringCache reduced measured workload time from 24m08s to
22m09s, or 8.2%, while whole-job time increased from 27m13s to 31m40s, or 16.4%.

| Phase | GitHub aggregate cache-hit read time | BoringCache aggregate cache-hit read time |
| --- | ---: | ---: |
| Warm | 59.53s | 5.21s |
| Change 1 | 66.82s | 5.51s |
| Change 2 | 302.13s | 5.92s |
| Change 3 | 176.39s | 5.44s |
| Change 4 | 72.58s | 5.62s |
| Change 5 | 180.93s | 6.47s |

sccache reports aggregate cache-operation duration across compiler requests.
These values are not wall-clock job time because requests can overlap.

## Public evidence

- [Cold and warm comparison](https://github.com/boringcache/host-rust-core/actions/runs/35676213557)
- [Rolling change 1](https://github.com/boringcache/host-rust-core/actions/runs/35677745680)
- [Rolling change 2](https://github.com/boringcache/host-rust-core/actions/runs/35678511893)
- [Rolling change 3](https://github.com/boringcache/host-rust-core/actions/runs/35679154263)
- [Rolling change 4](https://github.com/boringcache/host-rust-core/actions/runs/35679702661)
- [Rolling change 5](https://github.com/boringcache/host-rust-core/actions/runs/35680338088)
- [Excluded paid-runner attempt](https://github.com/boringcache/host-rust-core/actions/runs/35675980543)

## Required follow-up before outreach

1. Diagnose and reduce the BoringCache proxy readiness delay.
2. Repeat at least three commits that change the iOS host crate or its
   dependencies.
3. Use `macos-26-xlarge` if the fork's paid-runner billing becomes available.
4. Add provider-independent output hashes or another direct fidelity check.

No pull request, issue comment, or maintainer outreach was created.
