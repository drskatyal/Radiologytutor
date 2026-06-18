"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui/cn";
import { ToastProvider } from "./ui";

interface NavLink {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const NAV: NavLink[] = [
  {
    href: "/",
    label: "Cases",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <path d="M3 8h14M7 4v12" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/author",
    label: "Author",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M4 13.5V16h2.5L15 7.5 12.5 5 4 13.5z" strokeLinejoin="round" />
        <path d="M11.5 6l2.5 2.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/record",
    label: "Record",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="10" cy="10" r="7" />
        <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: "/admin",
    label: "Admin",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M10 3l6 3v4c0 3.5-2.5 6-6 7-3.5-1-6-3.5-6-7V6l6-3z" strokeLinejoin="round" />
      </svg>
    ),
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-canvas">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-subtle bg-surface md:flex">
          <Link
            href="/"
            className="flex items-center gap-2.5 px-5 py-5 focus-visible:outline-none"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 4v16M4 12h16" strokeLinecap="round" opacity="0.5" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-primary">
              FlowRad <span className="text-accent">Learn</span>
            </span>
          </Link>

          <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
            {NAV.map((link) => {
              const active = isActive(pathname, link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                    active
                      ? "bg-elevated text-primary"
                      : "text-secondary hover:bg-elevated/60 hover:text-primary"
                  )}
                >
                  <span
                    className={cn(
                      "h-4 w-4 shrink-0 [&_svg]:h-4 [&_svg]:w-4",
                      active ? "text-accent" : "text-muted group-hover:text-secondary"
                    )}
                  >
                    {link.icon}
                  </span>
                  {link.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-subtle px-5 py-4">
            <p className="text-xs text-muted">Radiology teaching platform</p>
          </div>
        </aside>

        {/* Mobile top bar */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-4 border-b border-subtle bg-surface px-4 py-3 md:hidden">
            <Link href="/" className="text-[15px] font-semibold tracking-tight text-primary">
              FlowRad <span className="text-accent">Learn</span>
            </Link>
            <nav className="flex gap-1">
              {NAV.map((link) => {
                const active = isActive(pathname, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
                      active ? "bg-elevated text-primary" : "text-secondary hover:text-primary"
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </header>

          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, etc.). */
  actions?: React.ReactNode;
  /** Optional content rendered below the title row (e.g. tabs). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Standard page header — title + optional description and right-aligned
 * actions. Use at the top of each page so chrome stays consistent.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("border-b border-subtle bg-surface/40", className)}>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-primary">
              {title}
            </h1>
            {description && (
              <p className="mt-1 text-sm text-muted">{description}</p>
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
