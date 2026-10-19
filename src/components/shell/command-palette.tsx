"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowRight, IconSearch } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import type { ShellOrganization } from "./app-shell";
import { NavIcon } from "./nav-icon";
import { buildNav, parseRoute } from "./nav-model";

type Command = { id: string; label: string; group: string; href: string; icon: string };

// Client-side "jump to" menu over routes that already exist. No search backend, no new data.
export function CommandPalette({
  open,
  onOpenChange,
  pathname,
  organizations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string;
  organizations: ShellOrganization[];
}) {
  const router = useRouter();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const route = parseRoute(pathname);
    for (const section of buildNav(route, organizations.find((o) => o.id === route.organizationId)?.role)) {
      for (const item of section.items) {
        if (item.href) list.push({ id: `nav-${item.key}`, label: item.label, group: section.title, href: item.href, icon: item.icon });
      }
    }
    list.push({ id: "create-org", label: "Create organization", group: "Actions", href: "/organizations/new", icon: "building" });
    for (const org of organizations) {
      list.push({ id: `org-overview-${org.id}`, label: `${org.name} — Overview`, group: "Organizations", href: `/organizations/${org.id}/overview`, icon: "building" });
      list.push({ id: `org-${org.id}`, label: `${org.name} — Departments`, group: "Organizations", href: `/organizations/${org.id}/departments`, icon: "layers" });
    }
    return list;
  }, [pathname, organizations]);

  if (!open) return null;
  return <PaletteDialog commands={commands} onClose={() => onOpenChange(false)} onSelect={(href) => { onOpenChange(false); router.push(href); }} />;
}

function PaletteDialog({ commands, onClose, onSelect }: { commands: Command[]; onClose: () => void; onSelect: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const groups = [...new Set(filtered.map((c) => c.group))];
  const safeActive = Math.min(active, Math.max(filtered.length - 1, 0));

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="presentation">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="relative w-full max-w-xl animate-pop overflow-hidden rounded-xl border border-border-strong bg-surface-2 shadow-pop"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((i) => Math.min(i + 1, filtered.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          }
          if (event.key === "Enter" && filtered[safeActive]) {
            event.preventDefault();
            onSelect(filtered[safeActive].href);
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <IconSearch size={16} className="text-fg-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="Jump to a page…"
            aria-label="Search pages"
            className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-3"
          />
          <kbd className="rounded border border-border-strong px-1.5 py-px text-[10.5px] text-fg-3">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-fg-3">No matching pages.</p>}
          {groups.map((group) => (
            <div key={group} className="mb-1">
              <p className="t-caption px-2.5 pt-2 pb-1 text-fg-3">{group}</p>
              {filtered
                .filter((c) => c.group === group)
                .map((command) => {
                  const index = filtered.indexOf(command);
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onMouseEnter={() => setActive(index)}
                      onClick={() => onSelect(command.href)}
                      className={cx(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                        index === safeActive ? "bg-surface-3 text-fg" : "text-fg-2",
                      )}
                    >
                      <span className={index === safeActive ? "text-accent" : "text-fg-3"}>
                        <NavIcon name={command.icon} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {index === safeActive && <IconArrowRight size={14} className="text-fg-3" />}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
