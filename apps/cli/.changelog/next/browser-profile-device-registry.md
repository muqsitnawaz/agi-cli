---
type: breaking
---

Browser profiles now live only in each declaring machine's `devices/<machine>/agents.yaml`. The fleet registry is the read-time union of those files: a name declared once is identity-bearing, while the same name declared by several devices is fungible. The removed central `browser:` map migrates into the current device file on first read.
