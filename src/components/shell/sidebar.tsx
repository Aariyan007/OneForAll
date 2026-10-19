"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/data";
import { IconChevronsUpDown, IconClose, IconLogo, IconPlus, IconSettings } from "@/components/ui/icons";
import { ROLE_LABELS, isOrgRole } from "@/lib/authz/permissions";
import { cx } from "@/lib/cx";
import type { ShellOrganization } from "./app-shell";
import { NavIcon } from "./nav-icon";
import { buildNav, isActive, parseRoute, type NavItem } from "./nav-model";

export function Sidebar({
  pathname,
  organizations,
  drawerOpen,
  onCloseDrawer,
}: {
  pathname: string;
  organizations: ShellOrganization[];
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  const ctx = parseRoute(pathname);
  const current = organizations.find((org) => org.id === ctx.organizationId);
  const sections = buildNav(ctx, current?.role);

  return (
    <>
      {/* mobile backdrop */}
      <div
        aria-hidden="true"
        onClick={onCloseDrawer}
        className={cx(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 md:hidden",
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        aria-label="Primary"
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-bg-subtle/95 backdrop-blur transition-transform duration-200 ease-out",
          "w-[var(--sidebar-w)] md:w-[var(--sidebar-w-compact)] lg:w-[var(--sidebar-w)]",
          drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        {/* brand */}
        <div className="flex h-[var(--topbar-h)] shrink-0 items-center justify-between gap-2 border-b border-border px-4 md:justify-center md:px-0 lg:justify-between lg:px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5 rounded-md" aria-label="OneForAll dashboard">
            <span className="inline-flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-[#4f5fe0] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_4px_12px_-4px_rgb(123_140_255/0.6)]">
              <IconLogo size={16} />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-fg md:hidden lg:inline">OneForAll</span>
          </Link>
          <button
            type="button"
            onClick={onCloseDrawer}
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg md:hidden"
            aria-label="Close navigation"
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* workspace selector */}
        <div className="px-3 pt-3 md:px-2 lg:px-3">
          <WorkspaceSelector organizations={organizations} current={current} />
        </div>

        {/* navigation */}
        <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-4 md:px-2 lg:px-3">
          {sections.map((section) => (
            <div key={section.title} className="mt-4 first:mt-2">
              <p className="t-caption mb-1.5 px-2 text-fg-3 md:hidden lg:block">{section.title}</p>
              <div aria-hidden="true" className="mx-auto mb-2 hidden h-px w-6 bg-border md:block lg:hidden" />
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.key}>
                    <NavLink item={item} active={isActive(item, pathname)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* footer */}
        <div className="border-t border-border p-3 md:p-2 lg:p-3">
          <span
            title="Settings — coming soon"
            className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-3/70 md:justify-center lg:justify-start"
          >
            <IconSettings size={16} />
            <span className="md:hidden lg:inline">Settings</span>
            <span className="ml-auto rounded border border-border px-1.5 text-[10px] font-medium tracking-wide text-fg-3 md:hidden lg:inline">
              SOON
            </span>
          </span>
        </div>
      </aside>
    </>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const base =
    "relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150 md:justify-center lg:justify-start";
  if (!item.href) {
    return (
      <span
        title={item.soon ? `${item.label} — coming soon` : `${item.label} — ${item.hint ?? "unavailable"}`}
        aria-disabled="true"
        className={cx(base, "cursor-not-allowed text-fg-3/60")}
      >
        <NavIcon name={item.icon} />
        <span className="truncate md:hidden lg:inline">{item.label}</span>
        {item.soon && (
          <span className="ml-auto rounded border border-border px-1.5 text-[10px] font-medium tracking-wide text-fg-3 md:hidden lg:inline">
            SOON
          </span>
        )}
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-current={active ? "page" : undefined}
      className={cx(
        base,
        active ? "bg-surface-3 text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
      )}
    >
      {active && <span aria-hidden="true" className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent" />}
      <span className={active ? "text-accent" : undefined}>
        <NavIcon name={item.icon} />
      </span>
      <span className="truncate md:hidden lg:inline">{item.label}</span>
    </Link>
  );
}

function WorkspaceSelector({ organizations, current }: { organizations: ShellOrganization[]; current?: ShellOrganization }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = current?.name ?? "Select workspace";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2 md:justify-center md:px-1 lg:justify-start lg:px-2"
      >
        {current ? <Avatar name={current.name} size="sm" square /> : <span className="inline-flex size-6 items-center justify-center rounded-lg border border-dashed border-border-strong text-fg-3"><IconPlus size={12} /></span>}
        <span className="min-w-0 flex-1 md:hidden lg:block">
          <span className="block truncate text-[13px] font-medium text-fg">{label}</span>
          <span className="block truncate text-[11px] text-fg-3">{current ? roleLabel(current.role) : `${organizations.length} available`}</span>
        </span>
        <IconChevronsUpDown size={14} className="text-fg-3 md:hidden lg:block" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Organizations"
          className="absolute top-full left-0 z-50 mt-1.5 w-[232px] animate-pop rounded-lg border border-border-strong bg-surface-2 p-1 shadow-pop"
        >
          <p className="t-caption px-2 pt-1.5 pb-1 text-fg-3">Organizations</p>
          <div className="max-h-64 overflow-y-auto">
            {organizations.length === 0 && <p className="px-2 py-2 text-[12.5px] text-fg-3">You are not a member of any organization yet.</p>}
            {organizations.map((org) => (
              <Link
                key={org.id}
                href={`/organizations/${org.id}/overview`}
                role="option"
                aria-selected={org.id === current?.id}
                onClick={() => setOpen(false)}
                className={cx(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-surface-3",
                  org.id === current?.id ? "text-fg" : "text-fg-2",
                )}
              >
                <Avatar name={org.name} size="sm" square />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                <span className="text-[11px] text-fg-3">{roleLabel(org.role)}</span>
              </Link>
            ))}
          </div>
          <div className="my-1 h-px bg-border" />
          <Link
            href="/organizations/new"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <span className="inline-flex size-6 items-center justify-center rounded-lg border border-dashed border-border-strong">
              <IconPlus size={12} />
            </span>
            Create organization
          </Link>
        </div>
      )}
    </div>
  );
}

function roleLabel(role: string) {
  return isOrgRole(role) ? ROLE_LABELS[role] : role;
}
