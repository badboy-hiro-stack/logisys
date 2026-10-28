/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { buildSlipBuffer, downloadBuffer, slipFileName, type SlipData, type SlipItem } from "@/lib/slip";

type Vendor = {
  code: string;
  name: string;
  orderIds: string[];
};

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function SlipPage() {
  const supabase = useMemo(() => createClient(), []);
  const [date, setDate] = useState(today());
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    const { data, error } = await supabase
      .from("t_orders")
      .select("order_id, supplier_code, m_suppliers(supplier_name)")
      .eq("target_date", date)
      .order("supplier_code", { ascending: true });
    if (error) {
      setMsg(`読み込みエラー: ${error.message}`);
      setVendors([]);
      setLoading(false);
      return;
    }
    const map = new Map<string, Vendor>();
    for (const o of (data ?? []) as any[]) {
      const sp = Array.isArray(o.m_suppliers) ? o.m_suppliers[0] : o.m_suppliers;
      const v: Vendor = map.get(o.supplier_code) ?? {
        code: o.supplier_code,
        name: sp?.supplier_name ?? o.supplier_code,
        orderIds: [],
      };
      v.orderIds.push(o.order_id);
      map.set(o.supplier_code, v);
    }
    setVendors([...map.values()]);
    setLoading(false);
  }, [supabase, date]);

  useEffect(() => {
    load();
  }, [load]);

  async function collect(v: Vendor): Promise<SlipData> {
    const { data: lines, error: le } = await supabase
      .from("t_order_lines")
      .select("order_line_id, item_code, spec, origin")
      .in("order_id", v.orderIds);
    if (le) throw new Error(le.message);
    const ls = (lines ?? []) as any[];

    // 品目名
    const codes = [...new Set(ls.map((l) => String(l.item_code)))];
    const names = new Map<string, string>();
    for (let i = 0; i < codes.length; i += 100) {
      const { data: its } = await supabase
        .from("m_items")
        .select("item_code, item_name")
        .in("item_code", codes.slice(i, i + 100));
      for (const it of (its ?? []) as any[]) names.set(String(it.item_code), it.item_name ?? "");
    }

    // 店別数量(1000行制限を避けるため分割取得)
    const byLine = new Map<number, any[]>();
    for (let i = 0; i < ls.length; i += 50) {
      const ids = ls.slice(i, i + 50).map((l) => l.order_line_id);
      const { data: qs, error: qe } = await supabase
        .from("t_order_line_store_qty")
        .select("order_line_id, store_code, pack_size, case_count")
        .in("order_line_id", ids)
        .limit(5000);
      if (qe) throw new Error(qe.message);
      for (const q of (qs ?? []) as any[]) {
        const arr = byLine.get(q.order_line_id) ?? [];
        arr.push(q);
        byLine.set(q.order_line_id, arr);
      }
    }

    // 同じ 品目コード+産地+規格 は1行にまとめる
    const items = new Map<string, SlipItem>();
    for (const l of ls) {
      const eos = String(l.item_code);
      const origin = l.origin ?? "";
      const spec = l.spec ?? "";
      const key = `${eos}|${origin}|${spec}`;
      const it: SlipItem =
        items.get(key) ?? { eos, origin, name: names.get(eos) ?? "", spec, stores: {} };
      for (const q of byLine.get(l.order_line_id) ?? []) {
        const sc = String(q.store_code);
        const pack = Number(q.pack_size) || 1;
        const cur: Record<number, number> = it.stores[sc] ?? {};
        cur[pack] = (cur[pack] ?? 0) + (Number(q.case_count) || 0);
        it.stores[sc] = cur;
      }
      items.set(key, it);
    }
    return { vendorCode: v.code, vendorName: v.name, targetDate: date, items: [...items.values()] };
  }

  async function output(v: Vendor) {
    setBusy(v.code);
    setMsg("");
    try {
      const data = await collect(v);
      const buf = await buildSlipBuffer(data);
      downloadBuffer(buf, slipFileName(data));
      setMsg(`${v.name} の伝票を出力しました(${data.items.length}品目)`);
    } catch (e) {
      setMsg(`出力エラー: ${(e as Error).message}`);
    }
    setBusy("");
  }

  async function outputAll() {
    for (const v of vendors) {
      await output(v);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">仕分け伝票の出力(Excel)</h1>
        <Link href="/inbound" className="text-sm text-blue-600 underline">
          ← 入荷・ラベル発行へ
        </Link>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm">納品日</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border px-2 py-1"
        />
        <button onClick={load} className="rounded border px-3 py-1 text-sm">
          再読み込み
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : vendors.length === 0 ? (
        <p className="text-sm text-gray-500">この納品日の発注はありません。</p>
      ) : (
        <>
          <ul className="mb-4 divide-y rounded border">
            {vendors.map((v) => (
              <li key={v.code} className="flex items-center justify-between p-3">
                <div>
                  <div className="font-medium">{v.name}</div>
                  <div className="text-xs text-gray-500">
                    ベンダーコード {v.code} / 発注 {v.orderIds.length}件
                  </div>
                </div>
                <button
                  onClick={() => output(v)}
                  disabled={busy !== ""}
                  className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {busy === v.code ? "作成中…" : "伝票を出力"}
                </button>
              </li>
            ))}
          </ul>
          {vendors.length > 1 && (
            <button
              onClick={outputAll}
              disabled={busy !== ""}
              className="rounded border px-4 py-2 text-sm disabled:opacity-50"
            >
              すべてのベンダーを出力
            </button>
          )}
        </>
      )}
      {msg && <p className="mt-4 text-sm">{msg}</p>}
    </div>
  );
}
