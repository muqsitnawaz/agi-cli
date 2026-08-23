---
type: breaking
---

`agents browser` no longer asks the caller which machine a profile lives on. The daemon reads the device-declaration registry: a name this machine declares connects locally; a name only other machines declare is tunnelled to a reachable declaring device (and the command output names which one); a name nobody declares fails loudly, listing similar names, and never auto-creates a logged-out local browser. Identity-bearing profiles share one connection (no Electron fork, no second chrome-data). Runtime keys are `<profile>@<device>` instead of `<profile>@endpoint-N`; leftover `@endpoint-N` dirs are renamed onto the new key.
