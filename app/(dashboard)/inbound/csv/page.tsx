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

type ExistingLine = {
  order_line_id: number;
  order_id: string;
  item_code: string;
  total_qty: number | null;
  total_display: string | null;
  arrival_status: string | null;
  stores: Map<string, { pack: number; cases: number }[]>;
};

type Conflict = { eos: string; name: string; store: string; existing: string; csv: string };

type Diff = {
  newLineEos: string[]; // 発注にまだない品目
  addStores: { eos: string; store: string }[]; // 品目はあるが、その店舗の数量がない
  same: number; // すでに同じ内容で登録済み
  conflicts: Conflict[]; // 登録済みだが、数量が違う(取り込まない)
  started: number; // 入荷が始まっている品目の数
};

type Group = {
  key: string;
  vendor: string;
  vendorName: string;
  date: string;
  rows: Row[];
  existingOrderIds: string[];
  existingLines: Map<string, ExistingLine>;
  diff: Diff | null; // 登録済みの発注があるときだけ
};

type OrderSummary = { order_id: string; supplier_code: string; target_date: string; lines: number };

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

/** 取り込める件数(新しい発注なら全品目、追加取込なら足りない分) */
function addCount(g: Group): number {
  if (!g.diff) return new Set(g.rows.map((r) => r.eos)).size;
  return g.diff.newLineEos.length + g.diff.addStores.length;
}

/** 配列を n 件ずつに分ける */
function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 入数ごとの箱数を「5×3 / 10×2」の形にする */
function packText(list: { pack: number; cases: number }[]): string {
  return list
    .slice()
    .sort((a, b) => a.pack - b.pack)
    .map((p) => `${p.pack}×${p.cases}`)
    .join(" / ");
}

/** CSVの1品目×1店舗の内容を、入数ごとの箱数にまとめる */
function csvPacks(rows: Row[]): { pack: number; cases: number }[] {
  const m = new Map<number, number>();
  rows.forEach((r) => m.set(r.pack, (m.get(r.pack) ?? 0) + r.units));
  return Array.from(m.entries()).map(([pack, cases]) => ({ pack, cases }));
}

export default function CsvImportPage() {
  const router = useRouter();
  const supabase = createClient();

  const [fileName, setFileName] = useState("");
  const [parsedRows, setParsedRows] = useState<Row[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [ignored, setIgnored] = useState<Record<string, number>>({});
  const [unknownStores, setUnknownStores] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [newItems, setNewItems] = useState<Set<string>>(new Set());
  const [looseItems, setLooseItems] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [supplierNames, setSupplierNames] = useState<Record<string, string>>({});
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);

  async function loadOrders() {
    const { data } = await supabase
      .from("t_orders")
      .select("order_id, supplier_code, target_date")
      .order("target_date", { ascending: false })
      .order("order_id", { ascending: true })
      .limit(12);
    const list = (data ?? []) as { order_id: string; supplier_code: string; target_date: string }[];
    const counts = new Map<string, number>();
    if (list.length > 0) {
      const { data: ls } = await supabase
        .from("t_order_lines")
        .select("order_id")
        .in("order_id", list.map((o) => o.order_id));
      ((ls ?? []) as { order_id: string }[]).forEach((l) => counts.set(l.order_id, (counts.get(l.order_id) ?? 0) + 1));
    }
    setOrders(list.map((o) => ({ ...o, lines: counts.get(o.order_id) ?? 0 })));
  }

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
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 登録済みの発注との差分を調べる */
  async function buildGroups(rows: Row[], loose: Set<string>): Promise<Group[]> {
    const map = new Map<string, Group>();
    rows.forEach((r) => {
      const key = `${r.vendor}|${r.date}`;
      if (!map.has(key))
        map.set(key, {
          key,
          vendor: r.vendor,
          vendorName: r.vendorName,
          date: r.date,
          rows: [],
          existingOrderIds: [],
          existingLines: new Map(),
          diff: null,
        });
      map.get(key)!.rows.push(r);
    });
    const gs = Array.from(map.values()).sort((a, b) => (a.date + a.vendor).localeCompare(b.date + b.vendor));

    for (const g of gs) {
      const { data: ords } = await supabase
        .from("t_orders")
        .select("order_id")
        .eq("supplier_code", g.vendor)
        .eq("target_date", g.date);
      g.existingOrderIds = ((ords ?? []) as { order_id: string }[]).map((o) => o.order_id).sort();
      if (g.existingOrderIds.length === 0) continue;

      const { data: ls } = await supabase
        .from("t_order_lines")
        .select("order_line_id, order_id, item_code, total_qty, total_display, arrival_status")
        .in("order_id", g.existingOrderIds);
      const lines = (ls ?? []) as {
        order_line_id: number;
        order_id: string;
        item_code: string;
        total_qty: number | null;
        total_display: string | null;
        arrival_status: string | null;
      }[];
      const byId = new Map<number, ExistingLine>();
      lines.forEach((l) => {
        const el: ExistingLine = { ...l, stores: new Map() };
        byId.set(l.order_line_id, el);
        if (!g.existingLines.has(l.item_code)) g.existingLines.set(l.item_code, el);
      });
      for (const ids of chunks(lines.map((l) => l.order_line_id), 150)) {
        const { data: sq } = await supabase
          .from("t_order_line_store_qty")
          .select("order_line_id, store_code, pack_size, case_count")
          .in("order_line_id", ids);
        ((sq ?? []) as { order_line_id: number; store_code: string; pack_size: number; case_count: number }[]).forEach((q) => {
          const el = byId.get(q.order_line_id);
          if (!el) return;
          const arr = el.stores.get(q.store_code) ?? [];
          arr.push({ pack: q.pack_size, cases: q.case_count });
          el.stores.set(q.store_code, arr);
        });
      }

      // CSVを品目×店舗にまとめて、登録済みの内容と比べる
      const diff: Diff = { newLineEos: [], addStores: [], same: 0, conflicts: [], started: 0 };
      const byEos = new Map<string, Map<string, Row[]>>();
      g.rows.forEach((r) => {
        if (!byEos.has(r.eos)) byEos.set(r.eos, new Map());
        const sm = byEos.get(r.eos)!;
        if (!sm.has(r.store)) sm.set(r.store, []);
        sm.get(r.store)!.push(r);
      });
      byEos.forEach((sm, eos) => {
        const ex = g.existingLines.get(eos);
        if (!ex) {
          diff.newLineEos.push(eos);
          return;
        }
        if (ex.arrival_status && ex.arrival_status !== "未入荷") diff.started++;
        sm.forEach((rs, store) => {
          const have = ex.stores.get(store);
          if (!have || have.length === 0) {
            diff.addStores.push({ eos, store });
            return;
          }
          const want = csvPacks(rs);
          let equal: boolean;
          if (loose.has(eos)) {
            // 株数管理品は入数を1にそろえて持つので、箱数(株数)だけ比べる
            equal = have.reduce((a, p) => a + p.cases, 0) === want.reduce((a, p) => a + p.cases, 0);
          } else {
            equal = packText(have) === packText(want);
          }
          if (equal) diff.same++;
          else
            diff.conflicts.push({
              eos,
              name: rs[0].name,
              store,
              existing: packText(have),
              csv: packText(want),
            });
        });
      });
      g.diff = diff;
    }
    return gs;
  }

  async function analyze(rows: Row[]) {
    const eosAll = Array.from(new Set(rows.map((r) => r.eos)));
    const known = new Set<string>();
    const loose = new Set<string>();
    for (const part of chunks(eosAll, 200)) {
      const { data } = await supabase
        .from("m_items")
        .select("item_code, loose_case_size")
        .in("item_code", part);
      ((data ?? []) as { item_code: string; loose_case_size: number | null }[]).forEach((d) => {
        known.add(d.item_code);
        if (d.loose_case_size) loose.add(d.item_code);
      });
    }
    setNewItems(new Set(eosAll.filter((c) => !known.has(c))));
    setLooseItems(loose);
    const gs = await buildGroups(rows, loose);
    setGroups(gs);
    setChecked(
      Object.fromEntries(
        gs.map((g): [string, boolean] => [
          g.key,
          g.diff === null ? true : g.diff.newLineEos.length + g.diff.addStores.length > 0,
        ])
      )
    );
    if (gs.length === 0) setError("取り込める明細がありませんでした");
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setDone(null);
    setGroups([]);
    setParsedRows(null);
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

      setIgnored(ign);
      setUnknownStores(Array.from(unk));
      setWarnings(warn);
      setParsedRows(rows);
      await analyze(rows);
    } catch (err) {
      setError("CSVの読み込みに失敗しました: " + (err as Error).message);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  const targets = useMemo(() => groups.filter((g) => checked[g.key] && addCount(g) > 0), [groups, checked]);

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
      let addedStoreRows = 0;

      for (const g of targets) {
        // 保存の直前に、登録済みの内容を取り直して、もう一度比べる(二重取込の防止)
        const fresh = (await buildGroups(g.rows, looseItems)).find((x) => x.key === g.key);
        if (!fresh) continue;
        const diff = fresh.diff;
        const isNew = fresh.existingOrderIds.length === 0;
        const orderId = isNew ? `${g.vendor}-${g.date}-1` : fresh.existingOrderIds[0];

        if (isNew) {
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
          orderCount++;
        }

        // CSVを品目ごとにまとめる
        const byEos = new Map<string, Row[]>();
        g.rows.forEach((r) => {
          if (!byEos.has(r.eos)) byEos.set(r.eos, []);
          byEos.get(r.eos)!.push(r);
        });

        // 取り込む品目(新しい発注なら全部、追加取込なら発注にない品目)
        const newEos = isNew ? Array.from(byEos.keys()) : diff ? diff.newLineEos : [];
        // 追加する店舗(品目は登録済み)
        const addList = !isNew && diff ? diff.addStores : [];

        const itemRows = newEos.map((eos) => ({
          item_code: eos,
          item_name: byEos.get(eos)![0].name,
          default_spec: byEos.get(eos)![0].spec || null,
        }));
        if (itemRows.length > 0) {
          const { error: ie } = await supabase
            .from("m_items")
            .upsert(itemRows, { onConflict: "item_code", ignoreDuplicates: true });
          if (ie) throw ie;
        }

        if (newEos.length > 0) {
          const lineInputs = newEos.map((eos) => {
            const rs = byEos.get(eos)!;
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
          const { data: inserted, error: le } = await supabase
            .from("t_order_lines")
            .insert(lineInputs)
            .select("order_line_id, item_code");
          if (le) throw le;
          const idByEos = new Map<string, number>(
            (inserted ?? []).map((l: { order_line_id: number; item_code: string }): [string, number] => [
              l.item_code,
              l.order_line_id,
            ])
          );
          const qtyRows: { order_line_id: number; store_code: string; pack_size: number; case_count: number }[] = [];
          newEos.forEach((eos) => {
            const m = new Map<string, { store: string; pack: number; cases: number }>();
            byEos.get(eos)!.forEach((r) => {
              const k = `${r.store}|${r.pack}`;
              const cur = m.get(k);
              if (cur) cur.cases += r.units;
              else m.set(k, { store: r.store, pack: r.pack, cases: r.units });
            });
            m.forEach((v) =>
              qtyRows.push({ order_line_id: idByEos.get(eos)!, store_code: v.store, pack_size: v.pack, case_count: v.cases })
            );
          });
          const { error: qe } = await supabase.from("t_order_line_store_qty").insert(qtyRows);
          if (qe) throw qe;
          lineCount += lineInputs.length;
        }

        // 登録済みの品目に、足りない店舗を追加
        if (addList.length > 0) {
          const perLine = new Map<number, { eos: string; rows: Row[] }>();
          addList.forEach(({ eos, store }) => {
            const ex = fresh.existingLines.get(eos);
            if (!ex) return;
            const rs = byEos.get(eos)!.filter((r) => r.store === store);
            if (!perLine.has(ex.order_line_id)) perLine.set(ex.order_line_id, { eos, rows: [] });
            perLine.get(ex.order_line_id)!.rows.push(...rs);
          });
          for (const [lineId, v] of Array.from(perLine.entries())) {
            const m = new Map<string, { store: string; pack: number; cases: number }>();
            v.rows.forEach((r) => {
              const k = `${r.store}|${r.pack}`;
              const cur = m.get(k);
              if (cur) cur.cases += r.units;
              else m.set(k, { store: r.store, pack: r.pack, cases: r.units });
            });
            const ins = Array.from(m.values()).map((x) => ({
              order_line_id: lineId,
              store_code: x.store,
              pack_size: x.pack,
              case_count: x.cases,
            }));
            const { error: qe } = await supabase.from("t_order_line_store_qty").insert(ins);
            if (qe) throw qe;
            addedStoreRows += ins.length;

            // 全店計を、追加した分だけ増やして直す
            const ex = fresh.existingLines.get(v.eos)!;
            const addQty = v.rows.reduce((a, r) => a + r.qty, 0);
            const { data: all } = await supabase
              .from("t_order_line_store_qty")
              .select("pack_size, case_count")
              .eq("order_line_id", lineId);
            const stored = (all ?? []) as { pack_size: number; case_count: number }[];
            const totalCases = stored.reduce((a, p) => a + p.case_count, 0);
            const packSet = new Set(stored.map((p) => p.pack_size));
            const newTotal = (ex.total_qty ?? 0) + addQty;
            let display: string;
            if (looseItems.has(v.eos)) {
              const csvPackSet = new Set(byEos.get(v.eos)!.map((r) => r.pack));
              display = csvPackSet.size === 1 ? `${Array.from(csvPackSet)[0]}×${totalCases}` : String(newTotal);
            } else {
              display = packSet.size === 1 ? `${Array.from(packSet)[0]}×${totalCases}` : String(newTotal);
            }
            const { error: ue } = await supabase
              .from("t_order_lines")
              .update({ total_qty: newTotal, total_display: display })
              .eq("order_line_id", lineId);
            if (ue) throw ue;
          }
        }
      }

      const parts: string[] = [];
      if (orderCount > 0) parts.push(`${orderCount}件の発注を新しく登録`);
      if (lineCount > 0) parts.push(`${lineCount}品目を追加`);
      if (addedStoreRows > 0) parts.push(`登録済みの品目に${addedStoreRows}件の店舗数量を追加`);
      setDone((parts.length > 0 ? parts.join("、") : "追加するデータはありませんでした") + "しました");
      await loadOrders();
      if (parsedRows) await analyze(parsedRows);
    } catch (err) {
      const e = err as { message?: string };
      setError("保存中にエラーが発生しました: " + (e.message ?? String(err)) + "(途中まで登録された発注がある場合は、下の一覧で確認してください)");
    } finally {
      setSaving(false);
    }
  }

  /** 登録した発注を取り消す(入荷の記録・ラベルが無いものだけ) */
  async function cancelOrder(o: OrderSummary) {
    setCancelBusy(o.order_id);
    setCancelMsg(null);
    try {
      const { data: ls } = await supabase.from("t_order_lines").select("order_line_id").eq("order_id", o.order_id);
      const lineIds = ((ls ?? []) as { order_line_id: number }[]).map((l) => l.order_line_id);

      let arrivals = 0;
      let labels = 0;
      for (const part of chunks(lineIds, 150)) {
        const { count } = await supabase
          .from("t_arrivals")
          .select("order_line_id", { count: "exact", head: true })
          .in("order_line_id", part);
        arrivals += count ?? 0;
        const { data: sq } = await supabase
          .from("t_order_line_store_qty")
          .select("id")
          .in("order_line_id", part);
        const sqIds = ((sq ?? []) as { id: number }[]).map((x) => x.id);
        for (const p2 of chunks(sqIds, 150)) {
          const { count: c2 } = await supabase
            .from("t_labels")
            .select("label_id", { count: "exact", head: true })
            .in("order_line_store_qty_id", p2);
          labels += c2 ?? 0;
        }
      }
      if (arrivals > 0 || labels > 0) {
        setCancelMsg(
          `この発注は取り消せません(入荷の記録${arrivals}件・ラベル${labels}枚があります)。` +
            "入荷やラベル発行を始めたあとの変更は、「当日変更」で行ってください"
        );
        return;
      }
      const ok = window.confirm(
        `${o.target_date} の発注(${supplierNames[o.supplier_code] ?? o.supplier_code}、${lineIds.length}品目)を取り消します。\n` +
          "この発注の品目と店舗の数量が、すべて消えます。よろしいですか?"
      );
      if (!ok) return;
      const { error: de } = await supabase.from("t_order_lines").delete().eq("order_id", o.order_id);
      if (de) throw de;
      // 発注の見出しも消す(権限などで消せなくても、品目が無ければ、取り込み直しは可能)
      await supabase.from("t_orders").delete().eq("order_id", o.order_id);
      setCancelMsg(`${o.target_date} の発注を取り消しました`);
      await loadOrders();
      if (parsedRows) await analyze(parsedRows);
    } catch (err) {
      const e = err as { message?: string };
      setCancelMsg("取り消しに失敗しました: " + (e.message ?? String(err)));
    } finally {
      setCancelBusy(null);
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
        <div className="bg-white border border-gray-200 rounded-xl p-6 max-w-3xl mb-6">
          <p className="text-sm font-medium mb-3">取り込む発注を選んでください</p>

          <div className="space-y-2">
            {groups.map((g) => {
              const items = new Set(g.rows.map((r) => r.eos)).size;
              const add = addCount(g);
              const past = g.date < today;
              const byEos = new Map<string, Row[]>();
              g.rows.forEach((r) => {
                if (!byEos.has(r.eos)) byEos.set(r.eos, []);
                byEos.get(r.eos)!.push(r);
              });
              const nNew = Array.from(byEos.keys()).filter((e) => newItems.has(e)).length;
              const d = g.diff;
              return (
                <div key={g.key} className={"border rounded-lg p-3 " + (add === 0 ? "bg-gray-50 border-gray-200" : "border-gray-300")}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <input
                      type="checkbox"
                      checked={!!checked[g.key] && add > 0}
                      disabled={add === 0}
                      onChange={(e) => setChecked({ ...checked, [g.key]: e.target.checked })}
                    />
                    <span className="font-medium text-sm">{g.date}</span>
                    <span className="text-sm">{supplierNames[g.vendor] ?? g.vendorName}</span>
                    <span className="text-xs text-gray-500">
                      {items}品目 / {g.rows.length}明細
                    </span>
                    {d === null && past && (
                      <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">過去の日付です</span>
                    )}
                    {nNew > 0 && add > 0 && (
                      <span className="text-xs bg-blue-100 text-blue-800 rounded px-2 py-0.5">新規品目 {nNew}</span>
                    )}
                    <button
                      className="ml-auto text-xs text-blue-600 underline"
                      onClick={() => setOpen(open === g.key ? null : g.key)}
                    >
                      {open === g.key ? "閉じる" : "内容を見る"}
                    </button>
                  </div>

                  {d && (
                    <div className="mt-2 text-xs space-y-1">
                      <p className="text-gray-700">
                        すでに登録済みの発注です。
                        {add > 0 ? (
                          <b className="text-blue-700">
                            {" "}
                            追加で取り込めるもの:新しい品目 {d.newLineEos.length}、登録済み品目への店舗追加 {d.addStores.length}
                          </b>
                        ) : (
                          <b className="text-gray-600"> 追加で取り込むものはありません</b>
                        )}
                        (登録済みと同じ内容: {d.same}件)
                      </p>
                      {d.started > 0 && (
                        <p className="text-amber-700">
                          入荷が始まっている品目が{d.started}あります。追加した店舗の分も、入荷・ラベル発行の画面で確認してください
                        </p>
                      )}
                      {d.conflicts.length > 0 && (
                        <details className="text-red-700">
                          <summary className="cursor-pointer">
                            登録済みと数量が違う明細 {d.conflicts.length}件(取り込みません。「当日変更」で直してください)
                          </summary>
                          <ul className="list-disc pl-5 mt-1 space-y-0.5">
                            {d.conflicts.slice(0, 30).map((c, i) => (
                              <li key={i}>
                                {c.eos} {c.name} 店{c.store}: 登録済み {c.existing} / CSV {c.csv}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}

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
                                {looseItems.has(eos) && <span className="ml-1 text-green-700">株</span>}
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
                <p>取込対象外の店舗(他業者納品): {Object.entries(ignored).map(([s, n]) => `${s}(${n}行)`).join("、")}</p>
              )}
              {unknownStores.length > 0 && (
                <p className="text-red-600">店舗マスタにない店コードを除外しました: {unknownStores.join("、")}</p>
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

      <div className="bg-white border border-gray-200 rounded-xl p-6 max-w-3xl">
        <p className="text-sm font-medium mb-1">登録済みの発注(取り消し)</p>
        <p className="text-xs text-gray-500 mb-3">
          まちがえて取り込んだ発注を、取り消せます。入荷の記録やラベルがある発注は、取り消せません。
        </p>
        {cancelMsg && <p className="text-sm text-gray-800 mb-3">{cancelMsg}</p>}
        {orders.length === 0 ? (
          <p className="text-xs text-gray-500">登録済みの発注はありません</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {orders.map((o) => (
              <li key={o.order_id} className="py-2 flex items-center gap-3 text-sm flex-wrap">
                <span className="font-medium">{o.target_date}</span>
                <span>{supplierNames[o.supplier_code] ?? o.supplier_code}</span>
                <span className="text-xs text-gray-500">{o.lines}品目</span>
                <button
                  onClick={() => cancelOrder(o)}
                  disabled={cancelBusy !== null}
                  className="ml-auto text-xs border border-red-300 text-red-700 rounded px-3 py-1 hover:bg-red-50 disabled:opacity-50"
                >
                  {cancelBusy === o.order_id ? "確認中…" : "取り消す"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={() => router.push("/inbound")} className="mt-4 text-xs text-blue-600 underline">
          入荷・ラベル発行へ戻る
        </button>
      </div>
    </div>
  );
}
