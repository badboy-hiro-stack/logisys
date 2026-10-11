import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

// サーバーコンポーネント・APIルートから使うSupabaseクライアント。
// Cookieにログインセッションを保存・参照する。
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component から呼ばれた場合、Cookie の書き込みはできないが
            // middleware 側でセッションを更新しているため無視してよい
          }
        },
      },
    }
  );
}
