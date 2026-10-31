"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { one } from "@/lib/inbound";

type Supplier = { supplier_code: string; supplier_name: string };

type RawLine = {
  order_line_id: number;
  item_code: string;
  spec: string | null;
  origin: string | null;
  total_display: string | null;
  arrival_status: string;
  m_items: { item_name: string } | { item_name: string }[] | null;
  t_order_line_store_qty: { pack_size: number; case_count: number }[] | null;
  t_arrivals: { case_count: number }[] | null;
};

type LineView = {
  order_line_id: number;
  item_code: string;
  item_name: string;
  spec: string | null;
  origin: string | null;
  total_display: string | null;
  status: string;
  orderedCases: number;
  arrivedCases: number;
};

const STATUS_STYLE: Record<string, string> = {
  未入荷: "text-gray-500",
  一部入荷: "text-amber-600",
  入荷完了: "text-green-600",
  欠品確定: "text-red-600",
};

export default function InboundListPage() {
  const supabase = createClient();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierCode, setSupplierCode] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [lines, setLines] = useState<LineView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // 最初に、仕入先の一覧と、直近に登録された発注データの仕入先・納品日を初期値として取得する
  useEffect(() => {
    (async () => {
      const [{ data: sup }, { data: latest }] = await Promise.all([
        supabase.from("m_suppliers").select("supplier_code, supplier_name").order("supplier_code"),
        supabase
          .from("t_orders")
          .select("supplier_code, target_date")
          .order("created_at", { ascending: false })
          .limit(1),
      ]);
      const list = (sup ?? []) as Supplier[];
      setSuppliers(list);
      const last = ((latest ?? []) as { supplier_code: string; target_date: string }[])[0];
      setSupplierCode(last?.supplier_code ?? list[0]?.supplier_code ?? "");
      setTargetDate(last?.target_date ?? new Date().toISOString().slice(0, 10));
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 仕入先・納品日が決まったら、その発注明細(品目の一覧)を取得する
  useEffect(() => {
    if (!ready || !supplierCode || !targetDate) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("t_order_lines")
        .select(
          "order_line_id, item_code, spec, origin, total_display, arrival_status, " +
            "m_items(item_name), t_orders!inner(supplier_code, target_date), " +
            "t_order_line_store_qty(pack_size, case_count), t_arrivals(case_count)"
        )
        .eq("t_orders.supplier_code", supplierCode)
        .eq("t_orders.target_date", targetDate)
        .order("order_line_id");
      if (cancelled) return;
      if (err) {
        setError("品目の取得に失敗しました: " + err.message);
        setLines([]);
      } else {
        const views = ((data ?? []) as unknown as RawLine[]).map((l) => ({
          order_line_id: l.order_line_id,
          item_code: l.item_code,
          item_name: one(l.m_items)?.item_name ?? l.item_code,
          spec: l.spec,
          origin: l.origin,
          total_display: l.total_display,
          status: l.arrival_status,
          orderedCases: (l.t_order_line_store_qty ?? []).reduce((a, r) => a + r.case_count, 0),
          arrivedCases: (l.t_arrivals ?? []).reduce((a, r) => a + r.case_count, 0),
        }));
        setLines(views);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, supplierCode, targetDate]);

  // 「入荷完了」(全量入荷して全店舗分を発行済み)と「欠品確定」は、通常は一覧から除く
  const isDone = (s: string) => s === "入荷完了" || s === "欠品確定";
  const visible = showAll ? lines : lines.filter((l) => !isDone(l.status));
  const doneCount = lines.filter((l) => isDone(l.status)).length;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">入荷・ラベル発行</h1>
        <div className="flex gap-4">
          <Link href="/inbound/csv" className="text-sm text-brand underline">
            CSV取込
          </Link>
          <Link href="/inbound/capture" className="text-sm text-brand underline">
            画像取込
          </Link>
          <Link href="/inbound/slip" className="text-sm text-brand underline">
            伝票出力
          </Link>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex flex-wrap gap-4 items-end mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">出荷元(仕入先)</label>
            <select
              value={supplierCode}
              onChange={(e) => setSupplierCode(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
            >
              {suppliers.map((s) => (
                <option key={s.supplier_code} value={s.supplier_code}>
                  {s.supplier_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">納品日</label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600 pb-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            入荷確認(入荷済みも表示)
          </label>
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        {loading && <p className="text-sm text-gray-500">読み込み中…</p>}

        {!loading && !error && lines.length === 0 && (
          <p className="text-sm text-gray-500">
            この仕入先・納品日の発注データはありません。先に「発注データ取込(伝票撮影)」で伝票を取り込んでください。
          </p>
        )}

        {lines.length > 0 && (
          <>
            <div className="hidden sm:grid grid-cols-[1.5rem_1fr_6rem_9rem] gap-x-3 text-xs text-gray-500 pb-2 border-b border-gray-200">
              <span />
              <span>品目</span>
              <span>全店計</span>
              <span>入荷済み</span>
            </div>
            <ul>
              {visible.map((l) => (
                <li key={l.order_line_id} className="border-b border-gray-100">
                  <Link
                    href={`/inbound/${l.order_line_id}`}
                    className="grid grid-cols-[1.5rem_1fr] gap-x-2 gap-y-0.5 items-center py-2.5 text-sm hover:bg-gray-50 sm:grid-cols-[1.5rem_1fr_6rem_9rem] sm:gap-x-3"
                  >
                    <span className="text-green-600 text-base leading-none">
                      {isDone(l.status) ? "✓" : ""}
                    </span>
                    <span>
                      {l.item_name}
                      {l.spec ? <span className="text-gray-500"> {l.spec}</span> : null}
                      {l.origin ? (
                        <span className="text-xs text-gray-400 ml-2">産地:{l.origin}</span>
                      ) : null}
                    </span>
                    <span className="col-start-2 flex items-center justify-between gap-3 sm:contents">
                      <span className="text-gray-700 whitespace-nowrap">
                        <span className="sm:hidden text-xs text-gray-400">全店計 </span>
                        {l.total_display ?? ""}
                      </span>
                      <span className={(STATUS_STYLE[l.status] ?? "text-gray-500") + " whitespace-nowrap"}>
                        {l.arrivedCases}/{l.orderedCases}箱
                        {l.status === "一部入荷" && "(一部入荷)"}
                        {l.status === "欠品確定" && "(欠品確定)"}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {visible.length === 0 && (
              <p className="text-sm text-gray-500 py-4">
                すべての品目の入荷が完了しています。
              </p>
            )}
            <p className="text-xs text-gray-500 mt-3">
              未完了 {lines.length - doneCount}品目 / 入荷完了・欠品確定 {doneCount}品目
              {!showAll && doneCount > 0 ? "(非表示)" : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
