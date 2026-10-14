"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { slipOrderIndex } from "@/lib/inbound";
import { formatTime, storeTitle } from "@/lib/outbound";

type Shortage = {
  store_qty_id: number;
  supplier_name: string;
  item_name: string;
  store_code: string;
  store_name: string;
  sign: string | null;
  pack_size: number;
  ordered_cases: number;
  issued_cases: number;
  shortage_cases: number;
  reported_at: string | null;
  reported_by_name: string | null;
};

type Change = {
  log_id: number;
  kind: "数量変更" | "入数変更" | "産地変更";
  supplier_name: string;
  item_name: string;
  store_code: string;
  store_name: string;
  sign: string | null;
  pack_size: number;
  old_value: string | null;
  new_value: string | null;
  is_added: boolean;
  is_cancel: boolean;
  changed_at: string;
  changed_by_name: string | null;
  reported_at: string | null;
  reported_by_name: string | null;
};

type Report = { shortages: Shortage[]; changes: Change[] };

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function byStoreOrder<T extends { store_code: string }>(a: T, b: T) {
  return slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code);
}

export default function ReportsPage() {
  const supabase = createClient();
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyUnreported, setOnlyUnreported] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: res, error: e } = await supabase.rpc("report_items", { p_date: date });
    if (e) {
      setError("一覧の取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setData(res as unknown as Report);
  }, [supabase, date]);

  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  // 「報告済み」のチェックを付ける/外す
  async function toggleShortage(r: Shortage) {
    const key = `s-${r.store_qty_id}`;
    setBusy(key);
    const { data: u } = await supabase.auth.getUser();
    const reported = !r.reported_at;
    const { error: e } = await supabase
      .from("t_order_line_store_qty")
      .update({
        shortage_reported_by: reported ? (u.user?.id ?? null) : null,
        shortage_reported_at: reported ? new Date().toISOString() : null,
      })
      .eq("id", r.store_qty_id);
    if (e) setError("更新に失敗しました: " + e.message);
    await load();
    setBusy(null);
  }

  async function toggleChange(r: Change) {
    const key = `c-${r.log_id}`;
    setBusy(key);
    const { data: u } = await supabase.auth.getUser();
    const reported = !r.reported_at;
    const { error: e } = await supabase
      .from("t_order_edit_logs")
      .update({
        reported_to_ops_by: reported ? (u.user?.id ?? null) : null,
        reported_to_ops_at: reported ? new Date().toISOString() : null,
      })
      .eq("log_id", r.log_id);
    if (e) setError("更新に失敗しました: " + e.message);
    await load();
    setBusy(null);
  }

  const shortages = [...(data?.shortages ?? [])].sort(byStoreOrder);
  const qtyChanges = (data?.changes ?? []).filter((c) => c.kind === "数量変更");
  const packChanges = (data?.changes ?? []).filter((c) => c.kind === "入数変更");
  const originChanges = (data?.changes ?? []).filter((c) => c.kind === "産地変更");

  const unreported =
    shortages.filter((r) => !r.reported_at).length +
    qtyChanges.filter((r) => !r.reported_at).length +
    packChanges.filter((r) => !r.reported_at).length +
    originChanges.filter((r) => !r.reported_at).length;
  const total = shortages.length + qtyChanges.length + packChanges.length + originChanges.length;

  const showS = shortages.filter((r) => !onlyUnreported || !r.reported_at);
  const showQ = qtyChanges.filter((r) => !onlyUnreported || !r.reported_at);
  const showP = packChanges.filter((r) => !onlyUnreported || !r.reported_at);
  const showO = originChanges.filter((r) => !onlyUnreported || !r.reported_at);

  const Check = ({
    checked,
    disabled,
    onChange,
  }: {
    checked: boolean;
    disabled: boolean;
    onChange: () => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="w-5 h-5 print:hidden"
    />
  );

  const reportedText = (at: string | null, by: string | null) =>
    at ? `報告済み ${formatTime(at)}${by ? `(${by})` : ""}` : "";

  return (
    <div className="max-w-5xl">
      {/* 印刷するときは、メニューを隠す */}
      <style>{`@media print { aside, header { display: none !important; } }`}</style>

      <div className="flex flex-wrap items-end gap-3 mb-1">
        <h1 className="text-lg font-semibold">当日変更・欠品 報告</h1>
        <label className="text-sm flex items-center gap-2 print:hidden">
          日付
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm flex items-center gap-1 print:hidden">
          <input
            type="checkbox"
            checked={onlyUnreported}
            onChange={(e) => setOnlyUnreported(e.target.checked)}
          />
          未報告だけ表示
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          className="border border-blue-600 text-blue-600 text-sm px-3 py-1 rounded-lg print:hidden"
        >
          印刷
        </button>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        店舗運営部へ<b>当日中に報告</b>するための一覧です。当日に発生した欠品・数量変更・入数変更だけが出ます
        (翌日には繰り越しません)。報告したら、行のチェックを入れてください。
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}
      {!data && !error && <p className="text-sm text-gray-500">読み込み中…</p>}

      {data && (
        <>
          <div
            className={
              "rounded-xl border p-3 mb-5 text-sm " +
              (total === 0
                ? "bg-gray-50 border-gray-200 text-gray-600"
                : unreported === 0
                  ? "bg-green-50 border-green-200 text-green-700"
                  : "bg-amber-50 border-amber-200 text-amber-800")
            }
          >
            {total === 0
              ? "この日の欠品・変更はありません。"
              : unreported === 0
                ? `すべて報告済みです(${total}件)。`
                : `未報告 ${unreported}件 / 全${total}件`}
          </div>

          {/* 欠品 */}
          <section className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
            <h2 className="text-sm font-semibold mb-2">
              欠品({shortages.length}件)
              <span className="text-xs text-gray-500 font-normal ml-2">
                欠品が確定した品目の、ラベルを発行できなかった分
              </span>
            </h2>
            {showS.length === 0 ? (
              <p className="text-sm text-gray-500">該当なし</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 text-left">
                      <th className="py-1 w-8 font-normal print:hidden">済</th>
                      <th className="py-1 pr-2 font-normal">仕入先</th>
                      <th className="py-1 pr-2 font-normal">品名</th>
                      <th className="py-1 pr-2 font-normal">店舗</th>
                      <th className="py-1 px-2 font-normal text-right">注文</th>
                      <th className="py-1 px-2 font-normal text-right">欠品</th>
                      <th className="py-1 pl-2 font-normal print:hidden"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {showS.map((r) => (
                      <tr
                        key={r.store_qty_id}
                        className={"border-t border-gray-100 " + (r.reported_at ? "text-gray-400" : "")}
                      >
                        <td className="py-2">
                          <Check
                            checked={!!r.reported_at}
                            disabled={busy === `s-${r.store_qty_id}`}
                            onChange={() => toggleShortage(r)}
                          />
                        </td>
                        <td className="py-2 pr-2 text-xs">{r.supplier_name}</td>
                        <td className="py-2 pr-2">{r.item_name}</td>
                        <td className="py-2 pr-2">{storeTitle(r.store_code, r.store_name, r.sign)}</td>
                        <td className="py-2 px-2 text-right">
                          {r.pack_size}×{r.ordered_cases}
                        </td>
                        <td className="py-2 px-2 text-right font-semibold text-red-600">
                          {r.pack_size}×{r.shortage_cases}
                        </td>
                        <td className="py-2 pl-2 text-xs text-green-700 print:hidden">
                          {reportedText(r.reported_at, r.reported_by_name)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 数量変更・入数変更 */}
          {(
            [
              { title: "数量変更", rows: showQ, count: qtyChanges.length, unit: "箱" },
              { title: "入数変更", rows: showP, count: packChanges.length, unit: "入" },
              { title: "産地変更", rows: showO, count: originChanges.length, unit: "" },
            ] as const
          ).map((g) => (
            <section key={g.title} className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
              <h2 className="text-sm font-semibold mb-2">
                {g.title}({g.count}件)
              </h2>
              {g.rows.length === 0 ? (
                <p className="text-sm text-gray-500">該当なし</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 text-left">
                        <th className="py-1 w-8 font-normal print:hidden">済</th>
                        <th className="py-1 pr-2 font-normal">仕入先</th>
                        <th className="py-1 pr-2 font-normal">品名</th>
                        <th className="py-1 pr-2 font-normal">店舗</th>
                        <th className="py-1 px-2 font-normal">変更内容</th>
                        <th className="py-1 px-2 font-normal">担当・時刻</th>
                        <th className="py-1 pl-2 font-normal print:hidden"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr
                          key={r.log_id}
                          className={"border-t border-gray-100 " + (r.reported_at ? "text-gray-400" : "")}
                        >
                          <td className="py-2">
                            <Check
                              checked={!!r.reported_at}
                              disabled={busy === `c-${r.log_id}`}
                              onChange={() => toggleChange(r)}
                            />
                          </td>
                          <td className="py-2 pr-2 text-xs">{r.supplier_name}</td>
                          <td className="py-2 pr-2">{r.item_name}</td>
                          <td className="py-2 pr-2">{storeTitle(r.store_code, r.store_name, r.sign)}</td>
                          <td className="py-2 px-2">
                            {r.is_added ? (
                              <span>
                                <b className="text-blue-700">追加</b> {r.pack_size}×{r.new_value}
                              </span>
                            ) : r.is_cancel ? (
                              <span>
                                <b className="text-red-600">取消</b> {r.pack_size}×{r.old_value} → 0
                              </span>
                            ) : g.title === "産地変更" ? (
                              <span>
                                {r.old_value || "なし"} → <b>{r.new_value || "なし"}</b>
                              </span>
                            ) : (
                              <span>
                                {r.old_value}
                                {g.unit} → <b>{r.new_value}</b>
                                {g.unit}
                                {g.title === "数量変更" ? (
                                  <span className="text-xs text-gray-500 ml-1">(入数 {r.pack_size})</span>
                                ) : null}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {formatTime(r.changed_at)} {r.changed_by_name ?? ""}
                          </td>
                          <td className="py-2 pl-2 text-xs text-green-700 print:hidden">
                            {reportedText(r.reported_at, r.reported_by_name)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
