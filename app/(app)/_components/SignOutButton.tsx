"use client";

import { signOut } from "@/app/actions";

export default function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="btn" style={{ fontSize: 13 }}>
        Sign out
      </button>
    </form>
  );
}
