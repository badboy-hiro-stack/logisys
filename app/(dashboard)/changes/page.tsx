"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Target = {
  order_line_id: number;
  supplier_code: string;
  supplier_name: string;
  item_code: string;
  item_name: string;
  total_display: string | null;
  arrival_status: string;
  locked: boolean;
  has_history: boolean;
};

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ChangesPage() {
  const supabase = createClient();
  const [date, setDate] = useState("");
  const [rows, setRows] = useState<Target[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState("");
  const [keyword, setKeyword] = useState("");
  const [onlyEditable, setOnlyEditable] = useState(false);
  const [onlyHistory, setOnlyHistory] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("t_orders")
        .select("target_date")
        .order("target_date", { ascending: false })
        .limit(1);
      const last = ((data ?? []) as unknown as { target_date: string }[])[0];
      setDate(last?.target_date ?? todayLocal());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!date) return;
    const { data, error: e } = await supabase.rpc("change_targets", { p_date: date });
    if (e) {
      setError("一覧の取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setRows((data ?? []) as unknown as Target[]);
  }, [supabase, date]);

  useEffect(() => {
    load();
  }, [load]);

  const suppliers = useMemo(() => {
    const m = new Map<string, string>();
    (rows ?? []).forEach((r) => m.set(r.supplier_code, r.supplier_name));
    return Array.from(m.entries());
  }, [rows]);

  const shown = useMemo(() => {
    const k = keyword.trim();
    return (rows ?? []).filter(
      (r) =>
        (!supplier || r.supplier_code === supplier) &&
        (!k || r.item_name.includes(k) || r.item_code.includes(k)) &&
        (!onlyEditable || !r.locked) &&
        (!onlyHistory || r.has_history)
    );
  }, [rows, supplier, keyword, onlyEditable, onlyHistory]);

  const lockedCount = (rows ?? []).filter((r) => r.locked).length;
  const historyCount = (rows ?? []).filter((r) => r.has_history).length;

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold mb-1">当日変更:対象選択</h1>
      <Link href="/changes/add" className="inline-block mb-3 text-sm text-brand underline">
        + 当日の追加品目を登録する
      </Link>
      <p className="text-sm text-gray-600 mb-4">
        入荷当日に数量・入数の変更が入った品目を選びます。<b>ラベルが1枚でも発行済みの品目は編集できません</b>
        (🔒)。変更したことがある品目には 🕘 が付きます。
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <label className="flex items-center gap-2">
          納品日
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setRows(null);
              setDate(e.target.value);
            }}
            className="border border-gray-300 rounded-lg px-2 py-1"
          />
        </label>
        <select
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1"
        >
          <option value="">すべての仕入先</option>
          {suppliers.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="品名・コードで絞り込み"
          className="border border-gray-300 rounded-lg px-3 py-1 w-52"
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={onlyEditable}
            onChange={(e) => setOnlyEditable(e.target.checked)}
          />
          編集できるものだけ
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={onlyHistory}
            onChange={(e) => setOnlyHistory(e.target.checked)}
          />
          変更履歴ありだけ
        </label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">
          {error}
        </div>
      )}
      {!rows && !error && <p className="text-sm text-gray-500">読み込み中…</p>}
      {rows && rows.length === 0 && (
        <p className="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl p-4">
          この納品日の発注データはありません。
        </p>
      )}

      {rows && rows.length > 0 && (
        <>
          <p className="text-xs text-gray-500 mb-2">
            全{rows.length}品目(🔒 ラベル発行済み {lockedCount} / 🕘 変更履歴あり {historyCount})
            ・表示 {shown.length}件
          </p>
          <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {shown.map((r) => {
              const inner = (
                <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="w-6 text-center">{r.locked ? "🔒" : ""}</span>
                  <span className="w-6 text-center">{r.has_history ? "🕘" : ""}</span>
                  <span className="text-xs text-gray-500 w-24 shrink-0">{r.supplier_name}</span>
                  <span className="flex-1 min-w-0">
                    <span className={r.locked ? "text-gray-400" : ""}>{r.item_name}</span>
                    <span className="text-xs text-gray-400 ml-2">{r.item_code}</span>
                  </span>
                  <span className="w-20 text-right text-xs text-gray-600">{r.total_display ?? ""}</span>
                  <span className="w-16 text-right text-xs text-gray-500">{r.arrival_status}</span>
                </div>
              );
              return (
                <li key={r.order_line_id}>
                  {r.locked ? (
                    <div title="ラベルが発行済みのため編集できません" className="cursor-not-allowed">
                      {inner}
                    </div>
                  ) : (
                    <Link href={`/changes/${r.order_line_id}`} className="block hover:bg-blue-50">
                      {inner}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
