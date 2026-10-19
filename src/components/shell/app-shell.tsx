"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { PageNotice } from "@/components/ui/page-notice";
import { CommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

export type ShellOrganization = { id: string; name: string; role: string };
export type ShellUser = { name: string; email: string };

// Client shell: sidebar (persistent on desktop, icon rail on tablet, drawer on mobile), top bar and the command
// palette. It only renders navigation; every page and every Server Action stays exactly where it was.
export function AppShell({
  user,
  organizations,
  unreadNotifications,
  signOutAction,
  children,
}: {
  user: ShellUser;
  organizations: ShellOrganization[];
  unreadNotifications: number;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // The mobile drawer is open only for the path it was opened on, so any navigation closes it.
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawerOpen = drawerPath === pathname;
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="flex min-h-dvh w-full">
      <Sidebar
        pathname={pathname}
        organizations={organizations}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerPath(null)}
      />
      <div className="flex min-w-0 flex-1 flex-col md:pl-[var(--sidebar-w-compact)] lg:pl-[var(--sidebar-w)]">
        <TopBar
          user={user}
          unreadNotifications={unreadNotifications}
          signOutAction={signOutAction}
          onOpenMenu={() => setDrawerPath(pathname)}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        <main id="main" className="flex-1 px-4 pt-6 pb-16 sm:px-6 lg:px-10 lg:pt-8">
          <PageNotice />
          {children}
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        pathname={pathname}
        organizations={organizations}
      />
    </div>
  );
}
