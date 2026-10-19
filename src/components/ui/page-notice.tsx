"use client";

import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { Alert } from "./alert";
import { readPageNotice, subscribePageNotice } from "./reload";

// Shows the confirmation a change saved before its full page load (reloadWithNotice / navigateWithNotice).
// Nothing is rendered on the server, so hydration never differs.
export function PageNotice() {
  const pathname = usePathname();
  const notice = useSyncExternalStore(subscribePageNotice, () => readPageNotice(pathname), () => null);

  // A page restored from the back/forward cache comes back exactly as it was left, including a form that stayed
  // pending while the browser navigated away (untilPageUnload). Load it again so it shows the current server state.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  if (!notice) return null;
  return (
    <Alert tone={notice.tone} title={notice.title} className="mb-5">
      {notice.message}
    </Alert>
  );
}
