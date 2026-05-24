---
id: task-002
title: Build mobile-first /metrics route with cost-over-time charts
status: ready
priority: med
estimate: medium
created: 2026-05-23T03:56:21.460Z
updated: 2026-05-23T03:56:21.460Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] New PWA route /metrics renders stacked-bar or area charts for daily $ spend with per-project (or per-model) decomposition; works at 390px without horizontal scroll
- [ ] Headline numerals (range total $, average $/run, total runs) rendered in Geist Mono per the dispatcher's-console aesthetic
- [ ] Empty-state copy when no cost data exists in the selected range; degraded-state copy when range contains only NULL-cost runs
- [ ] Charts are hand-rolled SVG or a sub-30kB lib (no recharts/echarts)

## Notes

Emitted by feature plan j92lvw5y: ""

