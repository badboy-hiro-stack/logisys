import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const NAV_ITEMS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/progress", label: "本日の進捗" },
  { href: "/changes", label: "当日変更" },
  { href: "/inbound", label: "入荷・ラベル発行" },
  { href: "/outbound", label: "出荷検品" },
  { href: "/labels/reissue", label: "ラベル再発行" },
  { href: "/reports", label: "当日変更・欠品 報告" },
  { href: "/performance", label: "担当者別実績" },
  { href: "/master", label: "マスタ管理", adminOnly: true },
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

  // 利用者の権限と、有効/無効を確認する
  const { data: me } = await supabase
    .from("m_users")
    .select("user_name, role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  async function signOut() {
    "use server";
    const sb = await createClient();
    await sb.auth.signOut();
    redirect("/login");
  }

  if (!me || !me.is_active) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm bg-white border border-gray-200 rounded-xl p-6 text-sm text-center">
          <p className="font-semibold mb-2">このアカウントは使用できません</p>
          <p className="text-gray-600 mb-4">
            {me
              ? "このアカウントは無効になっています。"
              : "利用者として登録されていません。"}
            管理者に連絡してください。
          </p>
          <form action={signOut}>
            <button type="submit" className="bg-blue-600 text-white rounded-lg px-4 py-2">
              ログアウト
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isAdmin = me.role === "管理者";
  const navItems = NAV_ITEMS.filter((i) => !i.adminOnly || isAdmin);

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* 広い画面(タブレット・PC):左にメニューを表示 */}
      <aside className="hidden md:flex w-56 shrink-0 bg-brand text-white flex-col sticky top-0 h-screen">
        <div className="px-4 py-5 text-sm font-semibold border-b border-white/10">
          市場入出荷検品システム
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {navItems.map((item) => (
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
          {me.user_name}({me.role})
          <form action={signOut} className="mt-1">
            <button type="submit" className="underline text-white/80">
              ログアウト
            </button>
          </form>
        </div>
      </aside>

      {/* 狭い画面(スマートフォン):上にメニューを横並びで表示 */}
      <header className="md:hidden bg-brand text-white">
        <div className="px-4 pt-2 text-xs text-white/70">市場入出荷検品システム</div>
        <nav className="flex overflow-x-auto">
          {navItems.map((item) => (
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
