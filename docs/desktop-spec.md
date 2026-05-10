# Desktop UX spec — Vercel-style chrome over the phone-first PWA

> **Status:** living. Started 2026-05-10. Slice 1 (chrome only) on
> branch `desktop/responsive-shell` at time of writing.
> **Scope:** the PWA's desktop layout, leading toward the Tauri-wrapped
> desktop client tracked in #1.
> **Audience:** future Ryan, future Claude sessions.

---

## 1. The bet

Heimdall is phone-first because the *most-frequent* operator surface is
the decisions inbox, and the inbox lives best as a one-tap surface in
the pocket. But the operator's *deep work* surface — babysitting a long
run, jumping between triage and a live pane, reading a worktree, kicking
off a project — happens at a laptop.

Today the desktop story is "open the PWA in a browser tab, treat it like
the phone screen scaled up." That's not enough. The operator's laptop
hours deserve a layout that uses the available width — list + detail in
the same view, persistent navigation, ambient status — without giving
anything up on mobile.

The endgame is a Tauri-wrapped desktop client (#1) — but the PWA has to
*earn* that wrapper. Tray, native notifications, and a global hotkey are
valuable on top of a desktop UX worth being in. A wrapper around blown-up
phone chrome is worse than no wrapper at all.

## 2. Direction: Vercel-style desktop chrome

Vercel's desktop UX has a consistent shape:

- Persistent left sidebar with section nav (workspace context above,
  global nav below)
- Slim top bar with project switcher, breadcrumb, search trigger (⌘K),
  notifications bell
- Dense list-and-detail splits — the canonical "uses extra space"
  pattern
- Tabs within sections (Overview / Deployments / Logs / Analytics)
- ⌘K palette as muscle memory for navigation and actions
- Optional activity rail on the right

The aesthetic — monospace IDs, dense rows, small chips — already aligns
with Heimdall's warm-dark workshop look. **What we're translating is the
layout shape, not the visual language.** The amber-on-warm-dark palette,
Fraunces/Geist typography, dispatcher's-console feel — all preserved.

Translated to Heimdall:

```
┌─────────────────────────────────────────────────────────────────┐
│ [H] heimdall · acme ▾ · ▸ inbox ▸ decision      ⌘K  🔔 3       │  48px top bar
├──────────┬──────────────────────────────────────────────────────┤
│          │  ┌──────────────┬──────────────────────────────┐     │
│ ▦ inbox 3│  │ [decision]   │  decision detail              │     │
│ ＋ capture│  │ [decision]   │  body                         │     │
│ ⊞ projects│  │ [audit]      │  options                      │     │
│ ─        │  │ [plan]       │  [actions]                    │     │
│ 〉 acme  │  │ ...          │                               │     │
│  tasks   │  │              │                               │     │
│  runs    │  │              │                               │     │
│  audits  │  └──────────────┴──────────────────────────────┘     │
│ ─        │                                                       │
│ ⚙ settings│                                                      │
└──────────┴──────────────────────────────────────────────────────┘
   ~240px        ~360px list           flex-1 detail
```

Mobile shell stays unchanged: 12h top bar, full-width content, fixed
bottom nav. The desktop chrome appears at the `md:` breakpoint and
above — see §4.

## 3. Architecture: one Shell, responsive

(See `docs/adr/005-responsive-shell.md` for the rationale.)

`Shell.tsx` is one component that adapts its chrome by breakpoint.
Routes are individual components that adapt their content layout. There
is no `DesktopShell` fork. The chrome adaptation is a Tailwind concern,
not an architectural one.

Concretely:

- The mobile top bar gets `md:hidden`; a new `<Sidebar />` is `hidden
  md:flex`.
- Bottom nav gets `md:hidden`.
- Routes opt into multi-pane content via `md:`-prefixed grid classes.
- Hooks like `useAppBadge` and `useInboxCount` mount once and serve
  both surfaces.

## 4. The breakpoint

`md:` (Tailwind default — 768px) is the dividing line. Below 768px is
phone chrome. At/above 768px is desktop chrome.

Why 768 specifically:

- iPad portrait (768) gets desktop chrome — the operator can reasonably
  use the sidebar at that width.
- iPad landscape (1024) gets desktop chrome.
- Phone landscape (414–915 typical) stays on phone chrome — a cramped
  sidebar isn't worth it.
- One breakpoint covers it; no `lg:` or `xl:` complications needed for
  the chrome itself.

Reserved for later: a `lg:` adjustment for the activity rail (when
viewport is wide enough to justify a third column).

## 5. Routes that opt into split-view

The recipe: a list+detail route uses `md:grid md:grid-cols-[360px_1fr]`.
The list column renders the row collection; the detail column renders
the selection. On mobile the detail column is hidden, and clicking a
row navigates to the existing detail route (e.g. `/decisions/:id`) —
**no behavior change, no regression.**

Routes most likely to benefit:

- **Inbox** (`/`) — primary candidate. Decision/plan/audit/feedback
  cards on the left, selected detail on the right. Slice 2.
- **Project detail** (`/projects/:id`) — tab strip in the project
  header for Tasks/Runs/Audits/Plans, plus a per-tab list+detail
  layout. Slice 3.
- **Live pane** (`/projects/:id/runs/:runId`) — already full-width;
  desktop just gets more breathing room. No split needed.
- **Settings** — already structured as sections; no split needed.

Routes that should *not* opt in:

- **Capture** (`/inbox/new`) — single form. Extra width doesn't help.
- **Decision/plan/audit/feedback detail pages** — these are the
  detail-only fallbacks for mobile. They keep working as standalone
  routes; on desktop they're typically reached by selecting a row in
  the parent split-view.

## 6. Phases

| # | Scope | Status |
|---|-------|--------|
| 1 | Chrome only — sidebar + responsive shell, no route changes | **In progress** on `desktop/responsive-shell` |
| 2 | Inbox split-view (list left, detail right on desktop) | Pending |
| 3 | Project detail tabs (Tasks / Runs / Audits / Plans) + per-tab split-view | Pending |
| 4 | Top-bar enhancements: project switcher, breadcrumb, ⌘K trigger | Pending — partially deferrable until tabs land |
| 5 | ⌘K command palette (jump to project / decision / run / setting) | Pending |
| 6 | Activity rail (right column, "what's running" cross-project) | Optional / deferred until lived experience asks for it |

Each phase is a single PR, ideally < 1 day of work.

## 7. Mobile invariant

The desktop initiative must not regress mobile in any of the following:

- Top bar and bottom nav are unchanged at < 768px viewport.
- Every route renders and behaves the same in a 390px viewport as it
  did before this initiative began.
- Touch targets remain 44px+ — no shrinking for desktop's sake.
- No new dependencies that materially bloat the mobile JS bundle.

When a route opts into split-view, the desktop layout is purely
additive — it kicks in at `md:` and above; the mobile fallback is the
existing single-column behavior.

## 8. Out of scope (handled elsewhere)

The following belong to the Tauri wrapper (#1), **not** to this PWA
layout work:

- Tray icon with badge
- Native OS notifications
- Global quick-capture hotkey
- Open-in-editor handoff
- Multi-window
- Drag-and-drop
- Auto-updater

The PWA-level Badging API badge (already shipped in
`apps/pwa/src/lib/use-app-badge.ts`) is the analog the PWA contributes;
the tray badge is a wrapper concern.

## 9. References

- **#1** — Tauri 2 desktop wrapper. The PWA layout is the foundation;
  the wrapper adds OS surfaces.
- **#2** — Rename initiative (factory → Heimdall). Brand text already
  swept; full migration tracked.
- **`docs/vision.md`** — post-v0.1 living direction; this spec is one
  specific arc within that.
- **`docs/adr/005-responsive-shell.md`** — the architectural decision
  to use one Shell rather than two.
