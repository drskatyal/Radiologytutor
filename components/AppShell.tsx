"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Activity,
  LayoutDashboard,
  LayoutGrid,
  PenLine,
  Radio,
  ShieldCheck,
  ScanLine,
  type LucideIcon,
} from "lucide-react";
import { cn } from "./ui/cn";
import { ToastProvider } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  /** Section label rendered above the group. Omit for the lead group. */
  label?: string;
  items: NavItem[];
}

/**
 * Information architecture — the spine is Home -> Learn (Library) / Teach
 * (Studio) -> Manage (Console), plus a clearly-labelled developer area for
 * internal spikes. One item per intent, so there's exactly one "home" for
 * teaching (Studio) instead of two competing surfaces.
 */
const NAV: NavGroup[] = [
  {
    items: [{ href: "/", label: "Home", icon: LayoutDashboard }],
  },
  {
    label: "Learn",
    items: [{ href: "/library", label: "Library", icon: LayoutGrid }],
  },
  {
    label: "Teach",
    items: [{ href: "/studio", label: "Studio", icon: PenLine }],
  },
  {
    label: "Manage",
    items: [{ href: "/admin", label: "Console", icon: ShieldCheck }],
  },
  {
    label: "Developer",
    items: [
      { href: "/record", label: "Record lab", icon: Radio },
      { href: "/cornerstone", label: "Viewer lab", icon: ScanLine },
    ],
  },
];

/** Flattened list, used for the compact mobile bar. */
const FLAT_NAV: NavItem[] = NAV.flatMap((g) => g.items);

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** FlowRad brand mark — a clinical "scan reticle" glyph paired with the wordmark. */
function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative flex h-8 w-8 items-center justify-center rounded-lg bg-accent-sheen text-accent-foreground shadow-md",
        className
      )}
    >
      <Activity className="h-4 w-4" strokeWidth={2.4} />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-inset ring-white/20"
      />
    </span>
  );
}

function Wordmark() {
  return (
    <span className="font-display text-[15px] font-semibold tracking-tight text-primary">
      FlowRad <span className="text-accent">Learn</span>
    </span>
  );
}

function NavRow({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active
          ? "text-primary"
          : "text-secondary hover:bg-overlay/60 hover:text-primary"
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          aria-hidden="true"
          className="absolute inset-0 -z-10 rounded-lg border border-subtle bg-elevated shadow-sm surface-hairline"
          transition={{ type: "spring", duration: 0.35, bounce: 0.2 }}
        />
      )}
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent"
        />
      )}
      <Icon
        className={cn(
          "h-[18px] w-[18px] shrink-0 transition-colors",
          active ? "text-accent" : "text-muted group-hover:text-secondary"
        )}
        strokeWidth={2}
      />
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  // Student case = reading room. Hide product chrome so the DICOM is the
  // composition. The session HUD carries back-to-library itself.
  const readingRoom = pathname.startsWith("/case/");

  return (
    <ToastProvider>
      <div className={cn("flex min-h-screen bg-canvas", readingRoom && "bg-imaging")}>
        {!readingRoom && (
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-subtle bg-surface/80 backdrop-blur md:flex">
          <Link
            href="/"
            className="group flex items-center gap-2.5 px-5 py-5 focus-visible:outline-none"
          >
            <BrandMark className="transition-transform duration-200 group-hover:scale-105" />
            <Wordmark />
          </Link>

          <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
            {NAV.map((group, gi) => (
              <div key={group.label ?? `group-${gi}`} className="flex flex-col gap-0.5">
                {group.label && (
                  <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                    {group.label}
                  </p>
                )}
                {group.items.map((item) => (
                  <NavRow
                    key={item.href}
                    item={item}
                    active={isActive(pathname, item.href)}
                  />
                ))}
              </div>
            ))}
          </nav>

          <div className="border-t border-subtle px-5 py-4">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70 opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              Radiology teaching platform
            </div>
          </div>
        </aside>
        )}

        {/* Mobile top bar — hidden in the reading room so imaging is full-bleed. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!readingRoom && (
          <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-subtle bg-surface/85 px-4 py-3 backdrop-blur md:hidden">
            <Link href="/" className="flex items-center gap-2">
              <BrandMark />
              <Wordmark />
            </Link>
            <nav className="ml-auto flex gap-1">
              {FLAT_NAV.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                      active
                        ? "bg-elevated text-accent"
                        : "text-secondary hover:bg-overlay hover:text-primary"
                    )}
                  >
                    <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
                  </Link>
                );
              })}
            </nav>
          </header>
          )}

          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Breadcrumb / back row rendered above the title (small, muted). */
  breadcrumbs?: React.ReactNode;
  /** Right-aligned actions (buttons, etc.). */
  actions?: React.ReactNode;
  /** Optional content rendered below the title row (e.g. tabs). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Standard page header — an optional breadcrumb row, a title + description, and
 * right-aligned actions. Its inner width/padding match `PageContainer` so the
 * chrome and the body line up edge-to-edge on every page.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "relative border-b border-subtle bg-surface/40 backdrop-blur-sm",
        className
      )}
    >
      {/* Faint accent seam along the bottom edge — subtle, premium framing. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/25 to-transparent"
      />
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-7 sm:px-8">
        {breadcrumbs && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {breadcrumbs}
          </div>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] font-semibold tracking-tight text-primary">
              {title}
            </h1>
            {description && (
              <div className="mt-1.5 text-sm text-muted">{description}</div>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
