# ADR-005 · One Shell, responsive — not two Shells

**Status:** accepted (2026-05-10)
**Scope:** desktop UX initiative (see `docs/desktop-spec.md`)

## Context

The PWA's `Shell.tsx` was written phone-first: a 12h top bar, a fixed
bottom nav, and main content between. The desktop UX initiative (Vercel-
style chrome — persistent left sidebar, no bottom nav, eventually a top
bar with project switcher and command palette) means the *chrome shape*
on desktop is meaningfully different from mobile, not just a CSS tweak.

That naturally raises the question: should the app pick a `MobileShell`
vs a `DesktopShell` based on viewport, with each component owning its
own layout cleanly? Or should there be a single `Shell` that adapts its
chrome by breakpoint?

The two-Shell version is tempting because the layouts look superficially
different — a fixed bottom nav and a left-sidebar aren't the same flex
arrangement. Cleaner separation, the reasoning goes.

## Decision

**One `Shell.tsx` that adapts by breakpoint.** Mobile chrome (top bar +
bottom nav) is hidden at `md:` and above; the new `<Sidebar />` is
`hidden md:flex`. The Shell stays one component, one mounting tree,
one source of shared state.

Routes that opt into multi-pane layouts do so individually with `md:`
modifiers (e.g. `md:grid md:grid-cols-[360px_1fr]`). The Shell is
agnostic to route content.

## Consequences

**Positive:**

- Single source of truth for chrome state — auth gate's relationship to
  Shell, the inbox-count hook, future top-bar widgets all attach once
  and serve both surfaces.
- Shared hooks (`useAppBadge`, `useInboxCount`) mount once. Two shells
  would either duplicate them or push them up to a shared parent —
  recreating the unified Shell anyway.
- Bundle impact is minimal: Tailwind handles the breakpoint with class
  variants, no extra component tree.
- Adding a new chrome element (notifications bell, project switcher) is
  one decision in one file.

**Negative:**

- Every chrome change must consider both viewports — easy to forget the
  one you're not staring at. Mitigated by the explicit mobile invariant
  in `docs/desktop-spec.md` §7.
- The markup looks like "mobile bits + desktop bits in the same file" —
  reads slightly noisier than two clean files would. Lived
  noisiness < behavior drift.

## Alternatives considered

**Two Shells (`Shell.tsx` + `DesktopShell.tsx`)** — rejected.

- Behavior drift between the two: a setting that works on one but not
  the other ships before anyone notices.
- Hooks like `useAppBadge` either duplicate or live in a shared parent,
  recreating the unified Shell anyway — without the type-level
  guarantees of one component.
- Doubles the surface for every future chrome addition.

**Native per-OS desktop client** — out of scope here. That's the Tauri
wrapper question (#1). The PWA layout is upstream of the wrapper
question; the wrapper adds OS surfaces, not layout.

**Route-level "desktop layout" components** — push the chrome decision
into each route. Rejected because the chrome is genuinely shared
(sidebar nav, eventually a top bar) and shouldn't be reimplemented per
route. Routes own *content* layout (split-view vs single-column);
chrome stays in the Shell.

## Open questions

- **Sidebar collapsible vs always-expanded.** Slice 1 ships always-
  expanded at 240px. If lived experience says it eats too much width
  (especially on smaller laptops), add a collapse toggle. Not a one-way
  door.
- **Top-bar inclusion.** Slice 1 has no desktop top bar — the sidebar
  carries brand + nav. Slice 4 adds the top bar when project switcher,
  breadcrumb, and ⌘K need a home. If those land elsewhere (e.g. ⌘K as
  a standalone overlay, breadcrumb inside route content), the top bar
  may not need to exist at all.
