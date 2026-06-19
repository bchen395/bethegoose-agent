import Link from "next/link";
import { redirect } from "next/navigation";

import {
  getMarketsWithDeadline,
  getMonthlySpend,
  getPostsMissingEngagement,
  getSettings,
} from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import NavLinks from "./_components/NavLinks";
import SignOutButton from "./_components/SignOutButton";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login"); // middleware also guards, belt-and-suspenders

  const [missing, deadlines, monthlySpend, settings] = await Promise.all([
    getPostsMissingEngagement(),
    getMarketsWithDeadline(14),
    getMonthlySpend(),
    getSettings(),
  ]);

  // §7 cost meter: show spend once anything has been logged; warn past budget.
  const budget = settings ? Number(settings.monthlyBudgetUsd) : null;
  const overBudget = budget != null && Number.isFinite(budget) && monthlySpend > budget;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/calendar" className="brand">
            <span className="brand-mark" aria-hidden="true">
              🎨
            </span>
            <span className="brand-name">Be The Goose</span>
          </Link>
          <NavLinks />
          <div className="topbar-user">
            <span className="topbar-email" title={user.email}>
              {user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="container">
        {/* Always-on banners (engagement nudge + market deadlines + API spend). */}
        {monthlySpend > 0 && (
          <div className={overBudget ? "banner warn" : "banner info"}>
            💸 API spend this month: <strong>${monthlySpend.toFixed(2)}</strong>
            {budget != null && Number.isFinite(budget) ? ` of $${budget.toFixed(2)} budget` : ""}
            {overBudget ? " — over budget!" : ""}
          </div>
        )}
        {missing.length > 0 && (
          <div className="banner">
            📊 {missing.length} posted item(s) still missing saves or reach — open the Engagement
            view to keep the learning loop fed.
          </div>
        )}
        {deadlines.length > 0 && (
          <div className="banner info">
            🗓{" "}
            {deadlines.length === 1
              ? "Market deadline coming up:"
              : `${deadlines.length} market deadlines coming up:`}
            <ul className="banner-list">
              {deadlines.map((m) => (
                <li key={m.id}>
                  <strong>{m.name}</strong>
                  {m.applicationDeadline ? ` — applications due ${m.applicationDeadline}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {children}
      </div>
    </>
  );
}
