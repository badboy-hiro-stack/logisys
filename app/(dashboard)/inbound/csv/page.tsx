"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/** 他業者が納品する店舗。CSVにあっても取り込まない */
const IGNORE_STORES = ["70", "71", "72", "75"];

type Row = {
  vendor: string;
  vendorName: string;
  date: string; // YYYY-MM-DD
  store: string;
  eos: string;
  name: string;
  spec: string;
  origin: string;
  units: number; // 発注ユニット数 = 箱数
  pack: number; // 発注単位 = 入数
  qty: number; // 発注数
};
type Group = {
  key: string;
  vendor: string;
  vendorName: string;
  date: string;
  rows: Row[];
  existing: number; // 既に登録済みの発注件数
};

/** 引用符対応の簡易CSVパーサ */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((v) => v !== "")) out.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((v) => v !== "")) out.push(row);
  return out;
}

const fmtDate = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export default function CsvImportPage() {
  const router = useRouter();
  const supabase = createClient();

  const [fileName, setFileName] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [ignored, setIgnored] = useState<Record<string, number>>({});
  const [unknownStores, setUnknownStores] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [newItems, setNewItems] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [supplierNames, setSupplierNames] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase
      .from("m_suppliers")
      .select("supplier_code, supplier_name")
      .then(({ data }) => {
        const m: Record<string, string> = {};
        (data ?? []).forEach((s: { supplier_code: string; supplier_name: string }) => {
          m[s.supplier_code] = s.supplier_name;
        });
        setSupplierNames(m);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setDone(null);
    setGroups([]);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      // 発注元CSVはShift_JIS。UTF-8の場合も一応判定する
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder("shift_jis").decode(buf);
      }
      text = text.replace(/^﻿/, "");
      const table = parseCsv(text);
      if (table.length < 2) throw new Error("データ行がありません");
      const h = table[0].map((s) => s.trim());
      const col = (n: string) => {
        const i = h.indexOf(n);
        if (i < 0) throw new Error(`列「${n}」が見つかりません。発注元のオーダーCSVか確認してください`);
        return i;
      };
      const ci = {
        vendor: col("ベンダーコード"),
        vendorName: col("ベンダー名"),
        date: col("納品予定日"),
        store: col("店コード"),
        eos: col("EOSコード"),
        name: col("商品名"),
        spec: col("規格名"),
        origin: col("メーカー名"),
        units: col("発注ユニット数"),
        pack: col("発注単位"),
        qty: col("発注数"),
        kind: col("データ区分"),
      };

      // 店舗マスタ
      const { data: stores } = await supabase.from("m_stores").select("store_code");
      const storeSet = new Set((stores ?? []).map((s: { store_code: string }) => s.store_code));

      const ign: Record<string, number> = {};
      const unk = new Set<string>();
      const warn: string[] = [];
      const rows: Row[] = [];
      table.slice(1).forEach((r, n) => {
        const line = n + 2;
        const store = (r[ci.store] ?? "").trim();
        if (IGNORE_STORES.includes(store)) {
          ign[store] = (ign[store] ?? 0) + 1;
          return;
        }
        if (!storeSet.has(store)) {
          unk.add(store);
          return;
        }
        const units = Number(r[ci.units]);
        const pack = Number(r[ci.pack]);
        const qty = Number(r[ci.qty]);
        if (!(units > 0) || !(pack > 0)) {
          warn.push(`${line}行目: 数量が不正のため除外(${r[ci.name]} 店${store})`);
          return;
        }
        if (units * pack !== qty) {
          warn.push(`${line}行目: 入数×箱数(${pack}×${units})が発注数(${qty})と一致しません(${r[ci.name]} 店${store})`);
        }
        if ((r[ci.kind] ?? "").trim() !== "1") {
          warn.push(`${line}行目: データ区分が「${r[ci.kind]}」です(通常は1)。内容を確認してください`);
        }
        rows.push({
          vendor: r[ci.vendor].trim(),
          vendorName: r[ci.vendorName].trim(),
          date: fmtDate(r[ci.date].trim()),
          store,
          eos: r[ci.eos].trim(),
          name: r[ci.name].trim(),
          spec: (r[ci.spec] ?? "").trim(),
          origin: (r[ci.origin] ?? "").trim(),
          units,
          pack,
          qty,
        });
      });

      // 仕入先×納品予定日ごとに分ける
      const map = new Map<string, Group>();
      rows.forEach((r) => {
        const key = `${r.vendor}|${r.date}`;
        if (!map.has(key))
          map.set(key, { key, vendor: r.vendor, vendorName: r.vendorName, date: r.date, rows: [], existing: 0 });
        map.get(key)!.rows.push(r);
      });
      const gs = Array.from(map.values()).sort((a, b) => (a.date + a.vendor).localeCompare(b.date + b.vendor));

      // 登録済みチェック(同じ仕入先・同じ日付の発注があれば重複防止のため取り込まない)
      for (const g of gs) {
        const { count } = await supabase
          .from("t_orders")
          .select("order_id", { count: "exact", head: true })
          .eq("supplier_code", g.vendor)
          .eq("target_date", g.date);
        g.existing = count ?? 0;
      }

      // 新規品目チェック
      const eosAll = Array.from(new Set(rows.map((r) => r.eos)));
      const known = new Set<string>();
      for (let i = 0; i < eosAll.length; i += 200) {
        const { data } = await supabase.from("m_items").select("item_code").in("item_code", eosAll.slice(i, i + 200));
        (data ?? []).forEach((d: { item_code: string }) => known.add(d.item_code));
      }
      setNewItems(new Set(eosAll.filter((c) => !known.has(c))));

      setIgnored(ign);
      setUnknownStores(Array.from(unk));
      setWarnings(warn);
      setGroups(gs);
      setChecked(Object.fromEntries(gs.map((g): [string, boolean] => [g.key, g.existing === 0])));
      if (gs.length === 0) setError("取り込める明細がありませんでした");
    } catch (err) {
      setError("CSVの読み込みに失敗しました: " + (err as Error).message);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const targets = useMemo(() => groups.filter((g) => checked[g.key]), [groups, checked]);

  async function handleSave() {
    if (targets.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      let orderCount = 0;
      let lineCount = 0;

      for (const g of targets) {
        // 保存直前に再確認(二重取込防止)
        const { count } = await supabase
          .from("t_orders")
          .select("order_id", { count: "exact", head: true })
          .eq("supplier_code", g.vendor)
          .eq("target_date", g.date);
        if ((count ?? 0) > 0) continue;

        const orderId = `${g.vendor}-${g.date}-1`;
        const { error: oe } = await supabase.from("t_orders").insert({
          order_id: orderId,
          supplier_code: g.vendor,
          target_date: g.date,
          page_no: 1,
          status: "確定済",
          confirmed_by: user?.id,
          confirmed_at: new Date().toISOString(),
        });
        if (oe) throw oe;

        // EOSコードごとに1明細
        const byEos = new Map<string, Row[]>();
        g.rows.forEach((r) => {
          if (!byEos.has(r.eos)) byEos.set(r.eos, []);
          byEos.get(r.eos)!.push(r);
        });

        const lineInputs = Array.from(byEos.entries()).map(([eos, rs]) => {
          const total = rs.reduce((a, r) => a + r.qty, 0);
          const packs = new Set(rs.map((r) => r.pack));
          const display = packs.size === 1 ? `${rs[0].pack}×${rs.reduce((a, r) => a + r.units, 0)}` : String(total);
          return {
            order_id: orderId,
            item_code: eos,
            origin: rs[0].origin || null,
            spec: rs[0].spec || null,
            total_display: display,
            total_qty: total,
          };
        });

        // 品目マスタ(未登録のみ追加)
        const itemRows = Array.from(byEos.entries()).map(([eos, rs]) => ({
          item_code: eos,
          item_name: rs[0].name,
          default_spec: rs[0].spec || null,
        }));
        const { error: ie } = await supabase
          .from("m_items")
          .upsert(itemRows, { onConflict: "item_code", ignoreDuplicates: true });
        if (ie) throw ie;

        const { data: inserted, error: le } = await supabase
          .from("t_order_lines")
          .insert(lineInputs)
          .select("order_line_id, item_code");
        if (le) throw le;
        const idByEos = new Map<string, number>(
          (inserted ?? []).map((l: { order_line_id: number; item_code: string }): [string, number] => [l.item_code, l.order_line_id])
        );

        const qtyRows: { order_line_id: number; store_code: string; pack_size: number; case_count: number }[] = [];
        byEos.forEach((rs, eos) => {
          // 同じ店・同じ入数は合算
          const m = new Map<string, { store: string; pack: number; cases: number }>();
          rs.forEach((r) => {
            const k = `${r.store}|${r.pack}`;
            const cur = m.get(k);
            if (cur) cur.cases += r.units;
            else m.set(k, { store: r.store, pack: r.pack, cases: r.units });
          });
          m.forEach((v) =>
            qtyRows.push({
              order_line_id: idByEos.get(eos)!,
              store_code: v.store,
              pack_size: v.pack,
              case_count: v.cases,
            })
          );
        });
        const { error: qe } = await supabase.from("t_order_line_store_qty").insert(qtyRows);
        if (qe) throw qe;

        orderCount++;
        lineCount += lineInputs.length;
      }

      setDone(`${orderCount}件の発注(${lineCount}品目)を登録しました`);
      setGroups([]);
      setTimeout(() => router.push("/inbound"), 1500);
    } catch (err) {
      const e = err as { message?: string };
      setError("保存中にエラーが発生しました: " + (e.message ?? String(err)) + "(途中まで登録された発注がある場合は、一覧で確認してください)");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-4">発注データ取込(CSV)</h1>

      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 max-w-2xl">
        <label className="block text-sm font-medium mb-2">発注元のオーダーCSVを選択</label>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} className="text-sm" />
        {fileName && <p className="text-xs text-gray-500 mt-2">{fileName}</p>}
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
        {done && <p className="text-sm text-green-700 mt-3">{done}</p>}
      </div>

      {groups.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 max-w-3xl">
          <p className="text-sm font-medium mb-3">取り込む発注を選んでください</p>

          <div className="space-y-2">
            {groups.map((g) => {
              const items = new Set(g.rows.map((r) => r.eos)).size;
              const dup = g.existing > 0;
              const past = g.date < today;
              const nNew = new Set(g.rows.filter((r) => newItems.has(r.eos)).map((r) => r.eos)).size;
              const byEos = new Map<string, Row[]>();
              g.rows.forEach((r) => {
                if (!byEos.has(r.eos)) byEos.set(r.eos, []);
                byEos.get(r.eos)!.push(r);
              });
              return (
                <div key={g.key} className={"border rounded-lg p-3 " + (dup ? "bg-gray-50 border-gray-200" : "border-gray-300")}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <input
                      type="checkbox"
                      checked={!!checked[g.key]}
                      disabled={dup}
                      onChange={(e) => setChecked({ ...checked, [g.key]: e.target.checked })}
                    />
                    <span className="font-medium text-sm">{g.date}</span>
                    <span className="text-sm">{supplierNames[g.vendor] ?? g.vendorName}</span>
                    <span className="text-xs text-gray-500">
                      {items}品目 / {g.rows.length}明細
                    </span>
                    {dup && (
                      <span className="text-xs bg-gray-200 text-gray-700 rounded px-2 py-0.5">登録済みのため取り込みません</span>
                    )}
                    {past && !dup && (
                      <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">過去の日付です</span>
                    )}
                    {nNew > 0 && !dup && (
                      <span className="text-xs bg-blue-100 text-blue-800 rounded px-2 py-0.5">新規品目 {nNew}</span>
                    )}
                    <button
                      className="ml-auto text-xs text-blue-600 underline"
                      onClick={() => setOpen(open === g.key ? null : g.key)}
                    >
                      {open === g.key ? "閉じる" : "内容を見る"}
                    </button>
                  </div>
                  {open === g.key && (
                    <div className="mt-3 overflow-x-auto">
                      <table className="text-xs w-full">
                        <thead>
                          <tr className="text-left text-gray-500 border-b">
                            <th className="py-1 pr-3">EOS</th>
                            <th className="pr-3">品名</th>
                            <th className="pr-3">規格</th>
                            <th className="pr-3">産地</th>
                            <th>店舗別(入数×箱数)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from(byEos.entries()).map(([eos, rs]) => (
                            <tr key={eos} className="border-b align-top">
                              <td className="py-1 pr-3">
                                {eos}
                                {newItems.has(eos) && <span className="ml-1 text-blue-600">新</span>}
                              </td>
                              <td className="pr-3">{rs[0].name}</td>
                              <td className="pr-3">{rs[0].spec}</td>
                              <td className="pr-3">{rs[0].origin}</td>
                              <td>{rs.map((r) => `${r.store}:${r.pack}×${r.units}`).join("  ")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {(Object.keys(ignored).length > 0 || unknownStores.length > 0) && (
            <div className="mt-4 text-xs text-gray-600 space-y-1">
              {Object.keys(ignored).length > 0 && (
                <p>
                  取込対象外の店舗(他業者納品): {Object.entries(ignored).map(([s, n]) => `${s}(${n}行)`).join("、")}
                </p>
              )}
              {unknownStores.length > 0 && (
                <p className="text-red-600">
                  店舗マスタにない店コードを除外しました: {unknownStores.join("、")}
                </p>
              )}
            </div>
          )}

          {warnings.length > 0 && (
            <details className="mt-3 text-xs text-amber-800" open>
              <summary className="cursor-pointer font-medium">確認が必要な行 {warnings.length}件</summary>
              <ul className="list-disc pl-5 mt-1 space-y-0.5">
                {warnings.slice(0, 30).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          <button
            onClick={handleSave}
            disabled={saving || targets.length === 0}
            className="mt-6 bg-brand text-white rounded-lg px-5 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {saving ? "保存中..." : `選択した${targets.length}件を取り込む`}
          </button>
        </div>
      )}
    </div>
  );
}
