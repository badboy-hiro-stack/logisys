"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { one, slipOrderIndex } from "@/lib/inbound";
import { storeTitle } from "@/lib/outbound";

type Store = { store_code: string; store_name: string; sign: string | null };

type LineInfo = {
  order_line_id: number;
  item_code: string;
  total_display: string | null;
  arrival_status: string;
  m_items: { item_name: string } | { item_name: string }[] | null;
  t_orders:
    | { target_date: string; m_suppliers: { supplier_name: string } | { supplier_name: string }[] | null }
    | { target_date: string; m_suppliers: { supplier_name: string } | { supplier_name: string }[] | null }[]
    | null;
};

type DbRow = { id: number; store_code: string; pack_size: number; case_count: number };

// 画面で編集する行(id がなければ、新しく追加する行)
type EditRow = {
  key: string;
  id: number | null;
  store_code: string;
  pack_size: number;
  case_count: number;
  orig_pack: number;
  orig_cases: number;
};

type LogRow = {
  log_id: number;
  order_line_store_qty_id: number;
  changed_field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  m_users: { user_name: string } | { user_name: string }[] | null;
};

const NUM = "border border-gray-300 rounded px-1.5 py-1 text-sm text-right";

export default function ChangeEditPage() {
  const supabase = createClient();
  const router = useRouter();
  const params = useParams<{ orderLineId: string }>();
  const lineId = Number(params.orderLineId);

  const [stores, setStores] = useState<Store[]>([]);
  const [info, setInfo] = useState<LineInfo | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [arrivedCases, setArrivedCases] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [st, li, sq, lab, arr] = await Promise.all([
      supabase.from("m_stores").select("store_code, store_name, sign"),
      supabase
        .from("t_order_lines")
        .select(
          "order_line_id, item_code, total_display, arrival_status, m_items(item_name), t_orders(target_date, m_suppliers(supplier_name))"
        )
        .eq("order_line_id", lineId)
        .maybeSingle(),
      supabase
        .from("t_order_line_store_qty")
        .select("id, store_code, pack_size, case_count")
        .eq("order_line_id", lineId),
      supabase
        .from("v_labels")
        .select("label_id", { count: "exact", head: true })
        .eq("order_line_id", lineId)
        .neq("status", "無効"),
      supabase.from("t_arrivals").select("case_count").eq("order_line_id", lineId),
    ]);

    if (li.error || !li.data) {
      setError("品目の情報を取得できませんでした。");
      setLoading(false);
      return;
    }
    if (sq.error) {
      setError("店舗別の数量を取得できませんでした: " + sq.error.message);
      setLoading(false);
      return;
    }

    setStores(
      ((st.data ?? []) as unknown as Store[]).sort(
        (a, b) => slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code)
      )
    );
    setInfo(li.data as unknown as LineInfo);
    setLocked((lab.count ?? 0) > 0);
    setArrivedCases(
      ((arr.data ?? []) as unknown as { case_count: number }[]).reduce((s, r) => s + r.case_count, 0)
    );

    const dbRows = ((sq.data ?? []) as unknown as DbRow[]).sort(
      (a, b) => slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code) || a.id - b.id
    );
    setRows(
      dbRows.map((r) => ({
        key: `db-${r.id}`,
        id: r.id,
        store_code: r.store_code,
        pack_size: r.pack_size,
        case_count: r.case_count,
        orig_pack: r.pack_size,
        orig_cases: r.case_count,
      }))
    );

    // この品目の変更履歴
    const ids = dbRows.map((r) => r.id);
    if (ids.length > 0) {
      const { data: lg } = await supabase
        .from("t_order_edit_logs")
        .select("log_id, order_line_store_qty_id, changed_field, old_value, new_value, changed_at, m_users(user_name)")
        .in("order_line_store_qty_id", ids)
        .order("changed_at", { ascending: false });
      setLogs((lg ?? []) as unknown as LogRow[]);
    } else {
      setLogs([]);
    }
    setLoading(false);
  }, [supabase, lineId]);

  useEffect(() => {
    load();
  }, [load]);

  const storeName = useMemo(() => {
    const m = new Map<string, Store>();
    stores.forEach((s) => m.set(s.store_code, s));
    return (code: string) => {
      const s = m.get(code);
      return s ? storeTitle(s.store_code, s.store_name, s.sign) : code;
    };
  }, [stores]);

  function update(key: string, patch: Partial<EditRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const used = new Set(rows.map((r) => r.store_code));
    const cand = stores.find((s) => !used.has(s.store_code)) ?? stores[0];
    if (!cand) return;
    const last = rows[rows.length - 1];
    setRows((rs) => [
      ...rs,
      {
        key: `new-${Date.now()}-${rs.length}`,
        id: null,
        store_code: cand.store_code,
        pack_size: last?.pack_size ?? 0,
        case_count: 0,
        orig_pack: 0,
        orig_cases: 0,
      },
    ]);
  }

  function removeNew(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  const isChanged = (r: EditRow) =>
    r.id === null ? r.case_count > 0 : r.pack_size !== r.orig_pack || r.case_count !== r.orig_cases;
  const changedRows = rows.filter(isChanged);
  const hasInvalid = rows.some(
    (r) => r.pack_size < 1 || r.case_count < 0 || !Number.isInteger(r.pack_size) || !Number.isInteger(r.case_count)
  );

  const newTotalQty = rows.reduce((s, r) => s + r.pack_size * r.case_count, 0);
  const oldTotalQty = rows.reduce((s, r) => s + r.orig_pack * r.orig_cases, 0);

  async function save() {
    if (changedRows.length === 0 || hasInvalid) return;
    if (!window.confirm(`${changedRows.length}件の変更を保存します。よろしいですか?`)) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    const payload = rows.map((r) => ({
      id: r.id,
      store_code: r.store_code,
      pack_size: r.pack_size,
      case_count: r.case_count,
    }));
    const { data, error: e } = await supabase.rpc("update_order_line_qty", {
      p_order_line_id: lineId,
      p_rows: payload,
    });
    setSaving(false);
    if (e) {
      setError("保存に失敗しました: " + e.message);
      return;
    }
    const res = data as { result: string } | null;
    if (res?.result === "ok") {
      setMessage("保存しました。変更履歴に記録されています。");
      setLoading(true);
      await load();
    } else if (res?.result === "locked") {
      setError("この品目はラベルが発行済みのため、変更できません。");
      setLocked(true);
    } else if (res?.result === "no_change") {
      setMessage("変更はありませんでした。");
    } else {
      setError("保存できませんでした。");
    }
  }

  if (loading) return <p className="text-sm text-gray-500">読み込み中…</p>;
  if (!info) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-red-600 mb-3">{error ?? "品目が見つかりません。"}</p>
        <Link href="/changes" className="text-sm text-blue-600">
          ← 対象選択に戻る
        </Link>
      </div>
    );
  }

  const itemName = one(info.m_items)?.item_name ?? info.item_code;
  const ord = one(info.t_orders);
  const supplierName = ord ? one(ord.m_suppliers)?.supplier_name ?? "" : "";

  return (
    <div className="max-w-3xl">
      <Link href="/changes" className="text-sm text-blue-600">
        ← 対象選択に戻る
      </Link>
      <h1 className="text-lg font-semibold mt-2 mb-1">当日変更:編集</h1>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 text-sm">
        <div className="text-xs text-gray-500">
          {supplierName}　納品日 {ord?.target_date ?? ""}　{info.item_code}
        </div>
        <div className="text-base font-semibold">{itemName}</div>
        <div className="text-gray-600 mt-1">
          全店計(現在): <b>{info.total_display ?? "-"}</b>　入荷状況: {info.arrival_status}
          {arrivedCases > 0 ? `(入荷済み ${arrivedCases}箱)` : ""}
        </div>
        {arrivedCases > 0 && (
          <p className="text-xs text-amber-700 mt-2">
            ※ すでに入荷の記録があります。数量を変えると、入荷状況の表示(入荷完了/一部入荷)が、変更後の数量とずれることがあります。入荷画面で確認してください。
          </p>
        )}
      </div>

      {locked && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-3 mb-4">
          🔒 この品目は、ラベルが発行済みのため編集できません。内容の確認だけできます。
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">{error}</div>
      )}
      {message && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 mb-4">
          {message}
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold mb-2">店舗別の数量</h2>
        <ul className="space-y-2">
          {rows.map((r) => {
            const cancelled = r.id !== null && r.case_count === 0;
            const changed = isChanged(r);
            return (
              <li
                key={r.key}
                className={
                  "flex flex-wrap items-center gap-2 border rounded-lg px-3 py-2 text-sm " +
                  (changed ? "border-blue-300 bg-blue-50" : "border-gray-200")
                }
              >
                {r.id === null ? (
                  <select
                    value={r.store_code}
                    onChange={(e) => update(r.key, { store_code: e.target.value })}
                    disabled={locked}
                    className="border border-gray-300 rounded px-1.5 py-1 text-sm w-40"
                  >
                    {stores.map((s) => (
                      <option key={s.store_code} value={s.store_code}>
                        {storeTitle(s.store_code, s.store_name, s.sign)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={"w-40 " + (cancelled ? "line-through text-gray-400" : "")}>
                    {storeName(r.store_code)}
                  </span>
                )}
                <input
                  type="number"
                  value={r.pack_size}
                  onChange={(e) => update(r.key, { pack_size: Number(e.target.value) })}
                  disabled={locked}
                  title="入数"
                  className={NUM + " w-16"}
                />
                <span>×</span>
                <input
                  type="number"
                  value={r.case_count}
                  onChange={(e) => update(r.key, { case_count: Number(e.target.value) })}
                  disabled={locked}
                  title="箱数"
                  className={NUM + " w-16"}
                />
                {changed && r.id !== null && (
                  <span className="text-xs text-blue-700">
                    (変更前 {r.orig_pack}×{r.orig_cases})
                  </span>
                )}
                {r.id === null && <span className="text-xs text-blue-700">追加</span>}
                {!locked && (
                  <span className="ml-auto flex gap-2">
                    {r.id === null ? (
                      <button
                        type="button"
                        onClick={() => removeNew(r.key)}
                        className="text-xs text-gray-500 hover:text-red-600"
                      >
                        ✕ 取り消す
                      </button>
                    ) : cancelled ? (
                      <button
                        type="button"
                        onClick={() => update(r.key, { case_count: r.orig_cases || 1, pack_size: r.orig_pack })}
                        className="text-xs text-blue-600"
                      >
                        元に戻す
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => update(r.key, { case_count: 0 })}
                        className="text-xs text-gray-500 hover:text-red-600"
                        title="この店舗の注文を取り消す(箱数を0にします)"
                      >
                        注文を取り消す
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {!locked && (
          <button type="button" onClick={addRow} className="mt-2 text-sm text-blue-600 hover:underline">
            + 店舗を追加
          </button>
        )}

        <div className="mt-3 text-sm text-gray-600">
          合計(個数): 変更前 {oldTotalQty.toLocaleString()} → 変更後{" "}
          <b className={newTotalQty !== oldTotalQty ? "text-blue-700" : ""}>{newTotalQty.toLocaleString()}</b>
        </div>

        {!locked && (
          <button
            type="button"
            onClick={save}
            disabled={saving || changedRows.length === 0 || hasInvalid}
            className="mt-3 w-full bg-blue-600 text-white text-sm font-semibold px-4 py-3 rounded-lg disabled:opacity-40"
          >
            {saving ? "保存しています…" : `変更を保存する(${changedRows.length}件)`}
          </button>
        )}
        {hasInvalid && <p className="text-xs text-red-600 mt-1">入数は1以上、箱数は0以上の整数で入力してください。</p>}
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-2">この品目の変更履歴</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-gray-500">変更履歴はありません。</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {logs.map((g) => {
              const row = rows.find((r) => r.id === g.order_line_store_qty_id);
              return (
                <li key={g.log_id} className="py-1.5">
                  <div className="text-xs text-gray-500">
                    {new Date(g.changed_at).toLocaleString("ja-JP")}　{one(g.m_users)?.user_name ?? ""}
                  </div>
                  <div>
                    {row ? storeName(row.store_code) : ""}　
                    {g.changed_field === "case_count" ? "箱数" : g.changed_field === "pack_size" ? "入数" : g.changed_field}
                    : {g.old_value} → <b>{g.new_value}</b>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mt-4">
        <button type="button" onClick={() => router.push("/changes")} className="text-sm text-gray-500">
          閉じる
        </button>
      </div>
    </div>
  );
}
