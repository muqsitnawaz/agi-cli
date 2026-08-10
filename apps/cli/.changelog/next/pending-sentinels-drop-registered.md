### Fixed

- **Menu bar "NEW DEVICES"** no longer lists machines that are already registered or ignored. `reconcilePendingSentinels` now re-subtracts the device registry (not only the ignore-list), and a soft-failed device probe still re-prunes known non-pending sentinels instead of leaving stale phantoms on disk.
