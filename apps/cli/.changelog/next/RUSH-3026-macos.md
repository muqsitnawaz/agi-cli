- **`promote-home-base-probe.test.ts` no longer ENOENTs the whole file on macOS.**
  The stub-bin helper symlinked `bash` from the Linux-only `/usr/bin/bash`; on
  macOS (where bash lives at `/bin/bash` and `/usr/bin/bash` does not exist) the
  symlink was never created, so `spawnSync(<bin>/bash, …)` returned a null exit
  and `undefinedundefined` output — failing all four probe tests and, because the
  attestation producer runs the full suite, blocking every release cut from a Mac
  home base that isn't the CI image. Each of `bash`/`env`/`sh` now resolves from
  per-OS candidate paths. Test-only.
