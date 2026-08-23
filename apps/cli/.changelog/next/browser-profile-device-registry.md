---
type: breaking
---

Browser profiles now live only in each declaring machine's `devices/<machine>/agents.yaml`. The fleet registry is the read-time union of those files: a name declared once is identity-bearing, while the same name declared by several devices is fungible. Leftover central `browser:` entries are not claimed on first read — run `agents browser profiles claim` on the machine that hosts the browser. Only profiles that machine can actually launch are moved into its device file; the rest stay central until that machine claims them. A configured default that no device declares is now an error on `agents browser start`, not a silent fallback to a logged-out `auto-chrome`. `profiles prune` only considers profiles this device declares (`--fleet` is gone; deleting a peer's declaration is not possible).
