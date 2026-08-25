# Automation

The daemon is the sole scheduler for routines, monitors, watchdog passes, and periodic
maintenance. UI clients may request a run or render state; they never own an acting timer.

## Routines

A routine definition says what should run and when. Device activation separately says
where it may run. Each scheduled fire has a unique claim distinct from the active-run
claim. Readiness failures create visible blocked/skipped/missed run records instead of a
fake session.

## Monitors

A monitor observes a source, compares it with durable observed state, and submits an
action through the same execution path as a routine. Semantic identity deduplicates the
watched condition across the fleet; execution placement is not part of that identity.

## Watchdog

The watchdog reads fleet progress, classifies non-progressing unfinished sessions, asks a
real decider for an action, delivers to the exact session, and records confirmation. Hard
account limits may rotate in place, preserving tab and conversation context. Detection is
fleet-wide; delivery remains local to the owning device.
