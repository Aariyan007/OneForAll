"use client";

import { useTransition } from "react";
import { Spinner, buttonClass } from "@/components/ui/button";
import { markNotificationsRead } from "@/server/notifications/actions";

// Marks the caller's own notifications as read: all of them, or the given ids.
export function MarkReadButton({ ids, label = "Mark all as read" }: { ids?: string[]; label?: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={buttonClass("secondary", "sm")}
      onClick={() =>
        start(async () => {
          const r = await markNotificationsRead(ids ?? null);
          if (!r.error) window.location.reload();
        })
      }
    >
      {pending && <Spinner />}
      {label}
    </button>
  );
}
