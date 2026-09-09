import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Key Manager",
  description: "Centralized License Management System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
