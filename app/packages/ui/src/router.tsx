import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/layout.js";
import { ProjectsPage } from "./routes/projects-page.js";
import { TaskBoardPage } from "./routes/task-board-page.js";
import { TaskDetailPage } from "./routes/task-detail-page.js";

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

const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

const routeTree = rootRoute.addChildren([projectsRoute, taskBoardRoute, taskDetailRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
