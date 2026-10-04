import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const NAV_ITEMS = [
  { href: "/progress", label: "本日の進捗" },
  { href: "/inbound", label: "入荷・ラベル発行" },
  { href: "/outbound", label: "出荷検品" },
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
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 bg-brand text-white flex flex-col">
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
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
