---
title: adopted conversation
status: active
hue: 205
desc: The read-only transcript page of an adopted chat, with ordinary resource links on desktop and mobile.
code:
  - spec-dashboard/src/ExternalSessionConversation.jsx
related:
  - .spec/spexcode/spec-dashboard/dashboard-ui/session-console/spec.md
  - .spec/spexcode/spec-cli/sessions/harness-adapter/session-transcript/spec.md
---

# adopted conversation

The desktop and mobile console show the current half-hour of the native conversation with an earlier, later,
and latest control. They render the bounded [[session-transcript]] response with the existing transcript
renderer and the same [[files]] list as the resource picker. A posted path resolves an existing `[[file:…]]`
reference in the open conversation as the board publishes the list. The view has no composer or runtime
actions. A transcript read failure is visible and the resource picker remains available.
