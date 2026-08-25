# Resource architecture

Resources resolve once, then project through a harness-specific adapter. Consumers must
not reimplement precedence or capability checks.

## Flow

1. Discover project, user, extra, and system repositories.
2. Resolve names by layer precedence.
3. Filter through the capability registry for the target harness version.
4. Convert the canonical resource into the harness-native representation.
5. Write only managed paths and record ownership in the sync manifest.
6. Prune previously managed outputs that no longer resolve.

Project resources never leak into global version homes. A declined permission or unsafe
overwrite is an explicit partial outcome, not a clean sync. Malformed shared config is
refused rather than rebuilt because unrelated user-authored state must survive.

Executable plugin surfaces are installed inert and require explicit enablement. A plugin
does not bypass the same capability, consent, or precedence rules as an ordinary
resource.
