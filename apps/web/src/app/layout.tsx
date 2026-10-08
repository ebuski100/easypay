import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payment Platform",
  description: "Payment platform web application",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
