- **Release: the home-base build worktree gets `bin/embedded.provisionprofile`.** The
  privileged phase builds from a fresh detached worktree of the tag, but
  `apps/cli/bin/` is gitignored, so the keychain-helper's provisioning profile was
  absent and the signed helper build failed with `Missing … embedded.provisionprofile`.
  `release.sh` now copies the profile from the home base's own checkout into the
  worktree before building, so a headless release completes end to end. Source:
  `apps/cli/scripts/release.sh`.
