import { createBrowserClient } from "@supabase/ssr";

// ブラウザ(クライアントコンポーネント)側で使うSupabaseクライアント。
// ログイン画面やスキャン画面など、"use client" のコンポーネントから呼び出す。
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
