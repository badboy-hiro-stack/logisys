import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const NAV_ITEMS = [
  { href: "/progress", label: "本日の進捗" },
  { href: "/changes", label: "当日変更" },
  { href: "/inbound", label: "入荷・ラベル発行" },
  { href: "/outbound", label: "出荷検品" },
  { href: "/labels/reissue", label: "ラベル再発行" },
  { href: "/reports", label: "当日変更・欠品 報告" },
  { href: "/master", label: "マスタ管理" },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* 広い画面(タブレット・PC):左にメニューを表示 */}
      <aside className="hidden md:flex w-56 shrink-0 bg-brand text-white flex-col">
        <div className="px-4 py-5 text-sm font-semibold border-b border-white/10">
          市場入出荷検品システム
        </div>
        <nav className="flex-1 py-3">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block px-4 py-2.5 text-sm text-white/90 hover:bg-white/10"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="px-4 py-3 text-xs text-white/60 border-t border-white/10">
          {user.email}
        </div>
      </aside>

      {/* 狭い画面(スマートフォン):上にメニューを横並びで表示 */}
      <header className="md:hidden bg-brand text-white">
        <div className="px-4 pt-2 text-xs text-white/70">市場入出荷検品システム</div>
        <nav className="flex overflow-x-auto">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="px-4 py-2.5 text-sm whitespace-nowrap text-white/90"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="flex-1 min-w-0 p-4 md:p-6">{children}</main>
    </div>
  );
}
