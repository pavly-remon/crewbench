import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/layout.js";
import { ProjectsPage } from "./routes/projects-page.js";
import { TaskBoardPage } from "./routes/task-board-page.js";
import { TaskDetailPage } from "./routes/task-detail-page.js";
import { HealthPage } from "./routes/health-page.js";
import { UsagePage } from "./routes/usage-page.js";

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

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthPage,
});

const routeTree = rootRoute.addChildren([projectsRoute, taskBoardRoute, projectUsageRoute, taskDetailRoute, healthRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
