"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/calendar", label: "📅 Calendar" },
  { href: "/review", label: "📝 Review" },
  { href: "/engagement", label: "📊 Engagement" },
  { href: "/insights", label: "💡 Insights" },
  { href: "/products", label: "🛍 Products" },
  { href: "/markets", label: "🏪 Markets" },
  { href: "/settings", label: "⚙️ Settings" },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={pathname === l.href ? "active" : ""}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
