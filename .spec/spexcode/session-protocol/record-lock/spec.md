---
title: record-lock
status: active
hue: 280
desc: Cross-process session mutations share one filesystem record fence with bounded waits and dead-owner reclamation.
code:
  - spec-cli/src/session-record-lock.ts
related:
  - spec-cli/src/sessions.ts
  - spec-cli/src/session-record.ts
  - spec-cli/src/session-lock.test.ts
---
# record-lock

The canonical project runtime tier holds one filesystem lock per session id outside the session directory,
so close may remove the record while still fencing stale writers. A claimant prepares a private directory
with one complete PID-and-unique-nonce owner file, then atomically renames that nonempty directory into the
lock path. Async acquisition honors cancellation and bounds waits; synchronous lifecycle writers use the
same publication mechanism. The nonblocking synchronous form refuses an existing lock without waiting or
reclaiming it, for product input paths that must refuse behind an in-process transition.

Only an ESRCH process probe proves an owner dead; permission errors, malformed owners, symlinks and other
unknown states remain fenced. Reclaim and release unlink only the captured nonce file, and only its successful
unlinker attempts to remove the now-empty directory. A replacement owner is always nonempty, so an old
reclaimer or release cannot remove it. Empty directories left by a crash are safely replaceable; private
unpublished claims never arbitrate ownership. A live legacy PID file remains fenced, while an ESRCH-proven
dead legacy file can be unlinked without deleting a new directory owner. Concurrent old binaries retain
their old file-lock protocol and must be stopped before relying on the new ownership guarantee.

Git worktree registry operations reuse this same filesystem acquisition mechanism. Their fence lives in the
physical, realpath-resolved Git common directory, so different session ids, linked checkouts, path aliases,
and SpexCode homes share it; unrelated repositories do not. Registry acquisition retains the same bounded wait,
cancellation, exception-safe release, and dead-owner recovery. The lock order is session id, exact candidate
resource pair when needed, then registry. A registry callback never reacquires its own fence.
