"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { slipOrderIndex } from "@/lib/inbound";
import { storeTitle } from "@/lib/outbound";

type Store = { store_code: string; store_name: string; sign: string | null };
type Count = { total: number; done: number };

export default function OutboundSelectPage() {
  const supabase = createClient();

  const [stores, setStores] = useState<Store[]>([]);
  const [date, setDate] = useState("");
  const [counts, setCounts] = useState<Record<string, Count>>({});
  const [dispatched, setDispatched] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // 最初に、店舗の一覧と、直近にラベルを発行した納品日を取得する
  useEffect(() => {
    (async () => {
      const [st, latest] = await Promise.all([
        supabase.from("m_stores").select("store_code, store_name, sign"),
        supabase
          .from("v_labels")
          .select("target_date")
          .order("target_date", { ascending: false })
          .limit(1),
      ]);
      const list = ((st.data ?? []) as unknown as Store[]).sort(
        (a, b) => slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code)
      );
      setStores(list);
      const last = ((latest.data ?? []) as unknown as { target_date: string }[])[0];
      setDate(last?.target_date ?? new Date().toISOString().slice(0, 10));
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 店舗ごとの進捗(確定済み/全ラベル数)と、配送OKの店舗を取得する
  const load = useCallback(async () => {
    if (!date) return;
    const [lab, disp] = await Promise.all([
      supabase.from("v_labels").select("store_code, status").eq("target_date", date).neq("status", "無効"),
      supabase.from("t_store_dispatch").select("store_code").eq("target_date", date),
    ]);
    if (lab.error) {
      setError("ラベルの取得に失敗しました: " + lab.error.message);
      return;
    }
    setError(null);
    const c: Record<string, Count> = {};
    ((lab.data ?? []) as unknown as { store_code: string; status: string }[]).forEach((r) => {
      const cur = c[r.store_code] ?? { total: 0, done: 0 };
      cur.total += 1;
      if (r.status === "検品済") cur.done += 1;
      c[r.store_code] = cur;
    });
    setCounts(c);
    setDispatched(
      new Set(((disp.data ?? []) as unknown as { store_code: string }[]).map((r) => r.store_code))
    );
  }, [supabase, date]);

  // 他の担当者の作業も反映されるよう、10秒ごとに自動で更新する
  useEffect(() => {
    if (!ready || !date) return;
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [ready, date, load]);

  const totalAll = Object.values(counts).reduce((a, c) => a + c.total, 0);
  const doneAll = Object.values(counts).reduce((a, c) => a + c.done, 0);

  return (
    <div className="max-w-xl">
      <h1 className="text-lg font-semibold mb-1">出荷検品:店舗を選択</h1>
      <p className="text-xs text-gray-500 mb-4">他の担当者の作業は、10秒ごとに自動で反映されます</p>

      <div className="flex items-end gap-4 mb-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">納品日</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
          />
        </div>
        <p className="text-sm text-gray-600 pb-1.5">
          全体 {doneAll}/{totalAll}件 確定
        </p>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      <div className="space-y-2">
        {stores.map((s) => {
          const c = counts[s.store_code] ?? { total: 0, done: 0 };
          const none = c.total === 0;
          const complete = !none && c.done === c.total;
          const started = c.done > 0;
          const box =
            "flex items-center justify-between rounded-xl border px-4 py-3 " +
            (none
              ? "bg-gray-50 border-gray-100 text-gray-400"
              : complete
                ? "bg-green-50 border-green-200"
                : started
                  ? "bg-amber-50 border-amber-200"
                  : "bg-white border-gray-200");
          const inner = (
            <>
              <div>
                <div className="text-sm font-medium">{storeTitle(s.store_code, s.store_name, s.sign)}</div>
                <div className="text-xs mt-0.5">
                  {none ? (
                    "対象のラベルなし"
                  ) : (
                    <span className={complete ? "text-green-700" : started ? "text-amber-700" : "text-gray-500"}>
                      {c.done}/{c.total}件 {complete ? "完了" : started ? "進行中" : "未着手"}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {dispatched.has(s.store_code) && (
                  <span className="text-xs bg-green-600 text-white rounded-full px-2 py-0.5">配送OK</span>
                )}
                {!none && <span className="text-gray-400">›</span>}
              </div>
            </>
          );
          return none ? (
            <div key={s.store_code} className={box}>
              {inner}
            </div>
          ) : (
            <Link key={s.store_code} href={`/outbound/${date}/${s.store_code}`} className={box}>
              {inner}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
