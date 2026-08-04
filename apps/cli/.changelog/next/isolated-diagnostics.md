- **`agents inspect` and `view --json` now report isolation honestly.** Found by diffing
  every command's output between an isolated-only and a normal install. `inspect` printed
  the bare-shim path unconditionally, so an isolated copy — which deliberately has no
  shim, that being the guarantee — was shown sitting on the user's PATH; it now reports
  `(none — isolated installs stay off PATH)` and `shim: null` in JSON. `inspect` also
  showed only `default: false` for an isolated copy, hiding that it *was* the selected
  one; it now carries `isolated` and `isolatedDefault`, and the header reads
  `[isolated default]`. `view --json` had no isolation signal at all, so tooling could not
  distinguish a sandboxed copy from one that owns the launcher and real config — its
  version entries gain `isolated` and `isIsolatedDefault`. Source:
  `apps/cli/src/commands/inspect.ts`, `apps/cli/src/commands/view.ts`.
