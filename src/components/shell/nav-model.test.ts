import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNav } from "./nav-model";

const ids = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  departmentId: "22222222-2222-4222-8222-222222222222",
  teamId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
};

const assistantItem = (ctx: Parameters<typeof buildNav>[0]) =>
  buildNav(ctx)
    .flatMap((section) => section.items)
    .find((item) => item.key === "assistant");

describe("AI Assistant navigation", () => {
  it("links to the project's assistant page inside a project", () => {
    const item = assistantItem(ids);
    assert.ok(item, "the item exists");
    assert.equal(
      item.href,
      `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}/assistant`,
    );
    assert.equal(item.match, "prefix");
  });

  it("is disabled outside a project", () => {
    assert.equal(assistantItem({ organizationId: ids.organizationId })?.href, undefined);
  });
});
