"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { one, slipOrderIndex } from "@/lib/inbound";
import { storeTitle } from "@/lib/outbound";

type Store = { store_code: string; store_name: string; sign: string | null };
type OrderOpt = { order_id: string; supplier_code: string; supplier_name: string; page_no: number | null };
type Item = {
  item_code: string;
  item_name: string;
  default_spec: string | null;
  default_pack_size: number | null;
  loose_case_size: number | null;
  default_origin: string | null;
};
type QtyRow = { key: string; store_code: string; pack_size: number; case_count: number };

const NUM = "border border-gray-300 rounded px-1.5 py-1 text-sm text-right";
const TXT = "border border-gray-300 rounded px-2 py-1 text-sm";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AddOrderLinePage() {
  const supabase = useMemo(() => createClient(), []);
  const [date, setDate] = useState("");
  const [orders, setOrders] = useState<OrderOpt[]>([]);
  const [orderId, setOrderId] = useState("");
  const [stores, setStores] = useState<Store[]>([]);

  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [item, setItem] = useState<Item | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");

  const [spec, setSpec] = useState("");
  const [origin, setOrigin] = useState("");
  const [rows, setRows] = useState<QtyRow[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneLineId, setDoneLineId] = useState<number | null>(null);
  const [doneText, setDoneText] = useState("");

  // 最新の納品日を初期値にする
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("t_orders")
        .select("target_date")
        .order("target_date", { ascending: false })
        .limit(1);
      const last = ((data ?? []) as unknown as { target_date: string }[])[0];
      setDate(last?.target_date ?? todayLocal());
      const { data: st } = await supabase.from("m_stores").select("store_code, store_name, sign");
      setStores(
        ((st ?? []) as unknown as Store[]).sort(
          (a, b) => slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code)
        )
      );
    })();
  }, [supabase]);

  const loadOrders = useCallback(async () => {
    if (!date) return;
    const { data, error: e } = await supabase
      .from("t_orders")
      .select("order_id, supplier_code, page_no, m_suppliers(supplier_name)")
      .eq("target_date", date)
      .order("supplier_code", { ascending: true });
    if (e) {
      setError("発注の取得に失敗しました: " + e.message);
      return;
    }
    const list = ((data ?? []) as unknown as {
      order_id: string;
      supplier_code: string;
      page_no: number | null;
      m_suppliers: { supplier_name: string } | { supplier_name: string }[] | null;
    }[]).map((o) => ({
      order_id: o.order_id,
      supplier_code: o.supplier_code,
      supplier_name: one(o.m_suppliers)?.supplier_name ?? o.supplier_code,
      page_no: o.page_no,
    }));
    setOrders(list);
    setOrderId((cur) => (list.some((o) => o.order_id === cur) ? cur : list[0]?.order_id ?? ""));
  }, [supabase, date]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  async function search() {
    const k = q.trim().replace(/[%,()]/g, "");
    if (!k) {
      setResults([]);
      return;
    }
    const { data, error: e } = await supabase
      .from("m_items")
      .select("item_code, item_name, default_spec, default_pack_size, loose_case_size, default_origin")
      .or(`item_code.ilike.%${k}%,item_name.ilike.%${k}%`)
      .order("item_code", { ascending: true })
      .limit(20);
    if (e) {
      setError("品目の検索に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setResults((data ?? []) as unknown as Item[]);
  }

  function pickItem(it: Item) {
    setItem(it);
    setIsNew(false);
    setSpec(it.default_spec ?? "");
    setOrigin(it.default_origin ?? "");
    const pack = it.loose_case_size ? 1 : it.default_pack_size ?? 0;
    setRows([{ key: "r0", store_code: stores[0]?.store_code ?? "", pack_size: pack, case_count: 0 }]);
    setResults([]);
    setDoneLineId(null);
  }

  function startNew() {
    setItem(null);
    setIsNew(true);
    setNewCode("");
    setNewName("");
    setSpec("");
    setOrigin("");
    setRows([{ key: "r0", store_code: stores[0]?.store_code ?? "", pack_size: 0, case_count: 0 }]);
    setResults([]);
    setDoneLineId(null);
  }

  function addRow() {
    const used = new Set(rows.map((r) => r.store_code));
    const cand = stores.find((s) => !used.has(s.store_code)) ?? stores[0];
    if (!cand) return;
    const last = rows[rows.length - 1];
    setRows((rs) => [
      ...rs,
      { key: `r${Date.now()}-${rs.length}`, store_code: cand.store_code, pack_size: last?.pack_size ?? 0, case_count: 0 },
    ]);
  }

  function updateRow(key: string, patch: Partial<QtyRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const target = isNew ? { code: newCode.trim(), name: newName.trim() } : item ? { code: item.item_code, name: item.item_name } : null;
  const validRows = rows.filter((r) => r.case_count > 0);
  const hasInvalid = rows.some(
    (r) =>
      r.case_count > 0 &&
      (r.pack_size < 1 || !Number.isInteger(r.pack_size) || !Number.isInteger(r.case_count))
  );
  const dupStore = new Set(rows.filter((r) => r.case_count > 0).map((r) => `${r.store_code}|${r.pack_size}`)).size !== validRows.length;
  const canSave = !!orderId && !!target && target.code !== "" && target.name !== "" && validRows.length > 0 && !hasInvalid && !dupStore && !saving;
  const totalQty = validRows.reduce((s, r) => s + r.pack_size * r.case_count, 0);

  async function save() {
    if (!canSave || !target) return;
    const ord = orders.find((o) => o.order_id === orderId);
    if (
      !window.confirm(
        `${ord?.supplier_name ?? ""}(納品日 ${date})に、\n${target.code} ${target.name}(${validRows.length}店舗、合計${totalQty}個)を追加します。よろしいですか?`
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const { data: ex } = await supabase.from("m_items").select("item_code").eq("item_code", target.code).maybeSingle();
        if (ex) throw new Error(`品目コード ${target.code} はすでにマスタにあります。検索して選んでください。`);
        const { error: ie } = await supabase.from("m_items").insert({
          item_code: target.code,
          item_name: target.name,
          default_spec: spec.trim() || null,
          default_pack_size: validRows[0]?.pack_size || null,
        });
        if (ie) throw new Error("品目マスタへの登録に失敗しました: " + ie.message);
      }
      const { data, error: e } = await supabase.rpc("add_order_line", {
        p_order_id: orderId,
        p_item_code: target.code,
        p_spec: spec.trim(),
        p_origin: origin.trim(),
        p_rows: validRows.map((r) => ({ store_code: r.store_code, pack_size: r.pack_size, case_count: r.case_count })),
      });
      if (e) throw new Error(e.message);
      const res = data as { result: string; order_line_id?: number } | null;
      if (res?.result === "ok" && res.order_line_id) {
        setDoneLineId(res.order_line_id);
        setDoneText(`${target.code} ${target.name} を追加しました(${validRows.length}店舗、合計${totalQty}個)。`);
        setItem(null);
        setIsNew(false);
        setRows([]);
        setQ("");
      } else if (res?.result === "duplicate") {
        setDoneLineId(res.order_line_id ?? null);
        throw new Error("同じ品目・規格・産地の明細がすでに発注にあります。「当日変更」で数量を変更してください。");
      } else {
        throw new Error("追加できませんでした(" + (res?.result ?? "不明") + ")");
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  }

  return (
    <div className="max-w-3xl">
      <Link href="/changes" className="text-sm text-blue-600">
        ← 当日変更に戻る
      </Link>
      <h1 className="text-lg font-semibold mt-2 mb-1">当日変更:品目を追加</h1>
      <p className="text-sm text-gray-600 mb-4">
        登録済みの発注に、当日になって増えた品目を追加します。追加した品目は、入荷・ラベル発行・出荷検品・仕分け伝票に、ほかの品目と同じように出ます。変更の履歴にも「追加」として残ります。
      </p>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">{error}</div>}
      {doneText && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 mb-4">
          {doneText}
          {doneLineId && (
            <span className="ml-2">
              <Link href={`/inbound/${doneLineId}`} className="underline">
                入荷・ラベル発行へ
              </Link>
              {"　"}
              <Link href={`/changes/${doneLineId}`} className="underline">
                数量を確認・変更
              </Link>
            </span>
          )}
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold mb-2">1. 追加する発注</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            納品日
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={TXT} />
          </label>
          <label className="flex items-center gap-2">
            仕入先
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className={TXT}>
              {orders.length === 0 && <option value="">この日の発注はありません</option>}
              {orders.map((o) => (
                <option key={o.order_id} value={o.order_id}>
                  {o.supplier_name}
                  {orders.filter((x) => x.supplier_code === o.supplier_code).length > 1 ? `(${o.order_id})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold mb-2">2. 品目</h2>
        <div className="flex gap-2 mb-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
            }}
            placeholder="品目コードまたは品名で検索"
            className={TXT + " flex-1"}
          />
          <button type="button" onClick={search} className="border border-gray-300 rounded px-3 text-sm">
            検索
          </button>
        </div>
        {results.length > 0 && (
          <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-2 text-sm">
            {results.map((it) => (
              <li key={it.item_code}>
                <button type="button" onClick={() => pickItem(it)} className="w-full text-left px-3 py-2 hover:bg-blue-50">
                  <b>{it.item_code}</b>　{it.item_name}
                  {it.default_spec ? `　${it.default_spec}` : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.trim() && results.length === 0 && !item && !isNew && (
          <p className="text-xs text-gray-500 mb-2">検索ボタン(またはEnter)で探します。見つからないときは、下の「マスタにない品目を登録」を使います。</p>
        )}
        <button type="button" onClick={startNew} className="text-sm text-blue-600 hover:underline">
          + マスタにない品目を登録して追加する
        </button>

        {item && (
          <div className="mt-3 text-sm bg-blue-50 border border-blue-200 rounded-lg p-3">
            選択中: <b>{item.item_code}</b>　{item.item_name}
            {item.loose_case_size ? (
              <p className="text-xs text-amber-700 mt-1">
                株数管理品です。入数は1、箱数の欄に<b>株の数</b>を入れてください。
              </p>
            ) : null}
          </div>
        )}
        {isNew && (
          <div className="mt-3 text-sm bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
            <p className="text-xs text-gray-600">品目マスタに新しく登録します。</p>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-1">
                コード(EOS)
                <input value={newCode} onChange={(e) => setNewCode(e.target.value)} className={TXT + " w-28"} />
              </label>
              <label className="flex items-center gap-1">
                品名
                <input value={newName} onChange={(e) => setNewName(e.target.value)} className={TXT + " w-56"} />
              </label>
            </div>
          </div>
        )}
      </section>

      {(item || isNew) && (
        <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold mb-2">3. 規格・産地・店舗別の数量</h2>
          <div className="flex flex-wrap gap-3 mb-3 text-sm">
            <label className="flex items-center gap-1">
              規格
              <input value={spec} onChange={(e) => setSpec(e.target.value)} className={TXT + " w-32"} />
            </label>
            <label className="flex items-center gap-1">
              産地
              <input value={origin} onChange={(e) => setOrigin(e.target.value)} className={TXT + " w-40"} />
            </label>
          </div>
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-sm">
                <select
                  value={r.store_code}
                  onChange={(e) => updateRow(r.key, { store_code: e.target.value })}
                  className="border border-gray-300 rounded px-1.5 py-1 text-sm w-40"
                >
                  {stores.map((s) => (
                    <option key={s.store_code} value={s.store_code}>
                      {storeTitle(s.store_code, s.store_name, s.sign)}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  value={r.pack_size}
                  onChange={(e) => updateRow(r.key, { pack_size: Number(e.target.value) })}
                  title="入数"
                  className={NUM + " w-16"}
                />
                <span>×</span>
                <input
                  type="number"
                  value={r.case_count}
                  onChange={(e) => updateRow(r.key, { case_count: Number(e.target.value) })}
                  title="箱数"
                  className={NUM + " w-16"}
                />
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  className="ml-auto text-xs text-gray-500 hover:text-red-600"
                >
                  ✕ 削除
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={addRow} className="mt-2 text-sm text-blue-600 hover:underline">
            + 店舗を追加
          </button>
          <div className="mt-3 text-sm text-gray-600">
            合計(個数): <b>{totalQty.toLocaleString()}</b>(箱数が0の行は追加しません)
          </div>
          {hasInvalid && <p className="text-xs text-red-600 mt-1">入数は1以上の整数、箱数は整数で入力してください。</p>}
          {dupStore && <p className="text-xs text-red-600 mt-1">同じ店舗・同じ入数の行が重なっています。まとめてください。</p>}
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="mt-3 w-full bg-blue-600 text-white text-sm font-semibold px-4 py-3 rounded-lg disabled:opacity-40"
          >
            {saving ? "追加しています…" : "この品目を発注に追加する"}
          </button>
        </section>
      )}
    </div>
  );
}
