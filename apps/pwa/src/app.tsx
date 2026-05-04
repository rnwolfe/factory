import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/auth-gate.tsx";
import { Shell } from "./components/shell.tsx";
import { useAuth } from "./lib/auth.ts";
import { DecisionDetail } from "./routes/decision-detail.tsx";
import { Inbox } from "./routes/inbox.tsx";
import { LivePane } from "./routes/live-pane.tsx";
import { NewIdea } from "./routes/new-idea.tsx";
import { ProjectDetail } from "./routes/project-detail.tsx";
import { Projects } from "./routes/projects.tsx";
import { Settings } from "./routes/settings.tsx";
import { TaskDetail } from "./routes/task-detail.tsx";

export function App() {
  const token = useAuth((s) => s.token);
  if (!token) return <AuthGate />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Inbox />} />
        <Route path="/inbox/new" element={<NewIdea />} />
        <Route path="/decisions/:id" element={<DecisionDetail />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/projects/:id/tasks/:taskId" element={<TaskDetail />} />
        <Route path="/projects/:id/runs/:runId" element={<LivePane />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Inbox />} />
      </Routes>
    </Shell>
  );
}
