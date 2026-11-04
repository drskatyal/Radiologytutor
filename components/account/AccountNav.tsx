"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";

const ITEMS = [
  { href: "/library", label: "Studies" },
  { href: "/collections", label: "Collections" },
  { href: "/links", label: "Shared links" },
  { href: "/viewer", label: "Viewer" },
];

export function AccountNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Account" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href === "/library" && pathname.startsWith("/studies/"));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              active ? "bg-accent/10 text-accent" : "text-secondary hover:bg-overlay hover:text-primary"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
