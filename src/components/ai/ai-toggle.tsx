"use client";

import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { reloadOnSuccess, untilPageUnload } from "@/components/ui/reload";
import { type AiSettingResult, setAiEnabled } from "@/server/ai/actions";

// Turns the AI assistant on or off for the organization. The database decides who may change it.
export function AiToggle({ organizationId, enabled, editable }: { organizationId: string; enabled: boolean; editable: boolean }) {
  const [value, setValue] = useState(enabled);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AiSettingResult | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
        <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={value} disabled={!editable || pending} onChange={(e) => setValue(e.target.checked)} />
        <span>
          <span className="block font-medium text-fg">Allow the AI assistant in this organization</span>
          <span className="t-small text-fg-3">
            Members can then send questions and relevant code excerpts of snapshots they can see to Google Gemini. Turning it off stops new runs
            immediately.
          </span>
        </span>
      </label>
      {editable ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending || value === enabled}
            className={buttonClass("primary", "sm")}
            onClick={() =>
              start(async () => {
                const r = await setAiEnabled(organizationId, value).catch(() => ({ error: "The request failed." }));
                setResult(r);
                if (reloadOnSuccess(r)) await untilPageUnload();
              })
            }
          >
            {pending && <Spinner />}
            Save
          </button>
          {result?.error && <Alert tone="danger">{result.error}</Alert>}
        </div>
      ) : (
        <p className="t-small text-fg-3">Only owners and admins can change this setting.</p>
      )}
    </div>
  );
}
