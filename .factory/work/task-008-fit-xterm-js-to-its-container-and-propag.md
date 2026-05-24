---
id: task-008
title: Fit xterm.js to its container and propagate size to the tmux pane
status: done
priority: med
estimate: medium
created: 2026-05-24T00:56:23.159Z
updated: 2026-05-24T16:21:00.000Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] The xterm.js instance in the live run pane uses a fit addon (or equivalent) and recomputes cols/rows on mount, container resize, and viewport rotation.
- [ ] New cols/rows are transmitted over /ws/pane (or a sibling control channel) and applied to the underlying tmux pane via `tmux resize-pane -t <target> -x <cols> -y <rows>` (or `respawn-pane`/`refresh-client -C` equivalent) so neovim's `$LINES`/`$COLUMNS` match the visible grid.
- [ ] Opening neovim inside a live pane on a desktop browser and on a 390px mobile viewport shows the editor filling the available xterm grid with no clipped status line or stale background.

## Notes

Emitted by feature plan i2euwguf: "feedback: Using neovim via the xterm interface was far from optimal. C"

