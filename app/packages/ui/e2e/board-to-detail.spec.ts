import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { FIXTURE_PATH } from "./global-setup.js";
import type { FixtureInfo } from "./fixture-server.js";

async function loadFixture(): Promise<FixtureInfo> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf-8")) as FixtureInfo;
}

/** The Definition of Done's own smoke test: board -> task detail,
 * against a real daemon and a real fixture project/task (see
 * `e2e/fixture-server.ts`), not a mocked API. */
test("projects page -> task board -> task detail", async ({ page }) => {
  const fixture = await loadFixture();
  await page.goto(`http://127.0.0.1:${fixture.port}/#token=${fixture.token}`);

  // Projects page: the fixture project's card is visible.
  await expect(page.getByText("e2e-fixture")).toBeVisible();

  // Into the board.
  await page.getByText("e2e-fixture").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${fixture.projectId}$`));
  await expect(page.getByText(fixture.taskTitle)).toBeVisible();

  // Into task detail.
  await page.getByText(fixture.taskTitle).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${fixture.taskId}$`));
  await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
  await expect(page.getByText("implementing")).toBeVisible();

  // The tabs are real and switch content.
  await page.getByRole("button", { name: "Issues" }).click();
  await expect(page.getByText(/no issues recorded/i)).toBeVisible();
});
