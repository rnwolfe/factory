---
id: task-009
title: Wire clipboard paste into the xterm pane
status: done
priority: med
estimate: small
created: 2026-05-24T00:56:23.174Z
updated: 2026-05-24T16:21:00.000Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] Cmd/Ctrl+V (and the browser/OS paste gesture on mobile) injects the clipboard contents into the active /ws/pane stream as the bytes tmux expects, including bracketed-paste markers when the pane has bracketed-paste mode enabled.
- [ ] Pasting multi-line text into neovim insert mode produces the literal text without auto-indent cascades or interpretation as a sequence of commands.

## Notes

Emitted by feature plan i2euwguf: "feedback: Using neovim via the xterm interface was far from optimal. C"

