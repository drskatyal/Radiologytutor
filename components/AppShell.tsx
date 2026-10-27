"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Broadcast,
  GraduationCap,
  House,
  PenNib,
  Scan,
  ShieldCheck,
  SquaresFour,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "./ui/cn";
import { Button, Skeleton, ToastProvider } from "./ui";
import { DemoEntryButton, DemoRoleEntry, SignOutButton } from "./auth/AuthButtons";
import { BrandMark, Wordmark as BrandWordmark } from "@/components/brand/BrandMark";
import { CookieNotice } from "@/components/marketing/CookieNotice";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import type { MembershipRole, PlatformRole } from "@/lib/types";

export { BrandMark } from "@/components/brand/BrandMark";

interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

type MeUser = {
  name?: string | null;
  email?: string;
  membershipRole?: MembershipRole | null;
  platformRole?: PlatformRole | null;
};

const EASE = "ease-draw";

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

function teachHref(me: MeUser | null): string {
  return canSeeTeachNav(me) ? "/studio" : "/sign-up";
}

function navGroups(showDeveloper: boolean, me: MeUser | null): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [
        { href: "/", label: "Home", icon: House },
        { href: "/library", label: "Library", icon: SquaresFour },
        { href: "/learning", label: "My learning", icon: GraduationCap },
      ],
    },
  ];
  if (canSeeTeachNav(me)) {
    groups.push({
      label: "Teach",
      items: [{ href: "/studio", label: "Studio", icon: PenNib }],
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
        { href: "/record", label: "Record lab", icon: Broadcast },
        { href: "/cornerstone", label: "Viewer lab", icon: Scan },
      ],
    });
  }
  return groups;
}

function isActive(pathname: string, href: string): boolean {
  const path = href.split("#")[0] || "/";
  if (path === "/") return pathname === "/";
  if (href.includes("#")) return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function Wordmark() {
  return <BrandWordmark size="sm" />;
}

function MenuToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="relative h-8 w-8 rounded-lg text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
      aria-expanded={open}
      aria-controls="mobile-menu"
      aria-label={open ? "Close menu" : "Open menu"}
      onClick={onClick}
    >
      <span
        className={cn(
          "absolute left-2 right-2 top-1/2 h-px bg-current transition-transform duration-500",
          EASE,
          open ? "-translate-y-1/2 rotate-45" : "-translate-y-2"
        )}
      />
      <span
        className={cn(
          "absolute left-2 right-2 top-1/2 h-px bg-current transition-transform duration-500",
          EASE,
          open ? "-translate-y-1/2 -rotate-45" : "translate-y-2"
        )}
      />
    </button>
  );
}

function AuthCluster({
  me,
  loading,
  demoEnabled,
  onNavigate,
}: {
  me: MeUser | null;
  loading: boolean;
  demoEnabled: boolean;
  onNavigate?: () => void;
}) {
  if (loading) return <Skeleton className="h-8 w-24 rounded-lg" />;

  if (!me?.email) {
    if (demoEnabled) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <DemoRoleEntry teacherLabel="Teacher" studentLabel="Student" size="sm" />
          <Link
            href="/sign-in"
            onClick={onNavigate}
            className="rounded-lg px-2 py-2 text-sm font-semibold text-secondary transition-colors duration-300 ease-draw hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Sign in
          </Link>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/sign-in"
          onClick={onNavigate}
          className="rounded-lg px-3 py-2 text-sm font-semibold text-secondary transition-colors duration-300 ease-draw hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Sign in
        </Link>
        <Link href={teachHref(me)} onClick={onNavigate}>
          <Button size="sm">Start teaching</Button>
        </Link>
      </div>
    );
  }

  const displayName = me.name || me.email;
  return (
    <div className="flex items-center gap-2">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="max-w-[12rem] truncate rounded-lg px-3 py-2 text-sm font-semibold text-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {displayName}
      </Link>
      <SignOutButton className="px-3 py-2 text-sm" />
      {canSeeTeachNav(me) && (
        <Link href="/studio" onClick={onNavigate} className="hidden sm:block">
          <Button size="sm">Start teaching</Button>
        </Link>
      )}
    </div>
  );
}

export function AppShell({
  children,
  demoEnabled = false,
}: {
  children: React.ReactNode;
  /** Server-passed. Demo entry is hidden when this deployment has demo auth off. */
  demoEnabled?: boolean;
}) {
  const pathname = usePathname() ?? "/";
  const [me, setMe] = useState<MeUser | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

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
  }, [pathname]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const readingRoom = pathname.startsWith("/case/");
  const authScreen = pathname === "/sign-in" || pathname === "/sign-up";
  const hideChrome = readingRoom || authScreen;
  const showDeveloper = process.env.NODE_ENV === "development";
  const nav = useMemo(() => navGroups(showDeveloper, me), [showDeveloper, me]);
  const flatNav = useMemo(
    () => nav.flatMap((group) => group.items).filter((item) => !item.href.includes("#")),
    [nav]
  );

  return (
    <ToastProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-foreground"
      >
        Skip to content
      </a>
      <div className={cn("flex min-h-dvh flex-col bg-canvas", readingRoom && "bg-imaging")}>
        {!hideChrome && (
          <header className="pointer-events-none fixed inset-x-0 top-4 z-40 px-4">
            <div className="pointer-events-auto mx-auto flex w-fit max-w-full items-center gap-2 rounded-2xl border border-subtle bg-surface/90 p-2 shadow-md backdrop-blur-md">
              <Link
                href="/"
                className="group flex items-center gap-2 rounded-lg px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="RadLearn home"
              >
                <BrandMark
                  size="sm"
                  className="transition-transform duration-500 ease-draw group-hover:-translate-y-0.5"
                />
                <Wordmark />
              </Link>
              <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
                {flatNav.map((item) => {
                  const active = isActive(pathname, item.href);
                  const ItemIcon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors duration-300",
                        EASE,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        active ? "bg-accent/10 text-accent" : "text-secondary hover:bg-overlay hover:text-primary"
                      )}
                    >
                      <ItemIcon className="h-4 w-4" weight="regular" aria-hidden="true" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="hidden md:block">
                <AuthCluster me={me} loading={meLoading} demoEnabled={demoEnabled} />
              </div>
              <MenuToggle open={menuOpen} onClick={() => setMenuOpen((value) => !value)} />
            </div>
          </header>
        )}

        {!hideChrome && (
          <div
            id="mobile-menu"
            className={cn(
              "fixed inset-0 z-30 bg-canvas/95 backdrop-blur-md transition-opacity duration-500 md:hidden",
              EASE,
              menuOpen ? "opacity-100" : "pointer-events-none opacity-0"
            )}
            aria-hidden={!menuOpen}
          >
            <nav aria-label="Mobile" className="flex h-full flex-col justify-end gap-2 px-6 pb-12 pt-24">
              {flatNav.map((item, index) => {
                const active = isActive(pathname, item.href);
                const ItemIcon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    tabIndex={menuOpen ? 0 : -1}
                    style={{
                      transitionDelay:
                        menuOpen && !reduceMotion ? `${Math.min(index * 60, 340)}ms` : "0ms",
                    }}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-2xl font-semibold transition-[transform_opacity] duration-500",
                      EASE,
                      menuOpen ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
                      reduceMotion && "translate-y-0",
                      active ? "text-primary" : "text-secondary"
                    )}
                  >
                    <ItemIcon className="h-6 w-6" weight="regular" aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
              <div
                className={cn(
                  "mt-6 transition-[transform_opacity] duration-500",
                  EASE,
                  menuOpen ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
                  reduceMotion && "translate-y-0"
                )}
                style={{
                  transitionDelay: menuOpen && !reduceMotion ? `${Math.min(flatNav.length * 60, 340)}ms` : "0ms",
                }}
              >
                <AuthCluster
                  me={me}
                  loading={meLoading}
                  demoEnabled={demoEnabled}
                  onNavigate={() => setMenuOpen(false)}
                />
              </div>
            </nav>
          </div>
        )}

        <div className={cn("flex min-w-0 flex-1 flex-col", !hideChrome && "pt-20")}>
          <main id="main" className="min-w-0 flex-1">
            {children}
          </main>
          {!hideChrome && (
            <SiteFooter
              teaching={
                demoEnabled && (meLoading || !me?.email) ? (
                  meLoading ? (
                    <span className="text-sm font-semibold text-muted">Start teaching</span>
                  ) : (
                    <DemoEntryButton
                      role="author"
                      variant="ghost"
                      size="sm"
                      wrapClassName="self-center"
                      className="h-auto px-0 py-0 text-sm text-secondary hover:bg-transparent hover:text-primary"
                    >
                      Start teaching
                    </DemoEntryButton>
                  )
                ) : undefined
              }
            />
          )}
        </div>
        {!readingRoom && <CookieNotice />}
      </div>
    </ToastProvider>
  );
}

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("bg-canvas", className)}>
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 sm:px-8">
        {breadcrumbs && <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">{breadcrumbs}</div>}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-[680px]">
            <h1 className="text-2xl font-semibold tracking-tight text-primary text-balance">{title}</h1>
            {description && <div className="mt-2 text-sm text-secondary text-pretty">{description}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
