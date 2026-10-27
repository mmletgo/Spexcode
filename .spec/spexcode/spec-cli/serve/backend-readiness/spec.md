---
title: backend-readiness
hue: 205
desc: The supervisor gives a cold backend a roughly 60-second refusal-retry window and advances each health probe only once.
code:
  - spec-cli/src/supervisor-readiness.ts
related:
  - spec-cli/src/supervisor-readiness.test.ts
  - spec-cli/src/supervise.ts
---

# backend-readiness

The supervisor selects a backend only after its loopback `GET /health` probe returns 200. A cold backend can
take longer than an ordinary restart to begin accepting connections, so the health gate retains a roughly
60-second retry window for immediate connection refusals (600 attempts, spaced 100ms apart) before the
candidate is discarded. A probe timeout destroys that request; its resulting error is the single path that
advances the retry loop, so one timed-out probe cannot queue two later attempts.
