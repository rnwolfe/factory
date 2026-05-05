import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/auth-gate.tsx";
import { Shell } from "./components/shell.tsx";
import { useAuth } from "./lib/auth.ts";
import { AuditPane } from "./routes/audit-pane.tsx";
import { DecisionDetail } from "./routes/decision-detail.tsx";
import { Deepen } from "./routes/deepen.tsx";
import { Inbox } from "./routes/inbox.tsx";
import { LivePane } from "./routes/live-pane.tsx";
import { Metrics } from "./routes/metrics.tsx";
import { NewIdea } from "./routes/new-idea.tsx";
import { PlanDetail } from "./routes/plan-detail.tsx";
import { ProjectDetail } from "./routes/project-detail.tsx";
import { Projects } from "./routes/projects.tsx";
import { PromptDetail } from "./routes/prompt-detail.tsx";
import { PromptsViewer } from "./routes/prompts-viewer.tsx";
import { Settings } from "./routes/settings.tsx";
import { TaskDetail } from "./routes/task-detail.tsx";
import { WorktreesAdmin } from "./routes/worktrees.tsx";

export function App() {
  const token = useAuth((s) => s.token);
  if (!token) return <AuthGate />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Inbox />} />
        <Route path="/inbox/new" element={<NewIdea />} />
        <Route path="/decisions/:id" element={<DecisionDetail />} />
        <Route path="/plans/:id" element={<PlanDetail />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/projects/:id/tasks/:taskId" element={<TaskDetail />} />
        <Route path="/projects/:id/runs/:runId" element={<LivePane />} />
        <Route path="/projects/:id/audits/:auditId" element={<AuditPane />} />
        <Route path="/projects/:id/deepen" element={<Deepen />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/prompts" element={<PromptsViewer />} />
        <Route path="/settings/prompts/:key" element={<PromptDetail />} />
        <Route path="/settings/worktrees" element={<WorktreesAdmin />} />
        <Route path="/metrics" element={<Metrics />} />
        <Route path="*" element={<Inbox />} />
      </Routes>
    </Shell>
  );
}
