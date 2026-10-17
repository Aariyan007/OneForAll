import { RenderTaskBoundary } from "@/components/shell/render-task-boundary";

// Everything below a project (repository, snapshots, graph, requirements) is rendered on the server as its own task,
// starting from a fresh call stack. These are the deepest routes of the app; see RenderTaskBoundary for why.
// No data, no authorization: every page below still verifies its own access.
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <RenderTaskBoundary>{children}</RenderTaskBoundary>;
}
