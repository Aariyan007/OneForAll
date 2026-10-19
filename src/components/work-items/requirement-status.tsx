"use client";

import { useState, useTransition } from "react";
import { Spinner, buttonClass } from "@/components/ui/button";
import { reloadWithNotice, untilPageUnload } from "@/components/ui/reload";
import { updateRequirementStatus } from "@/server/requirements/actions";
import { REQUIREMENT_STATUSES, type RequirementStatus, isAllowedRequirementTransition } from "@/server/requirements/schema";

// Requirement lifecycle for owners and admins. The database trigger is the authority; completing additionally needs
// every task of the requirement to be completed or cancelled (migration 20261027000001).
const LABELS: Record<string, string> = {
  "DRAFT>READY": "Mark ready",
  "READY>IN_PROGRESS": "Start",
  "IN_PROGRESS>COMPLETED": "Complete",
  "COMPLETED>IN_PROGRESS": "Reopen",
  "CANCELLED>DRAFT": "Restore",
};

type Ids = { organizationId: string; departmentId: string; teamId: string; projectId: string; requirementId: string };

export function RequirementStatusActions({ ids, status, openTasks }: { ids: Ids; status: RequirementStatus; openTasks: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const next = REQUIREMENT_STATUSES.filter((to) => to !== status && isAllowedRequirementTransition(status, to));
  if (next.length === 0) return <p className="t-small text-fg-3">No status changes available.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {next.map((to) => {
          const blocked = to === "COMPLETED" && openTasks > 0;
          return (
            <button
              key={to}
              type="button"
              disabled={pending || blocked}
              title={blocked ? "Finish or cancel every task first." : undefined}
              className={buttonClass(to === "CANCELLED" ? "danger" : to === "COMPLETED" || to === "READY" || to === "IN_PROGRESS" ? "primary" : "secondary", "sm")}
              onClick={() => {
                if (to === "CANCELLED" && !window.confirm("Cancel this requirement?")) return;
                setError(null);
                start(async () => {
                  const r = await updateRequirementStatus(ids.organizationId, ids.departmentId, ids.teamId, ids.projectId, ids.requirementId, to).catch(() => ({
                    error: "The request failed. Try again.",
                  }));
                  if (r.error) {
                    setError(r.error);
                    return;
                  }
                  reloadWithNotice({ tone: "success", message: "Requirement status updated." });
                  await untilPageUnload();
                });
              }}
            >
              {pending && <Spinner />}
              {LABELS[`${status}>${to}`] ?? (to === "CANCELLED" ? "Cancel" : to)}
            </button>
          );
        })}
      </div>
      {status === "IN_PROGRESS" && openTasks > 0 && (
        <p className="t-small text-fg-3">
          {openTasks} open task{openTasks === 1 ? "" : "s"}: the requirement can be completed once every task is completed or cancelled.
        </p>
      )}
      {error && <p className="text-[12.5px] text-danger" role="alert">{error}</p>}
    </div>
  );
}
