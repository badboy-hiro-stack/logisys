"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatTime, storeTitle } from "@/lib/outbound";

type Shortage = {
  id: number;
  supplier_name: string;
  item_name: string;
  store_code: string;
  store_name: string;
  sign: string | null;
  pack_size: number;
  ordered_cases: number;
  shortage_cases: number;
  reported_by_name: string | null;
  reported_at: string | null;
};

type Change = {
  id: number;
  field: string; // pack_size / case_count
  old_value: string | null;
  new_value: string | null;
  supplier_name: string;
  item_name: string;
  store_code: string;
  store_name: string;
  sign: string | null;
  pack_size: number;
  changed_at: string;
  changed_by_name: string | null;
  reported_by_name: string | null;
  reported_at: string | null;
};

type Summary = { shortages: Shortage[]; changes: Change[] };

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 変更内容を、読みやすい文にする
function describeChange(c: Change): string {
  if (c.field === "case_count") {
    if (c.old_value === "0") return `追加:${c.pack_size}×${c.new_value}`;
    if (c.new_value === "0") return `取消(箱数 ${c.old_value} → 0)`;
    return `箱数 ${c.old_value} → ${c.new_value}`;
  }
  return `入数 ${c.old_value} → ${c.new_value}`;
}

export default function ReportsPage() {
  const supabase = createClient();
  const [date, setDate] = useState("");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"report" | "history">("report");
  const [hideReported, setHideReported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    const { data: res, error: e } = await supabase.rpc("report_summary", { p_date: date });
    if (e) {
      setError("取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setData(res as unknown as Summary);
  }, [supabase, date]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function mark(kind: "shortage" | "change", ids: number[], reported: boolean) {
    if (ids.length === 0) return;
    setBusy(true);
    setMessage(null);
    const { error: e } = await supabase.rpc("mark_reported", {
      p_kind: kind,
      p_ids: ids,
      p_reported: reported,
    });
    setBusy(false);
    if (e) {
      setError("更新に失敗しました: " + e.message);
      return;
    }
    await load();
  }

  const shortages = data?.shortages ?? [];
  const qtyChanges = (data?.changes ?? []).filter((c) => c.field === "case_count");
  const packChanges = (data?.changes ?? []).filter((c) => c.field === "pack_size");

  const unreported = useMemo(
    () => ({
      shortage: shortages.filter((r) => !r.reported_at).length,
      qty: qtyChanges.filter((r) => !r.reported_at).length,
      pack: packChanges.filter((r) => !r.reported_at).length,
    }),
    [shortages, qtyChanges, packChanges]
  );
  const unreportedTotal = unreported.shortage + unreported.qty + unreported.pack;

  // 店舗運営部への報告文(未報告の分)を、コピーして使えるようにする
  async function copyText() {
    const st = (r: { store_code: string; store_name: string; sign: string | null }) =>
      storeTitle(r.store_code, r.store_name, r.sign);
    const lines: string[] = [`【当日変更・欠品のご報告】納品日 ${date}`];
    const s = shortages.filter((r) => !r.reported_at);
    if (s.length) {
      lines.push("", "■欠品");
      s.forEach((r) =>
        lines.push(`・${r.item_name}(${r.supplier_name}) ${st(r)} ${r.pack_size}入 ${r.shortage_cases}箱`)
      );
    }
    const q = qtyChanges.filter((r) => !r.reported_at);
    if (q.length) {
      lines.push("", "■数量変更");
      q.forEach((r) => lines.push(`・${r.item_name}(${r.supplier_name}) ${st(r)} ${describeChange(r)}`));
    }
    const p = packChanges.filter((r) => !r.reported_at);
    if (p.length) {
      lines.push("", "■入数変更");
      p.forEach((r) => lines.push(`・${r.item_name}(${r.supplier_name}) ${st(r)} ${describeChange(r)}`));
    }
    if (lines.length === 1) lines.push("", "未報告の項目はありません。");
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setMessage("未報告の内容をコピーしました。メール等に貼り付けてお使いください。");
    } catch {
      setMessage("コピーできませんでした。ブラウザの設定をご確認ください。");
    }
  }

  const visible = <T extends { reported_at: string | null }>(rows: T[]) =>
    hideReported ? rows.filter((r) => !r.reported_at) : rows;

  function ReportedMark({ at, by }: { at: string | null; by: string | null }) {
    if (!at) return null;
    return (
      <span className="text-xs text-gray-400">
        {formatTime(at)} {by ?? ""}
      </span>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <h1 className="text-lg font-semibold">当日変更・欠品 報告</h1>
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
      </div>
      <p className="text-sm text-gray-600 mb-3">
        店舗運営部へ、当日中にお知らせする内容です(仕入先への連絡ではありません)。報告したら「報告済み」にチェックを入れてください。
        翌日には引き継がれません。
      </p>

      <div className="flex gap-2 mb-4">
        {(
          [
            ["report", "報告"],
            ["history", "変更履歴一覧"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={
              "px-4 py-1.5 rounded-lg text-sm border " +
              (tab === k ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 text-gray-700")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">{error}</div>
      )}
      {message && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 mb-3">
          {message}
        </div>
      )}
      {!data && !error && <p className="text-sm text-gray-500">読み込み中…</p>}

      {data && tab === "report" && (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
            <span
              className={
                "px-3 py-1 rounded-full " +
                (unreportedTotal > 0 ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700")
              }
            >
              {unreportedTotal > 0 ? `未報告 ${unreportedTotal}件` : "未報告はありません"}
            </span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={hideReported} onChange={(e) => setHideReported(e.target.checked)} />
              報告済みを隠す
            </label>
            <button
              type="button"
              onClick={copyText}
              className="border border-blue-600 text-blue-600 px-3 py-1 rounded-lg"
            >
              未報告の内容をコピー
            </button>
          </div>

          {/* 欠品 */}
          <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-sm font-semibold">
                欠品({shortages.length}件 / 未報告 {unreported.shortage})
              </h2>
              {unreported.shortage > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    mark("shortage", shortages.filter((r) => !r.reported_at).map((r) => r.id), true)
                  }
                  className="text-xs text-blue-600 disabled:opacity-40"
                >
                  すべて報告済みにする
                </button>
              )}
            </div>
            {visible(shortages).length === 0 ? (
              <p className="text-sm text-gray-500">該当はありません。</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {visible(shortages).map((r) => (
                  <li key={r.id} className="py-2 flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={!!r.reported_at}
                      disabled={busy}
                      onChange={(e) => mark("shortage", [r.id], e.target.checked)}
                      className="mt-1"
                    />
                    <div className={"flex-1 min-w-0 " + (r.reported_at ? "text-gray-400" : "")}>
                      <div>
                        <b>{r.item_name}</b>
                        <span className="text-xs ml-2">{r.supplier_name}</span>
                      </div>
                      <div>
                        {storeTitle(r.store_code, r.store_name, r.sign)}　{r.pack_size}入
                        <span className="text-red-600 font-semibold ml-2">欠品 {r.shortage_cases}箱</span>
                        <span className="text-xs ml-2">(注文 {r.ordered_cases}箱)</span>
                      </div>
                    </div>
                    <ReportedMark at={r.reported_at} by={r.reported_by_name} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 数量変更 / 入数変更 */}
          {(
            [
              ["数量変更", qtyChanges, unreported.qty],
              ["入数変更", packChanges, unreported.pack],
            ] as const
          ).map(([title, rows, un]) => (
            <section key={title} className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-sm font-semibold">
                  {title}({rows.length}件 / 未報告 {un})
                </h2>
                {un > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => mark("change", rows.filter((r) => !r.reported_at).map((r) => r.id), true)}
                    className="text-xs text-blue-600 disabled:opacity-40"
                  >
                    すべて報告済みにする
                  </button>
                )}
              </div>
              {visible(rows).length === 0 ? (
                <p className="text-sm text-gray-500">該当はありません。</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {visible(rows).map((r) => (
                    <li key={r.id} className="py-2 flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={!!r.reported_at}
                        disabled={busy}
                        onChange={(e) => mark("change", [r.id], e.target.checked)}
                        className="mt-1"
                      />
                      <div className={"flex-1 min-w-0 " + (r.reported_at ? "text-gray-400" : "")}>
                        <div>
                          <b>{r.item_name}</b>
                          <span className="text-xs ml-2">{r.supplier_name}</span>
                        </div>
                        <div>
                          {storeTitle(r.store_code, r.store_name, r.sign)}　{describeChange(r)}
                          <span className="text-xs ml-2">
                            ({formatTime(r.changed_at)} {r.changed_by_name ?? ""})
                          </span>
                        </div>
                      </div>
                      <ReportedMark at={r.reported_at} by={r.reported_by_name} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      )}

      {data && tab === "history" && (
        <section className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-2">この日の変更履歴({data.changes.length}件)</h2>
          {data.changes.length === 0 ? (
            <p className="text-sm text-gray-500">この納品日に行われた変更はありません。</p>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {data.changes.map((c) => (
                <li key={c.id} className="py-2">
                  <div className="text-xs text-gray-500">
                    {new Date(c.changed_at).toLocaleString("ja-JP")}　{c.changed_by_name ?? ""}　{c.supplier_name}
                  </div>
                  <div>
                    <b>{c.item_name}</b>　{storeTitle(c.store_code, c.store_name, c.sign)}　{describeChange(c)}
                    {c.reported_at && <span className="text-xs text-green-700 ml-2">報告済み</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
