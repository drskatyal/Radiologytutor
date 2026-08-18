"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Activity,
  GraduationCap,
  Home,
  LayoutGrid,
  LogIn,
  PenLine,
  Radio,
  ShieldCheck,
  ScanLine,
  type LucideIcon,
} from "lucide-react";
import { cn } from "./ui/cn";
import { Button, Skeleton, ToastProvider } from "./ui";
import { SignOutButton } from "./auth/AuthButtons";
import type { MembershipRole, PlatformRole } from "@/lib/types";

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

type MeUser = {
  name?: string | null;
  email?: string;
  membershipRole?: MembershipRole | null;
  platformRole?: PlatformRole | null;
};

function canSeeTeachNav(me: MeUser | null): boolean {
  if (!me) return false;
  if (me.platformRole === "super_admin") return true;
  const role = me.membershipRole;
  return role === "author" || role === "admin" || role === "owner";
}

function canSeeAdminNav(me: MeUser | null): boolean {
  if (!me) return false;
  if (me.platformRole === "super_admin") return true;
  const role = me.membershipRole;
  return role === "admin" || role === "owner";
}

/**
 * Marketplace IA — Home, Learn (library + courses), Teach (Studio), Manage (Admin).
 * Developer labs only ship in development. Sign-in lives in the sidebar footer.
 */
function navGroups(showDeveloper: boolean, me: MeUser | null): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [{ href: "/", label: "Home", icon: Home }],
    },
    {
      label: "Learn",
      items: [
        { href: "/library", label: "Library", icon: LayoutGrid },
        { href: "/library#courses", label: "Courses", icon: GraduationCap },
      ],
    },
  ];
  if (canSeeTeachNav(me)) {
    groups.push({
      label: "Teach",
      items: [{ href: "/studio", label: "Studio", icon: PenLine }],
    });
  }
  if (canSeeAdminNav(me)) {
    groups.push({
      label: "Manage",
      items: [{ href: "/admin", label: "Admin", icon: ShieldCheck }],
    });
  }
  if (showDeveloper) {
    groups.push({
      label: "Developer",
      items: [
        { href: "/record", label: "Record lab", icon: Radio },
        { href: "/cornerstone", label: "Viewer lab", icon: ScanLine },
      ],
    });
  }
  return groups;
}

function isActive(pathname: string, href: string): boolean {
  const path = href.split("#")[0] || "/";
  if (path === "/") return pathname === "/";
  // Hash jump-links (e.g. Courses → /library#courses) should not steal the
  // Library item's active state.
  if (href.includes("#")) return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** FlowRad brand mark — a clinical "scan reticle" glyph paired with the wordmark. */
export function BrandMark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "h-12 w-12" : "h-8 w-8";
  const icon = size === "lg" ? "h-6 w-6" : "h-4 w-4";
  return (
    <span
      className={cn(
        "relative flex items-center justify-center rounded-lg bg-accent-sheen text-accent-foreground shadow-md",
        box,
        className
      )}
    >
      <Activity className={icon} strokeWidth={2.4} />
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

function AuthNav({ me, loading }: { me: MeUser | null; loading: boolean }) {
  if (loading) {
    return <Skeleton className="h-9 w-full rounded-lg" />;
  }

  if (!me?.email) {
    return (
      <Link href="/sign-in" className="block">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          leadingIcon={<LogIn className="h-4 w-4" aria-hidden="true" />}
        >
          Sign in
        </Button>
      </Link>
    );
  }

  const displayName = me.name || me.email;

  return (
    <div className="flex flex-col gap-2">
      <Link
        href="/dashboard"
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-overlay/60 focus-visible:outline-none"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-elevated font-display text-xs font-semibold text-secondary ring-1 ring-inset ring-subtle">
          {displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-primary">{displayName}</span>
          <span className="block text-xs text-muted">Your home</span>
        </span>
      </Link>
      <SignOutButton className="h-8 w-full justify-start px-2 text-xs" />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [me, setMe] = useState<MeUser | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ user?: MeUser | null }>;
      })
      .then((data) => {
        if (!alive) return;
        const user = data?.user;
        setMe(user?.email ? user : null);
      })
      .catch(() => {
        if (alive) setMe(null);
      })
      .finally(() => {
        if (alive) setMeLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Student case = reading room. Hide product chrome so the DICOM is the
  // composition. The session HUD carries back-to-library itself.
  const readingRoom = pathname.startsWith("/case/");
  const authScreen = pathname === "/sign-in" || pathname === "/sign-up";
  const hideChrome = readingRoom || authScreen;
  const showDeveloper = process.env.NODE_ENV === "development";
  const nav = useMemo(() => navGroups(showDeveloper, me), [showDeveloper, me]);
  const mobileNav = useMemo(
    () =>
      nav
        .filter((g) => g.label !== "Developer")
        .flatMap((g) => g.items)
        .filter((i) => !i.href.includes("#")),
    [nav]
  );

  return (
    <ToastProvider>
      <div className={cn("flex min-h-screen bg-canvas", readingRoom && "bg-imaging")}>
        {!hideChrome && (
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-subtle bg-surface/80 backdrop-blur md:flex">
          <Link
            href="/"
            className="group flex items-center gap-2.5 px-5 py-5 focus-visible:outline-none"
          >
            <BrandMark className="transition-transform duration-200 group-hover:scale-105" />
            <Wordmark />
          </Link>

          <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
            {nav.map((group, gi) => (
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

          <div className="border-t border-subtle px-3 py-4">
            <AuthNav me={me} loading={meLoading} />
          </div>
        </aside>
        )}

        {/* Mobile top bar — hidden in the reading room so imaging is full-bleed. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!hideChrome && (
          <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-subtle bg-surface/85 px-4 py-3 backdrop-blur md:hidden">
            <Link href="/" className="flex items-center gap-2">
              <BrandMark />
              <Wordmark />
            </Link>
            <nav className="ml-auto flex items-center gap-1">
              {mobileNav.map((item) => {
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
              <Link
                href="/sign-in"
                aria-label="Sign in"
                className="flex h-9 w-9 items-center justify-center rounded-md text-secondary transition-colors hover:bg-overlay hover:text-primary"
              >
                <LogIn className="h-[18px] w-[18px]" strokeWidth={2} />
              </Link>
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
