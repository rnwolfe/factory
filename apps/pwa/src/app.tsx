import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { AuthGate } from "./components/auth-gate.tsx";
import { CommandPalette } from "./components/command-palette.tsx";
import { ErrorBoundary } from "./components/error-boundary.tsx";
import { LandingRouter } from "./components/landing-router.tsx";
import { ReleaseNotesSheet } from "./components/release-notes-sheet.tsx";
import { Shell } from "./components/shell.tsx";
import { useAuth } from "./lib/auth.ts";
import { useAppBadge } from "./lib/use-app-badge.ts";
import { usePalette } from "./lib/use-palette.ts";
import { AuditPane } from "./routes/audit-pane.tsx";
import { DecisionDetail } from "./routes/decision-detail.tsx";
import { Deepen } from "./routes/deepen.tsx";
import { FeedbackDetail } from "./routes/feedback-detail.tsx";
import { History } from "./routes/history.tsx";
import { ImportProject } from "./routes/import-project.tsx";
import { ImportSpec } from "./routes/import-spec.tsx";
import { Inbox } from "./routes/inbox.tsx";
import { LivePane } from "./routes/live-pane.tsx";
import { Metrics } from "./routes/metrics.tsx";
import { NewIdea } from "./routes/new-idea.tsx";
import { Ops } from "./routes/ops.tsx";
import { PlanDetail } from "./routes/plan-detail.tsx";
import { ProjectDetail } from "./routes/project-detail.tsx";
import { Projects } from "./routes/projects.tsx";
import { PromptDetail } from "./routes/prompt-detail.tsx";
import { PromptsViewer } from "./routes/prompts-viewer.tsx";
import { ReleaseNotes } from "./routes/release-notes.tsx";
import { RepoBrowser } from "./routes/repo-browser.tsx";
import { RubricDetail } from "./routes/rubric-detail.tsx";
import { RubricsViewer } from "./routes/rubrics-viewer.tsx";
import { ScriptPane } from "./routes/script-pane.tsx";
import { SessionPane } from "./routes/session-pane.tsx";
import { Settings } from "./routes/settings.tsx";
import { TaskDetail } from "./routes/task-detail.tsx";
import { WorktreesAdmin } from "./routes/worktrees.tsx";

/**
 * Per-route boundary wrapper. Each route gets its own ErrorBoundary keyed
 * on the current pathname so navigating away resets the error state — the
 * boundary doesn't carry forward into a fresh route.
 */
function RouteBoundary({ label, children }: { label: string; children: React.ReactNode }) {
  const loc = useLocation();
  return (
    <ErrorBoundary key={loc.pathname} label={label}>
      {children}
    </ErrorBoundary>
  );
}

export function App() {
  const token = useAuth((s) => s.token);
  useAppBadge(Boolean(token));
  useCommandPaletteHotkey(Boolean(token));
  if (!token) return <AuthGate />;
  return (
    <>
      <CommandPalette />
      <ReleaseNotesSheet />
      <Shell>
        <Routes>
          <Route
            path="/"
            element={
              <RouteBoundary label="landing">
                <LandingRouter />
              </RouteBoundary>
            }
          />
          <Route
            path="/inbox"
            element={
              <RouteBoundary label="inbox">
                <Inbox />
              </RouteBoundary>
            }
          />
          <Route
            path="/ops"
            element={
              <RouteBoundary label="ops">
                <Ops />
              </RouteBoundary>
            }
          />
          <Route
            path="/inbox/new"
            element={
              <RouteBoundary label="new-idea">
                <NewIdea />
              </RouteBoundary>
            }
          />
          <Route
            path="/inbox/import-spec"
            element={
              <RouteBoundary label="import-spec">
                <ImportSpec />
              </RouteBoundary>
            }
          />
          <Route
            path="/decisions/:id"
            element={
              <RouteBoundary label="decision-detail">
                <DecisionDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/plans/:id"
            element={
              <RouteBoundary label="plan-detail">
                <PlanDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects"
            element={
              <RouteBoundary label="projects">
                <Projects />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/import"
            element={
              <RouteBoundary label="import-project">
                <ImportProject />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <RouteBoundary label="project-detail">
                <ProjectDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/tasks/:taskId"
            element={
              <RouteBoundary label="task-detail">
                <TaskDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/runs/:runId"
            element={
              <RouteBoundary label="live-pane">
                <LivePane />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/scripts/:scriptId"
            element={
              <RouteBoundary label="script-pane">
                <ScriptPane />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/code"
            element={
              <RouteBoundary label="repo-browser">
                <RepoBrowser />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/sessions/:sessionId"
            element={
              <RouteBoundary label="session-pane">
                <SessionPane />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/audits/:auditId"
            element={
              <RouteBoundary label="audit-pane">
                <AuditPane />
              </RouteBoundary>
            }
          />
          <Route
            path="/projects/:id/deepen"
            element={
              <RouteBoundary label="deepen">
                <Deepen />
              </RouteBoundary>
            }
          />
          <Route
            path="/feedback/:id"
            element={
              <RouteBoundary label="feedback-detail">
                <FeedbackDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings"
            element={
              <RouteBoundary label="settings">
                <Settings />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings/prompts"
            element={
              <RouteBoundary label="prompts-viewer">
                <PromptsViewer />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings/prompts/:key"
            element={
              <RouteBoundary label="prompt-detail">
                <PromptDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings/rubrics"
            element={
              <RouteBoundary label="rubrics-viewer">
                <RubricsViewer />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings/rubrics/:key"
            element={
              <RouteBoundary label="rubric-detail">
                <RubricDetail />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings/worktrees"
            element={
              <RouteBoundary label="worktrees">
                <WorktreesAdmin />
              </RouteBoundary>
            }
          />
          <Route
            path="/settings/release-notes"
            element={
              <RouteBoundary label="release-notes">
                <ReleaseNotes />
              </RouteBoundary>
            }
          />
          <Route
            path="/history"
            element={
              <RouteBoundary label="history">
                <History />
              </RouteBoundary>
            }
          />
          <Route
            path="/metrics"
            element={
              <RouteBoundary label="metrics">
                <Metrics />
              </RouteBoundary>
            }
          />
          <Route
            path="*"
            element={
              <RouteBoundary label="inbox-fallback">
                <Inbox />
              </RouteBoundary>
            }
          />
        </Routes>
      </Shell>
    </>
  );
}

function useCommandPaletteHotkey(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // Cede the chord to a focused xterm pane — neovim uses Ctrl+K
        // (digraph entry, window-up navigation) and emacs-readline binds it
        // to kill-line. Any PWA-level chord registered on document must
        // gate on this check or it will steal keystrokes the operator is
        // typing into their terminal session.
        if (isFocusInXtermPane()) return;
        e.preventDefault();
        usePalette.getState().toggle();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled]);
}

function isFocusInXtermPane(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  // xterm.js mounts a `.xterm` root and focuses an inner `.xterm-helper-textarea`
  // for input; `.closest()` matches either.
  return el.closest(".xterm") !== null;
}
