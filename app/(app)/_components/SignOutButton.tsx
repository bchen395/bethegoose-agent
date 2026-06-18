"use client";

import { signOut } from "@/app/actions";

export default function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="btn text-sm">
        Sign out
      </button>
    </form>
  );
}
