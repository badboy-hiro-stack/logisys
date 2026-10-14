"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { slipOrderIndex } from "@/lib/inbound";
import { storeTitle } from "@/lib/outbound";

type SupplierRow = {
  supplier_code: string;
  supplier_name: string;
  total: number;
  complete: number;
  partial: number;
  none: number;
  shortage: number;
};
type StoreRow = {
  store_code: string;
  store_name: string;
  sign: string | null;
  label_total: number;
  label_done: number;
  dispatched: boolean;
  dispatched_at: string | null;
};
type WaitingRow = { supplier_name: string; item_name: string; status: string };
type ShortageRow = { supplier_name: string; item_name: string };
type Summary = {
  suppliers: SupplierRow[];
  stores: StoreRow[];
  ordered_qty: number;
  issued_qty: number;
  waiting: WaitingRow[];
  shortage_items: ShortageRow[];
};

// 端末の日付(日本時間)を YYYY-MM-DD にする
function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function Bar({ value, color = "bg-blue-500" }: { value: number; color?: string }) {
  return (
    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${value}%` }} />
    </div>
  );
}

function StatCard({
  title,
  main,
  sub,
  value,
  color,
}: {
  title: string;
  main: string;
  sub: string;
  value?: number;
  color?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{title}</div>
      <div className="text-2xl font-semibold leading-tight">{main}</div>
      <div className="text-xs text-gray-500 mt-1 mb-2">{sub}</div>
      {value !== undefined && <Bar value={value} color={color} />}
    </div>
  );
}

export default function ProgressPage() {
  const supabase = createClient();

  const [date, setDate] = useState("");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [showWaiting, setShowWaiting] = useState(false);

  // 最初に、表示する納品日を決める(最新の注文がある納品日。なければ今日)
  useEffect(() => {
    (async () => {
      const { data: latest } = await supabase
        .from("t_orders")
        .select("target_date")
        .order("target_date", { ascending: false })
        .limit(1);
      const last = ((latest ?? []) as unknown as { target_date: string }[])[0];
      setDate(last?.target_date ?? todayLocal());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!date) return;
    const { data: res, error: e } = await supabase.rpc("progress_summary", { p_date: date });
    if (e) {
      setError("進捗の取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setData(res as unknown as Summary);
    setUpdatedAt(new Date());
  }, [supabase, date]);

  // 表示を開いたとき・日付を変えたとき・10秒ごとに更新する(他の担当者の作業も反映される)
  useEffect(() => {
    if (!date) return;
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [date, load]);

  const suppliers = data?.suppliers ?? [];
  const stores = [...(data?.stores ?? [])].sort(
    (a, b) => slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code)
  );

  // 合計
  const itemTotal = suppliers.reduce((s, r) => s + r.total, 0);
  const itemShortage = suppliers.reduce((s, r) => s + r.shortage, 0);
  const itemComplete = suppliers.reduce((s, r) => s + r.complete, 0);
  const itemTarget = itemTotal - itemShortage; // 欠品確定の品目は、入荷の対象から外す
  const labelTotal = stores.reduce((s, r) => s + r.label_total, 0);
  const labelDone = stores.reduce((s, r) => s + r.label_done, 0);
  const dispatchedCount = stores.filter((s) => s.dispatched).length;
  const storesWithLabels = stores.filter((s) => s.label_total > 0).length;

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <h1 className="text-lg font-semibold">本日の進捗</h1>
        <label className="text-sm flex items-center gap-2">
          納品日
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setData(null);
              setDate(e.target.value);
            }}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={load}
          className="border border-blue-600 text-blue-600 text-sm px-3 py-1 rounded-lg"
        >
          更新
        </button>
        <span className="text-xs text-gray-500">
          {updatedAt ? `最終更新 ${updatedAt.toLocaleTimeString("ja-JP")}(10秒ごとに自動更新)` : ""}
        </span>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {!data && !error && <p className="text-sm text-gray-500">読み込み中…</p>}

      {data && itemTotal === 0 && (
        <p className="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl p-4">
          この納品日の発注データはありません。「入荷・ラベル発行」の「発注データ取込」で、伝票を読み込んでください。
        </p>
      )}

      {data && itemTotal > 0 && (
        <>
          {/* 全体の進捗 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <StatCard
              title="入荷"
              main={`${itemComplete} / ${itemTarget} 品目`}
              sub={`入荷完了 ${pct(itemComplete, itemTarget)}%`}
              value={pct(itemComplete, itemTarget)}
              color="bg-emerald-500"
            />
            <StatCard
              title="ラベル発行(数量)"
              main={`${pct(data.issued_qty, data.ordered_qty)}%`}
              sub={`${data.issued_qty.toLocaleString()} / ${data.ordered_qty.toLocaleString()} 個分`}
              value={pct(data.issued_qty, data.ordered_qty)}
            />
            <StatCard
              title="出荷検品"
              main={`${labelDone} / ${labelTotal} 枚`}
              sub={`配送OK ${dispatchedCount} / ${storesWithLabels} 店舗`}
              value={pct(labelDone, labelTotal)}
              color="bg-indigo-500"
            />
            <StatCard
              title="欠品確定"
              main={`${itemShortage} 品目`}
              sub={itemShortage > 0 ? "下の一覧で確認できます" : "ありません"}
            />
          </div>

          {/* 仕入先別の入荷 */}
          <section className="bg-white border border-gray-200 rounded-xl p-4 mb-6">
            <h2 className="text-sm font-semibold mb-3">仕入先別の入荷状況(品目数)</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 text-left">
                    <th className="py-1 pr-3 font-normal">仕入先</th>
                    <th className="py-1 px-2 font-normal text-right">品目</th>
                    <th className="py-1 px-2 font-normal text-right">入荷完了</th>
                    <th className="py-1 px-2 font-normal text-right">一部入荷</th>
                    <th className="py-1 px-2 font-normal text-right">未入荷</th>
                    <th className="py-1 px-2 font-normal text-right">欠品</th>
                    <th className="py-1 pl-3 font-normal w-32"></th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.supplier_code} className="border-t border-gray-100">
                      <td className="py-2 pr-3">{s.supplier_name}</td>
                      <td className="py-2 px-2 text-right">{s.total}</td>
                      <td className="py-2 px-2 text-right text-emerald-700">{s.complete}</td>
                      <td className="py-2 px-2 text-right text-amber-600">{s.partial}</td>
                      <td className="py-2 px-2 text-right">{s.none}</td>
                      <td className="py-2 px-2 text-right text-red-600">{s.shortage}</td>
                      <td className="py-2 pl-3">
                        <Bar
                          value={pct(s.complete, s.total - s.shortage)}
                          color="bg-emerald-500"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.waiting.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowWaiting((v) => !v)}
                  className="text-sm text-blue-600"
                >
                  {showWaiting ? "▼" : "▶"} 入荷待ちの品目({data.waiting.length}件)
                </button>
                {showWaiting && (
                  <ul className="mt-2 text-sm divide-y divide-gray-100 max-h-72 overflow-y-auto">
                    {data.waiting.map((w, i) => (
                      <li key={i} className="py-1.5 flex gap-2">
                        <span className="text-xs text-gray-500 w-28 shrink-0">{w.supplier_name}</span>
                        <span className="flex-1">{w.item_name}</span>
                        <span
                          className={
                            "text-xs " + (w.status === "一部入荷" ? "text-amber-600" : "text-gray-500")
                          }
                        >
                          {w.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {data.shortage_items.length > 0 && (
              <div className="mt-3 text-sm">
                <div className="text-red-600 font-semibold mb-1">
                  欠品が確定した品目({data.shortage_items.length}件)
                </div>
                <ul className="divide-y divide-gray-100">
                  {data.shortage_items.map((w, i) => (
                    <li key={i} className="py-1.5 flex gap-2">
                      <span className="text-xs text-gray-500 w-28 shrink-0">{w.supplier_name}</span>
                      <span>{w.item_name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* 店舗別の出荷検品 */}
          <section className="bg-white border border-gray-200 rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-3">店舗別の出荷検品</h2>
            <ul className="divide-y divide-gray-100">
              {stores.map((s) => {
                const p = pct(s.label_done, s.label_total);
                const status =
                  s.label_total === 0
                    ? "ラベルなし"
                    : s.dispatched
                      ? "配送OK"
                      : s.label_done === s.label_total
                        ? "検品完了"
                        : s.label_done > 0
                          ? "検品中"
                          : "未着手";
                const statusColor =
                  status === "配送OK"
                    ? "bg-green-100 text-green-700"
                    : status === "検品完了"
                      ? "bg-emerald-50 text-emerald-700"
                      : status === "検品中"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-gray-100 text-gray-500";
                return (
                  <li key={s.store_code} className="py-2">
                    <div className="flex items-center gap-3">
                      <div className="w-40 shrink-0 text-sm">
                        {s.label_total > 0 ? (
                          <Link
                            href={`/outbound/${date}/${s.store_code}`}
                            className="text-blue-600 hover:underline"
                          >
                            {storeTitle(s.store_code, s.store_name, s.sign)}
                          </Link>
                        ) : (
                          <span className="text-gray-400">
                            {storeTitle(s.store_code, s.store_name, s.sign)}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <Bar value={p} color={s.dispatched ? "bg-green-500" : "bg-indigo-500"} />
                      </div>
                      <div className="w-16 text-right text-xs text-gray-600 shrink-0">
                        {s.label_done} / {s.label_total}
                      </div>
                      <span className={`w-16 text-center text-xs rounded-full px-2 py-0.5 shrink-0 ${statusColor}`}>
                        {status}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
