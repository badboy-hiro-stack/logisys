"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { computeStatus, one, slipOrderIndex } from "@/lib/inbound";
import {
  errorText,
  formatLabelId,
  formatStoreLabel,
  getPrinterName,
  printLabels,
  PrintBatchError,
  setPrinterName,
  type LabelPrintData,
} from "@/lib/label";

// まとめ入荷:同じ「まとめグループ」(例:ハーブ類)の品目を、店舗ごとに1箱・ラベル1枚にまとめて処理する画面。

type RawLine = {
  order_line_id: number;
  item_code: string;
  arrival_status: string;
  m_items:
    | { item_name: string; bundle_group: string | null }
    | { item_name: string; bundle_group: string | null }[]
    | null;
  t_orders:
    | {
        supplier_code: string;
        target_date: string;
        m_suppliers: { supplier_name: string } | { supplier_name: string }[] | null;
      }
    | {
        supplier_code: string;
        target_date: string;
        m_suppliers: { supplier_name: string } | { supplier_name: string }[] | null;
      }[]
    | null;
};
type Line = {
  order_line_id: number;
  item_code: string;
  item_name: string;
  group: string;
  arrival_status: string;
  supplier_code: string;
  supplier_name: string;
};
type Row = { id: number; order_line_id: number; store_code: string; pack_size: number; case_count: number };
type LabelRec = {
  label_id: string;
  order_line_store_qty_id: number;
  case_count: number;
  label_kind: string;
  bundle_parent_label_id: string | null;
};
type StoreInfo = { store_name: string; sign: string | null };
type Loaded = {
  lines: Line[];
  rows: Row[];
  labels: LabelRec[];
  stores: Record<string, StoreInfo>;
};
type Message = { type: "ok" | "error"; text: string };
type PendingPrint = { label_id: string; data: LabelPrintData };

function todayTokyo(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

export default function BundlePage() {
  const supabase = createClient();
  const [date, setDate] = useState<string>(todayTokyo());
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [failedPrints, setFailedPrints] = useState<PendingPrint[]>([]);
  const [printer, setPrinter] = useState("");

  const load = useCallback(async (): Promise<Loaded> => {
    const { data: ld, error: le } = await supabase
      .from("t_order_lines")
      .select(
        "order_line_id, item_code, arrival_status, m_items!inner(item_name, bundle_group), " +
          "t_orders!inner(supplier_code, target_date, m_suppliers(supplier_name))"
      )
      .eq("t_orders.target_date", date)
      .not("m_items.bundle_group", "is", null);
    if (le) throw new Error("品目の取得に失敗しました: " + le.message);

    const lines: Line[] = ((ld ?? []) as unknown as RawLine[])
      .map((r) => {
        const it = one(r.m_items);
        const od = one(r.t_orders);
        if (!it || !od || !it.bundle_group) return null;
        return {
          order_line_id: r.order_line_id,
          item_code: r.item_code,
          item_name: it.item_name,
          group: it.bundle_group,
          arrival_status: r.arrival_status,
          supplier_code: od.supplier_code,
          supplier_name: one(od.m_suppliers)?.supplier_name ?? od.supplier_code,
        } as Line;
      })
      .filter((x): x is Line => x !== null)
      .sort((a, b) => a.item_code.localeCompare(b.item_code));

    let rows: Row[] = [];
    let labels: LabelRec[] = [];
    if (lines.length > 0) {
      const sq = await supabase
        .from("t_order_line_store_qty")
        .select("id, order_line_id, store_code, pack_size, case_count")
        .in(
          "order_line_id",
          lines.map((l) => l.order_line_id)
        );
      if (sq.error) throw new Error("店舗別数量の取得に失敗しました: " + sq.error.message);
      rows = (sq.data ?? []) as unknown as Row[];
      if (rows.length > 0) {
        const lb = await supabase
          .from("t_labels")
          .select("label_id, order_line_store_qty_id, case_count, label_kind, bundle_parent_label_id")
          .in(
            "order_line_store_qty_id",
            rows.map((r) => r.id)
          )
          .neq("status", "無効");
        if (lb.error) throw new Error("ラベルの取得に失敗しました: " + lb.error.message);
        labels = (lb.data ?? []) as unknown as LabelRec[];
      }
    }

    const st = await supabase.from("m_stores").select("store_code, store_name, sign");
    if (st.error) throw new Error("店舗マスタの取得に失敗しました: " + st.error.message);
    const stores: Record<string, StoreInfo> = {};
    ((st.data ?? []) as unknown as { store_code: string; store_name: string; sign: string | null }[]).forEach(
      (s) => {
        stores[s.store_code] = { store_name: s.store_name, sign: s.sign };
      }
    );
    return { lines, rows, labels, stores };
  }, [supabase, date]);

  const refresh = useCallback(async () => {
    try {
      const d = await load();
      setData(d);
      setLoadError(null);
      return d;
    } catch (e) {
      setLoadError(errorText(e));
      return null;
    }
  }, [load]);

  useEffect(() => {
    setPrinter(getPrinterName());
  }, []);
  useEffect(() => {
    setData(null);
    refresh();
  }, [refresh]);

  // グループ × 仕入先ごとのまとまり
  const bundles = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { group: string; supplier_code: string; supplier_name: string; lines: Line[] }>();
    data.lines.forEach((l) => {
      const key = `${l.group}|${l.supplier_code}`;
      if (!map.has(key)) {
        map.set(key, { group: l.group, supplier_code: l.supplier_code, supplier_name: l.supplier_name, lines: [] });
      }
      map.get(key)!.lines.push(l);
    });
    return Array.from(map.values());
  }, [data]);

  async function getActor() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const loc = typeof window !== "undefined" ? window.localStorage.getItem("logisys:location_id") : null;
    return { userId: user?.id ?? null, locationId: loc ? Number(loc) : null };
  }

  // 品目ごとの入荷状態を、最新のデータで計算して保存する
  async function recomputeLine(lineId: number, current: string) {
    const [sq, ar, lb] = await Promise.all([
      supabase.from("t_order_line_store_qty").select("id, store_code, pack_size, case_count").eq("order_line_id", lineId),
      supabase.from("t_arrivals").select("pack_size, case_count").eq("order_line_id", lineId),
      supabase.from("t_order_line_store_qty").select("id").eq("order_line_id", lineId),
    ]);
    if (sq.error || ar.error || lb.error) throw new Error("入荷状態の再計算に失敗しました");
    const ids = ((lb.data ?? []) as unknown as { id: number }[]).map((r) => r.id);
    let labels: { order_line_store_qty_id: number; pack_size: number; case_count: number }[] = [];
    if (ids.length > 0) {
      const l = await supabase
        .from("t_labels")
        .select("order_line_store_qty_id, pack_size, case_count")
        .in("order_line_store_qty_id", ids)
        .neq("status", "無効");
      if (l.error) throw new Error("入荷状態の再計算に失敗しました: " + l.error.message);
      labels = (l.data ?? []) as unknown as typeof labels;
    }
    const status = computeStatus(
      (sq.data ?? []) as unknown as { id: number; store_code: string; pack_size: number; case_count: number }[],
      (ar.data ?? []) as unknown as { pack_size: number; case_count: number }[],
      labels,
      current
    );
    const { error } = await supabase.from("t_order_lines").update({ arrival_status: status }).eq("order_line_id", lineId);
    if (error) throw new Error("入荷状態の更新に失敗しました: " + error.message);
  }

  async function printAll(items: PendingPrint[]): Promise<boolean> {
    // まとめて印刷する(Android:1回の依頼で、最後の1枚の後だけカット)
    setProgress(`${items.length}枚を印刷中…`);
    try {
      await printLabels(items.map((it) => it.data));
    } catch (e) {
      const printed = e instanceof PrintBatchError ? e.printed : 0;
      setFailedPrints(items.slice(printed));
      setProgress(null);
      setMessage({
        type: "error",
        text:
          `${printed + 1}枚目以降の印刷でエラーが発生しました: ${errorText(e)}。` +
          "ラベルの番号は登録済みです。プリンターを確認して「未印刷のラベルを再印刷」を押してください",
      });
      return false;
    }
    setFailedPrints([]);
    setProgress(null);
    return true;
  }

  // 店舗のまとめ内容(欠品確定の品目と、数量0の行は除く)
  function storeContents(d: Loaded, supplierCode: string, group: string, storeCode: string) {
    const lineMap = new Map(d.lines.map((l) => [l.order_line_id, l]));
    return d.rows
      .filter((r) => r.store_code === storeCode && r.case_count > 0)
      .map((r) => ({ row: r, line: lineMap.get(r.order_line_id) }))
      .filter(
        (x) =>
          x.line &&
          x.line.group === group &&
          x.line.supplier_code === supplierCode &&
          x.line.arrival_status !== "欠品確定"
      )
      .map((x) => ({ row: x.row, line: x.line as Line }))
      .sort((a, b) => a.line.item_code.localeCompare(b.line.item_code));
  }

  function buildPrint(
    d: Loaded,
    b: { group: string; supplier_code: string; supplier_name: string },
    storeCode: string,
    itemCount: number,
    labelId: string
  ): LabelPrintData {
    const s = d.stores[storeCode];
    return {
      item: b.group,
      store: formatStoreLabel(s?.store_name ?? storeCode, s?.sign),
      qty: "1箱",
      origin: "",
      spec: `${itemCount}品目`,
      date: date.replace(/-/g, "/"),
      supplier: b.supplier_name,
      qr: labelId,
    };
  }

  // 1店舗分(または複数店舗分)の入荷記録とラベル発行
  async function issueStores(
    b: { group: string; supplier_code: string; supplier_name: string },
    storeCodes: string[]
  ) {
    setBusy(true);
    setMessage(null);
    setFailedPrints([]);
    try {
      const fresh = await refresh();
      if (!fresh) return;
      const { userId, locationId } = await getActor();
      const pending: PendingPrint[] = [];
      let issuedStores = 0;

      for (const sc of storeCodes) {
        const contents = storeContents(fresh, b.supplier_code, b.group, sc);
        const labeled = new Set(fresh.labels.map((l) => l.order_line_store_qty_id));
        const todo = contents.filter((c) => !labeled.has(c.row.id));
        if (todo.length === 0) continue;

        const count = todo.length;
        const { data: last, error: rpcErr } = await supabase.rpc("reserve_label_numbers", {
          p_supplier: b.supplier_code,
          p_date: date,
          p_count: count,
        });
        if (rpcErr) throw rpcErr;
        const first = (last as number) - count + 1;
        const ids = todo.map((_, i) => formatLabelId(b.supplier_code, date, first + i));
        const parentId = ids[0];

        const mk = (i: number) => ({
          label_id: ids[i],
          order_line_store_qty_id: todo[i].row.id,
          pack_size: todo[i].row.pack_size,
          case_count: todo[i].row.case_count,
          qty: todo[i].row.pack_size * todo[i].row.case_count,
          label_kind: "まとめ",
          unit_size: null,
          bundle_parent_label_id: i === 0 ? null : parentId,
          issued_by: userId,
          location_id: locationId,
        });
        // 親を先に登録してから、子を登録する
        const r1 = await supabase.from("t_labels").insert([mk(0)]);
        if (r1.error) throw r1.error;
        if (count > 1) {
          const r2 = await supabase.from("t_labels").insert(todo.slice(1).map((_, i) => mk(i + 1)));
          if (r2.error) throw r2.error;
        }

        // 箱が入荷したものとして、品目ごとの入荷数も記録する
        const ar = await supabase.from("t_arrivals").insert(
          todo.map((c) => ({
            order_line_id: c.row.order_line_id,
            pack_size: c.row.pack_size,
            case_count: c.row.case_count,
            user_id: userId,
            location_id: locationId,
          }))
        );
        if (ar.error) throw ar.error;

        const lineIds = Array.from(new Set(todo.map((c) => c.row.order_line_id)));
        for (const lid of lineIds) {
          const cur = fresh.lines.find((l) => l.order_line_id === lid)?.arrival_status ?? "";
          await recomputeLine(lid, cur);
        }

        pending.push({ label_id: parentId, data: buildPrint(fresh, b, sc, contents.length, parentId) });
        issuedStores++;
      }

      await refresh();
      if (pending.length === 0) {
        setMessage({ type: "error", text: "発行する店舗がありません" });
        return;
      }
      const ok = await printAll(pending);
      if (ok) {
        setMessage({
          type: "ok",
          text: `${issuedStores}店舗分のラベルを発行・印刷しました。出てきたラベルを確認してください`,
        });
      }
    } catch (e) {
      setMessage({ type: "error", text: "ラベルの発行に失敗しました: " + errorText(e) });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  // 発行済みのまとめラベルを、同じ番号で印刷し直す
  async function reprintStore(
    b: { group: string; supplier_code: string; supplier_name: string },
    storeCode: string
  ) {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      const rowIds = new Set(
        data.rows.filter((r) => r.store_code === storeCode).map((r) => r.id)
      );
      const parents = data.labels.filter(
        (l) => l.label_kind === "まとめ" && !l.bundle_parent_label_id && rowIds.has(l.order_line_store_qty_id)
      );
      const n = storeContents(data, b.supplier_code, b.group, storeCode).length;
      const ok = await printAll(
        parents.map((p) => ({ label_id: p.label_id, data: buildPrint(data, b, storeCode, n, p.label_id) }))
      );
      if (ok) setMessage({ type: "ok", text: "再印刷しました。出てきたラベルを確認してください" });
    } finally {
      setBusy(false);
    }
  }

  async function reprintFailed() {
    setBusy(true);
    setMessage(null);
    try {
      const ok = await printAll(failedPrints);
      if (ok) setMessage({ type: "ok", text: "印刷しました。出てきたラベルを確認してください" });
    } finally {
      setBusy(false);
    }
  }

  // 品目ごとの欠品(その品目は、まとめの内訳から外れる)と、その取り消し
  async function setShortage(line: Line, on: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const { userId } = await getActor();
      if (on) {
        if (!window.confirm(`${line.item_name} を欠品にします(まだ発行していない店舗の内訳から外れます)。よろしいですか?`)) return;
        const { error } = await supabase
          .from("t_order_lines")
          .update({
            arrival_status: "欠品確定",
            arrival_closed_by: userId,
            arrival_closed_at: new Date().toISOString(),
          })
          .eq("order_line_id", line.order_line_id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("t_order_lines")
          .update({ arrival_closed_by: null, arrival_closed_at: null })
          .eq("order_line_id", line.order_line_id);
        if (error) throw error;
        await recomputeLine(line.order_line_id, "");
      }
      await refresh();
    } catch (e) {
      setMessage({ type: "error", text: "更新に失敗しました: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <Link href="/inbound" className="text-sm text-brand underline">
        ← 入荷・ラベル発行へ
      </Link>
      <div className="flex flex-wrap items-end gap-4 mt-2 mb-1">
        <h1 className="text-lg font-semibold">まとめ入荷(ハーブ類など)</h1>
        <label className="text-sm flex items-center gap-2">
          納品日
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 ml-auto">
          プリンター名
          <input
            value={printer}
            onChange={(e) => {
              setPrinter(e.target.value);
              setPrinterName(e.target.value);
            }}
            className="border border-gray-300 rounded px-2 py-1 text-xs w-44"
          />
        </label>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        店舗ごとに1箱にまとめて入荷する品目です。「発行」を押すと、その店舗の箱が入荷したものとして記録し、ラベルを1枚印刷します。
        中身の内訳は、出荷検品でラベルを読み取ったときに表示されます。
      </p>

      {message && (
        <div
          className={
            "text-sm rounded-lg px-4 py-3 mb-4 " +
            (message.type === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")
          }
        >
          {message.text}
        </div>
      )}
      {progress && <p className="text-sm text-gray-600 mb-3">{progress}</p>}
      {failedPrints.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 text-sm text-amber-800">
          <p className="mb-2">未印刷のラベルが{failedPrints.length}枚あります(番号は登録済み)。</p>
          <button
            onClick={reprintFailed}
            disabled={busy}
            className="bg-amber-600 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            未印刷のラベルを再印刷
          </button>
        </div>
      )}
      {loadError && <p className="text-sm text-red-600 mb-3">{loadError}</p>}
      {!data && !loadError && <p className="text-sm text-gray-500">読み込み中…</p>}
      {data && bundles.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500">
          この納品日に、まとめ入荷の対象の品目はありません。対象の品目は、マスタ管理の品目で「まとめグループ」を設定します。
        </div>
      )}

      {data &&
        bundles.map((b) => {
          const storeCodes = Array.from(
            new Set(
              data.rows
                .filter((r) => b.lines.some((l) => l.order_line_id === r.order_line_id) && r.case_count > 0)
                .map((r) => r.store_code)
            )
          ).sort((a, c) => slipOrderIndex(a) - slipOrderIndex(c));
          const labeledRows = new Set(data.labels.map((l) => l.order_line_store_qty_id));
          const info = storeCodes.map((sc) => {
            const contents = storeContents(data, b.supplier_code, b.group, sc);
            const issuedN = contents.filter((c) => labeledRows.has(c.row.id)).length;
            const state: "none" | "partial" | "done" | "empty" =
              contents.length === 0
                ? "empty"
                : issuedN === 0
                  ? "none"
                  : issuedN === contents.length
                    ? "done"
                    : "partial";
            return { sc, contents, state };
          });
          const todoStores = info.filter((i) => i.state === "none" || i.state === "partial").map((i) => i.sc);
          return (
            <section key={`${b.group}|${b.supplier_code}`} className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-1">
                {b.group}
                <span className="text-gray-500 font-normal"> / {b.supplier_name}</span>
              </h2>

              <p className="text-xs text-gray-500 mb-2">品目(欠品の品目は、まとめの内訳から外れます)</p>
              <ul className="mb-4 text-sm divide-y divide-gray-100 border border-gray-100 rounded-lg">
                {b.lines.map((l) => (
                  <li key={l.order_line_id} className="px-3 py-1.5 flex items-center gap-3">
                    <span className="text-xs text-gray-400 w-14">{l.item_code}</span>
                    <span className={"flex-1 " + (l.arrival_status === "欠品確定" ? "line-through text-gray-400" : "")}>
                      {l.item_name}
                    </span>
                    <span className="text-xs text-gray-500">{l.arrival_status}</span>
                    {l.arrival_status === "欠品確定" ? (
                      <button
                        onClick={() => setShortage(l, false)}
                        disabled={busy}
                        className="text-xs text-blue-600 underline disabled:opacity-50"
                      >
                        欠品を取り消す
                      </button>
                    ) : (
                      <button
                        onClick={() => setShortage(l, true)}
                        disabled={busy}
                        className="text-xs text-red-600 underline disabled:opacity-50"
                      >
                        欠品にする
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <p className="text-xs text-gray-500">店舗ごとの箱({storeCodes.length}店舗)</p>
                <button
                  onClick={() => {
                    if (window.confirm(`${todoStores.length}店舗分のラベルを発行・印刷します。よろしいですか?`))
                      issueStores(b, todoStores);
                  }}
                  disabled={busy || todoStores.length === 0}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  未発行の全店舗を一括発行({todoStores.length}店舗)
                </button>
              </div>
              <div className="border-t border-gray-200">
                {info.map(({ sc, contents, state }) => {
                  const s = data.stores[sc];
                  return (
                    <div key={sc} className="py-2 border-b border-gray-100 flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
                      <div className="flex-1 min-w-0 sm:w-44 sm:flex-none">
                        {sc} {s?.store_name ?? ""}
                        {s?.sign ? <span className="text-gray-400">({s.sign})</span> : null}
                      </div>
                      <div className="order-last w-full text-xs text-gray-600 sm:order-none sm:w-auto sm:flex-1">
                        {contents.length === 0
                          ? "(内訳なし)"
                          : contents.map((c) => `${c.line.item_name}${c.row.case_count}`).join(" / ")}
                      </div>
                      <div className="shrink-0 text-right sm:w-40">
                        {state === "done" ? (
                          <>
                            <span className="text-green-600 text-xs mr-2">発行済み</span>
                            <button
                              onClick={() => reprintStore(b, sc)}
                              disabled={busy}
                              className="border border-gray-300 rounded px-2 py-1 text-xs disabled:opacity-50"
                            >
                              再印刷
                            </button>
                          </>
                        ) : state === "empty" ? (
                          <span className="text-xs text-gray-400">対象なし</span>
                        ) : (
                          <>
                            {state === "partial" && <span className="text-amber-600 text-xs mr-2">一部のみ</span>}
                            <button
                              onClick={() => issueStores(b, [sc])}
                              disabled={busy}
                              className="bg-brand text-white rounded px-3 py-1 text-xs disabled:opacity-40"
                            >
                              発行
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
    </div>
  );
}
