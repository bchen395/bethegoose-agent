"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/calendar", icon: "📅", label: "Calendar" },
  { href: "/engagement", icon: "📊", label: "Engagement" },
  { href: "/insights", icon: "💡", label: "Insights" },
  { href: "/products", icon: "🛍", label: "Products" },
  { href: "/markets", icon: "🏪", label: "Markets" },
  { href: "/settings", icon: "⚙️", label: "Settings" },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      {LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            className={active ? "active" : ""}
            aria-current={active ? "page" : undefined}
          >
            {/* Emoji lives in its own fixed-size box so its varying glyph
                metrics can't shift the label off the shared baseline. */}
            <span className="nav-ico" aria-hidden="true">
              {l.icon}
            </span>
            <span className="nav-label">{l.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
