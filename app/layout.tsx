import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "市場入出荷検品システム",
  description: "市場の入荷検品・出荷検品を管理するシステム",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900 antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
