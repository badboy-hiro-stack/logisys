"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Row = {
  user_id: string | null;
  user_name: string;
  arrival_count: number;
  arrival_cases: number;
  label_count: number;
  reissue_count: number;
  outbound_count: number;
  outbound_error_count: number;
  edit_count: number;
};

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PerformancePage() {
  const supabase = createClient();
  const [date, setDate] = useState(todayLocal());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("performance_by_user", { p_date: date });
    if (e) {
      setError("取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setRows(data as unknown as Row[]);
  }, [supabase, date]);

  useEffect(() => {
    setRows(null);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const sum = (f: (r: Row) => number) => (rows ?? []).reduce((a, r) => a + f(r), 0);

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-end gap-3 mb-1">
        <h1 className="text-lg font-semibold">担当者別実績</h1>
        <label className="text-sm flex items-center gap-2">
          日付
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
        </label>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        その日に各担当者が行った作業の件数です(日本時間の0時〜24時で集計)。
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">{error}</div>
      )}
      {!rows && !error && <p className="text-sm text-gray-500">読み込み中…</p>}

      {rows && rows.length === 0 && <p className="text-sm text-gray-500">この日の作業記録はありません。</p>}

      {rows && rows.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                <th className="py-1 pr-2 font-normal">担当者</th>
                <th className="py-1 px-2 font-normal text-right">入荷登録(回)</th>
                <th className="py-1 px-2 font-normal text-right">入荷箱数</th>
                <th className="py-1 px-2 font-normal text-right">ラベル発行(枚)</th>
                <th className="py-1 px-2 font-normal text-right">再発行(枚)</th>
                <th className="py-1 px-2 font-normal text-right">出荷検品(枚)</th>
                <th className="py-1 px-2 font-normal text-right">店舗不一致</th>
                <th className="py-1 pl-2 font-normal text-right">数量・入数変更</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id ?? "none"} className="border-t border-gray-100">
                  <td className="py-2 pr-2 font-medium">{r.user_name}</td>
                  <td className="py-2 px-2 text-right">{r.arrival_count}</td>
                  <td className="py-2 px-2 text-right">{r.arrival_cases}</td>
                  <td className="py-2 px-2 text-right">{r.label_count}</td>
                  <td className="py-2 px-2 text-right">{r.reissue_count}</td>
                  <td className="py-2 px-2 text-right">{r.outbound_count}</td>
                  <td className={"py-2 px-2 text-right " + (r.outbound_error_count > 0 ? "text-red-600 font-semibold" : "")}>
                    {r.outbound_error_count}
                  </td>
                  <td className="py-2 pl-2 text-right">{r.edit_count}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-300 font-semibold">
                <td className="py-2 pr-2">合計</td>
                <td className="py-2 px-2 text-right">{sum((r) => r.arrival_count)}</td>
                <td className="py-2 px-2 text-right">{sum((r) => r.arrival_cases)}</td>
                <td className="py-2 px-2 text-right">{sum((r) => r.label_count)}</td>
                <td className="py-2 px-2 text-right">{sum((r) => r.reissue_count)}</td>
                <td className="py-2 px-2 text-right">{sum((r) => r.outbound_count)}</td>
                <td className="py-2 px-2 text-right">{sum((r) => r.outbound_error_count)}</td>
                <td className="py-2 pl-2 text-right">{sum((r) => r.edit_count)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
