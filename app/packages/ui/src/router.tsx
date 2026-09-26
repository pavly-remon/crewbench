import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/layout.js";
import { ProjectsPage } from "./routes/projects-page.js";
import { TaskBoardPage } from "./routes/task-board-page.js";
import { TaskDetailPage } from "./routes/task-detail-page.js";
import { ScopingChatPage } from "./routes/scoping-chat-page.js";
import { LineupStepPage } from "./routes/lineup-step-page.js";
import { TeamSettingsPage } from "./routes/team-settings-page.js";
import { ProfilePage } from "./routes/profile-page.js";
import { HealthPage } from "./routes/health-page.js";
import { UsagePage } from "./routes/usage-page.js";
import { SettingsPage } from "./routes/settings-page.js";

const rootRoute = createRootRoute({ component: Layout });

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ProjectsPage,
});

const taskBoardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: TaskBoardPage,
});

const projectUsageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/usage",
  component: UsagePage,
});

const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

const scopingChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId/scoping",
  validateSearch: (search: Record<string, unknown>): { text: string } => ({
    text: typeof search.text === "string" ? search.text : "",
  }),
  component: ScopingChatPage,
});

const lineupStepRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId/lineup",
  component: LineupStepPage,
});

const teamSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/team",
  component: TeamSettingsPage,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/profile",
  component: ProfilePage,
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  projectsRoute,
  taskBoardRoute,
  projectUsageRoute,
  taskDetailRoute,
  scopingChatRoute,
  lineupStepRoute,
  teamSettingsRoute,
  profileRoute,
  healthRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
