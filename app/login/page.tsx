"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Location = { location_id: number; location_name: string };

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [locations, setLocations] = useState<Location[]>([]);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [locationId, setLocationId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 拠点の選択肢を取得(m_locationsは誰でも読める設定を想定)
    supabase
      .from("m_locations")
      .select("location_id, location_name")
      .order("location_id")
      .then(({ data }) => {
        if (data) {
          setLocations(data as Location[]);
          if (data.length > 0) setLocationId(String(data[0].location_id));
        }
      });
  }, [supabase]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // ログインIDはメールアドレス形式でSupabase Authに登録しておく運用とする
    // (例: yamada -> yamada@logisys.local のように内部的にメール化する)
    const email = loginId.includes("@") ? loginId : `${loginId}@logisys.local`;

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError("ログインIDまたはパスワードが正しくありません");
      setLoading(false);
      return;
    }

    // 今回ログインした拠点をセッション側に覚えさせる(実績記録用)
    if (locationId) {
      window.localStorage.setItem("logisys:location_id", locationId);
    }

    router.push("/progress");
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-8">
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-brand mx-auto mb-3 flex items-center justify-center text-white text-xl font-bold">
              Q
            </div>
            <h1 className="text-lg font-semibold">市場入出荷検品システム</h1>
            <p className="text-sm text-gray-500 mt-1">ログインしてください</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                ログインID
              </label>
              <input
                type="text"
                required
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="例:yamada"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">
                パスワード
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">拠点</label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {locations.map((loc) => (
                  <option key={loc.location_id} value={loc.location_id}>
                    {loc.location_name}
                  </option>
                ))}
              </select>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {loading ? "ログイン中..." : "ログイン"}
            </button>
          </form>
        </div>
        <p className="text-center text-xs text-gray-400 mt-3">
          ログインするとこの端末に「検品担当者」または「管理者」として記録されます
        </p>
      </div>
    </main>
  );
}
