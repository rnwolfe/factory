import { Route, Routes, useLocation } from "react-router-dom";
import { AuthGate } from "./components/auth-gate.tsx";
import { ErrorBoundary } from "./components/error-boundary.tsx";
import { Shell } from "./components/shell.tsx";
import { useAuth } from "./lib/auth.ts";
import { AuditPane } from "./routes/audit-pane.tsx";
import { DecisionDetail } from "./routes/decision-detail.tsx";
import { Deepen } from "./routes/deepen.tsx";
import { FeedbackDetail } from "./routes/feedback-detail.tsx";
import { ImportProject } from "./routes/import-project.tsx";
import { ImportSpec } from "./routes/import-spec.tsx";
import { Inbox } from "./routes/inbox.tsx";
import { LivePane } from "./routes/live-pane.tsx";
import { Metrics } from "./routes/metrics.tsx";
import { NewIdea } from "./routes/new-idea.tsx";
import { PlanDetail } from "./routes/plan-detail.tsx";
import { ProjectDetail } from "./routes/project-detail.tsx";
import { Projects } from "./routes/projects.tsx";
import { PromptDetail } from "./routes/prompt-detail.tsx";
import { PromptsViewer } from "./routes/prompts-viewer.tsx";
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
  if (!token) return <AuthGate />;
  return (
    <Shell>
      <Routes>
        <Route
          path="/"
          element={
            <RouteBoundary label="inbox">
              <Inbox />
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
  );
}
