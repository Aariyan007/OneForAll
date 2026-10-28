"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Avatar } from "@/components/ui/data";
import { IconBell, IconLogout, IconMenu, IconSearch } from "@/components/ui/icons";
import type { ShellUser } from "./app-shell";
import { ThemeToggle } from "./theme-toggle";

export function TopBar({
  user,
  unreadNotifications,
  signOutAction,
  onOpenMenu,
  onOpenPalette,
}: {
  user: ShellUser;
  unreadNotifications: number;
  signOutAction: () => Promise<void>;
  onOpenMenu: () => void;
  onOpenPalette: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-[var(--topbar-h)] items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-md sm:px-6 lg:px-10">
      <button
        type="button"
        onClick={onOpenMenu}
        className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg md:hidden"
        aria-label="Open navigation"
      >
        <IconMenu size={18} />
      </button>

      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex h-8 w-full max-w-sm items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg-3 transition-colors hover:border-border-strong hover:text-fg-2"
        aria-label="Open command menu"
      >
        <IconSearch size={14} />
        <span className="truncate">Search or jump to…</span>
        <kbd className="ml-auto hidden rounded border border-border-strong bg-surface-2 px-1.5 py-px font-sans text-[10.5px] text-fg-3 sm:inline">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        <NotificationsLink unread={unreadNotifications} />
        <AccountMenu user={user} signOutAction={signOutAction} />
      </div>
    </header>
  );
}

// In-app notifications (the unread count is read on the server for the signed-in user).
function NotificationsLink({ unread }: { unread: number }) {
  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      className="relative inline-flex size-8 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
    >
      <IconBell size={16} />
      {unread > 0 && (
        <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}

// A native <details> disclosure, so the menu (and Sign out) also works before/without JavaScript.
// JavaScript only adds "close on outside click / Escape".
function AccountMenu({ user, signOutAction }: { user: ShellUser; signOutAction: () => Promise<void> }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && ref.current?.open) ref.current.open = false;
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details ref={ref} className="group relative">
      <summary
        aria-label="Account menu"
        className="flex h-9 cursor-pointer list-none items-center gap-2.5 rounded-md py-1 pr-2 pl-1 transition-colors group-open:bg-surface-3 hover:bg-surface-3 [&::-webkit-details-marker]:hidden"
      >
        <Avatar name={user.name} size="sm" />
        <span className="hidden max-w-[180px] flex-col items-start leading-tight sm:flex">
          <span className="w-full truncate text-left text-[12.5px] font-medium text-fg">{user.name}</span>
          <span className="w-full truncate text-left text-[11px] text-fg-3">{user.email}</span>
        </span>
      </summary>
      <div role="menu" className="absolute top-full right-0 z-50 mt-2 w-64 animate-pop rounded-lg border border-border-strong bg-surface-2 p-1 shadow-pop">
        <div className="flex items-center gap-2.5 px-2.5 py-2.5">
          <Avatar name={user.name} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-fg">{user.name}</p>
            <p className="truncate text-[12px] text-fg-3">{user.email}</p>
          </div>
        </div>
        <div className="my-1 h-px bg-border" />
        <form action={signOutAction}>
          <button
            type="submit"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <IconLogout size={15} />
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
