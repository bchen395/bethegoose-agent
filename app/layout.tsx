import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Art Business Agent",
  description: "Be The Goose — weekly plan, post prep, and engagement tracking.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
