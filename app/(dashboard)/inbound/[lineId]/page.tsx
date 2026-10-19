"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  computeStatus,
  issuedByRow,
  one,
  sortBySlipOrder,
  sumByPack,
  validateIssue,
  type LabelRow,
  type StoreQtyRow,
} from "@/lib/inbound";
import {
  errorText,
  formatLabelId,
  formatStoreLabel,
  getPrinterName,
  printLabel,
  setPrinterName,
  type LabelPrintData,
} from "@/lib/label";

type LineInfo = {
  order_line_id: number;
  item_code: string;
  item_name: string;
  spec: string | null;
  origin: string | null;
  total_display: string | null;
  arrival_status: string;
  unit_default: number | null; // 株数管理品のケース入数の標準値(通常の品目は null)
  bundle_group: string | null; // まとめグループ(ハーブ類など)。設定されている品目はまとめ入荷で処理する
  supplier_code: string;
  supplier_name: string;
  target_date: string;
};
type StoreInfo = { store_name: string; sign: string | null };
type ArrivalFull = {
  arrival_id: number;
  pack_size: number;
  case_count: number;
  arrived_at: string;
  unit_size: number | null;
};
type Fresh = {
  line: LineInfo;
  rows: StoreQtyRow[];
  arrivals: ArrivalFull[];
  labels: LabelRow[];
  stores: Record<string, StoreInfo>;
  originByRow: Record<number, string>; // 店舗ごとの指定産地(空なら明細行の産地を使う)
  issuedLabels: IssuedLabel[]; // 発行済み(無効でない)ラベル
};
type IssuedLabel = {
  label_id: string;
  order_line_store_qty_id: number;
  pack_size: number;
  case_count: number;
  label_kind: string;
  unit_size: number | null;
};
// 発行するラベル1枚分(units = ラベルの case_count。株数管理品では株数)
type LabelSpec = { row: StoreQtyRow; units: number; kind: "通常" | "ケース" | "ばら"; unitSize: number | null };

// 株数を、ケース分とばら分のラベルに分ける
function splitUnits(row: StoreQtyRow, units: number, size: number): LabelSpec[] {
  const specs: LabelSpec[] = [];
  const cases = Math.floor(units / size);
  const loose = units % size;
  if (cases > 0) specs.push({ row, units: cases * size, kind: "ケース", unitSize: size });
  if (loose > 0) specs.push({ row, units: loose, kind: "ばら", unitSize: size });
  return specs;
}

// ラベル・画面に出す数量の文字
function qtyText(kind: string, pack: number, units: number, unitSize: number | null): string {
  if (kind === "ケース" && unitSize && unitSize > 0) return `${unitSize}株×${units / unitSize}ケース`;
  if (kind === "ばら") return `${units}株(ばら)`;
  return `${pack}×${units}`;
}
type PendingPrint = { label_id: string; data: LabelPrintData };
type Message = { type: "ok" | "error"; text: string };

type RawOrder = {
  supplier_code: string;
  target_date: string;
  m_suppliers: { supplier_name: string } | { supplier_name: string }[] | null;
};
type RawLine = {
  order_line_id: number;
  item_code: string;
  spec: string | null;
  origin: string | null;
  total_display: string | null;
  arrival_status: string;
  m_items:
    | { item_name: string; loose_case_size: number | null; bundle_group: string | null }
    | { item_name: string; loose_case_size: number | null; bundle_group: string | null }[]
    | null;
  t_orders: RawOrder | RawOrder[] | null;
};

export default function LineDetailPage() {
  const supabase = createClient();
  const params = useParams<{ lineId: string }>();
  const lineId = Number(params.lineId);

  const [data, setData] = useState<Fresh | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [failedPrints, setFailedPrints] = useState<PendingPrint[]>([]);
  const [arrivalInput, setArrivalInput] = useState<Record<number, string>>({});
  const [issueInput, setIssueInput] = useState<Record<number, string>>({});
  const [printer, setPrinter] = useState("");
  const [caseSizeInput, setCaseSizeInput] = useState<string>(""); // 株数管理品:今回のケース入数

  // ---- データの取得 ----------------------------------------------------
  const fetchAll = useCallback(async (): Promise<Fresh> => {
    const { data: lineData, error: lineErr } = await supabase
      .from("t_order_lines")
      .select(
        "order_line_id, item_code, spec, origin, total_display, arrival_status, " +
          "m_items(item_name, loose_case_size, bundle_group), t_orders(supplier_code, target_date, m_suppliers(supplier_name))"
      )
      .eq("order_line_id", lineId)
      .single();
    if (lineErr || !lineData) {
      throw new Error("品目の取得に失敗しました: " + (lineErr?.message ?? "データがありません"));
    }
    const raw = lineData as unknown as RawLine;
    const order = one(raw.t_orders);
    if (!order) throw new Error("発注ヘッダが見つかりません");

    const line: LineInfo = {
      order_line_id: raw.order_line_id,
      item_code: raw.item_code,
      item_name: one(raw.m_items)?.item_name ?? raw.item_code,
      spec: raw.spec,
      origin: raw.origin,
      total_display: raw.total_display,
      arrival_status: raw.arrival_status,
      unit_default: one(raw.m_items)?.loose_case_size ?? null,
      bundle_group: one(raw.m_items)?.bundle_group ?? null,
      supplier_code: order.supplier_code,
      supplier_name: one(order.m_suppliers)?.supplier_name ?? order.supplier_code,
      target_date: order.target_date,
    };

    const [sq, ar, st] = await Promise.all([
      supabase
        .from("t_order_line_store_qty")
        .select("id, store_code, pack_size, case_count, origin")
        .eq("order_line_id", lineId),
      supabase
        .from("t_arrivals")
        .select("arrival_id, pack_size, case_count, arrived_at, unit_size")
        .eq("order_line_id", lineId)
        .order("arrival_id"),
      supabase.from("m_stores").select("store_code, store_name, sign"),
    ]);
    if (sq.error) throw new Error("店舗別数量の取得に失敗しました: " + sq.error.message);
    if (ar.error) throw new Error("入荷実績の取得に失敗しました: " + ar.error.message);
    if (st.error) throw new Error("店舗マスタの取得に失敗しました: " + st.error.message);

    const rows = sortBySlipOrder((sq.data ?? []) as unknown as StoreQtyRow[]);
    const originByRow: Record<number, string> = {};
    ((sq.data ?? []) as unknown as { id: number; origin: string | null }[]).forEach((r) => {
      if (r.origin) originByRow[r.id] = r.origin;
    });
    const arrivals = (ar.data ?? []) as unknown as ArrivalFull[];
    const stores: Record<string, StoreInfo> = {};
    ((st.data ?? []) as unknown as { store_code: string; store_name: string; sign: string | null }[]).forEach(
      (s) => {
        stores[s.store_code] = { store_name: s.store_name, sign: s.sign };
      }
    );

    let labels: LabelRow[] = [];
    let issuedLabels: IssuedLabel[] = [];
    if (rows.length > 0) {
      const lb = await supabase
        .from("t_labels")
        .select("label_id, order_line_store_qty_id, pack_size, case_count, label_kind, unit_size")
        .order("label_id")
        .in(
          "order_line_store_qty_id",
          rows.map((r) => r.id)
        )
        .neq("status", "無効");
      if (lb.error) throw new Error("ラベルの取得に失敗しました: " + lb.error.message);
      labels = (lb.data ?? []) as unknown as LabelRow[];
      issuedLabels = (lb.data ?? []) as unknown as IssuedLabel[];
    }

    return { line, rows, arrivals, labels, stores, originByRow, issuedLabels };
  }, [supabase, lineId]);

  // 入荷状態を計算し、変わっていればDBに保存したうえで、画面に反映する
  const refresh = useCallback(async (): Promise<Fresh> => {
    const fresh = await fetchAll();
    const status = computeStatus(
      fresh.rows,
      fresh.arrivals,
      fresh.labels,
      fresh.line.arrival_status
    );
    if (status !== fresh.line.arrival_status) {
      const { error } = await supabase
        .from("t_order_lines")
        .update({ arrival_status: status })
        .eq("order_line_id", lineId);
      if (error) throw new Error("入荷状態の更新に失敗しました: " + error.message);
      fresh.line.arrival_status = status;
    }
    setData(fresh);
    return fresh;
  }, [fetchAll, supabase, lineId]);

  useEffect(() => {
    setPrinter(getPrinterName());
    (async () => {
      try {
        await refresh();
      } catch (e) {
        setLoadError(errorText(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 計算 ------------------------------------------------------------
  const calc = useMemo(() => {
    if (!data) return null;
    const ordered = sumByPack(data.rows, (r) => r.case_count);
    const arrived = sumByPack(data.arrivals, (r) => r.case_count);
    const issued = sumByPack(data.labels, (r) => r.case_count);
    const issuedRow = issuedByRow(data.labels);
    const packs = Array.from(ordered.keys()).sort((a, b) => a - b);
    const available = (pack: number) => (arrived.get(pack) ?? 0) - (issued.get(pack) ?? 0);
    const remainingOf = (r: StoreQtyRow) => r.case_count - (issuedRow.get(r.id) ?? 0);
    return { ordered, arrived, issued, packs, available, remainingOf };
  }, [data]);

  // 株数管理品(セロリなど)かどうかと、使うケース入数(画面の入力 → 直近の入荷 → 品目マスタの標準値)
  const isUnit = data?.line.unit_default != null;
  const caseSize = (() => {
    const typed = Number(caseSizeInput);
    if (caseSizeInput !== "" && Number.isInteger(typed) && typed > 0) return typed;
    const lastArrival = data ? [...data.arrivals].reverse().find((a) => a.unit_size) : undefined;
    return lastArrival?.unit_size ?? data?.line.unit_default ?? 0;
  })();

  const closed = data?.line.arrival_status === "欠品確定";

  // ---- 共通の補助 ------------------------------------------------------
  async function getActor() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const loc = typeof window !== "undefined" ? window.localStorage.getItem("logisys:location_id") : null;
    return { userId: user?.id ?? null, locationId: loc ? Number(loc) : null };
  }

  function buildPrintData(
    fresh: Fresh,
    row: StoreQtyRow,
    cases: number,
    labelId: string,
    kind: string = "通常",
    unitSize: number | null = null
  ): LabelPrintData {
    const store = fresh.stores[row.store_code];
    return {
      item: fresh.line.item_name,
      store: formatStoreLabel(store?.store_name ?? row.store_code, store?.sign),
      qty: qtyText(kind, row.pack_size, cases, unitSize),
      origin: fresh.originByRow[row.id] ?? fresh.line.origin ?? "",
      spec: fresh.line.spec ?? "",
      date: fresh.line.target_date.replace(/-/g, "/"),
      supplier: fresh.line.supplier_name,
      qr: labelId,
    };
  }

  // ---- 入荷の記録 ------------------------------------------------------
  async function recordArrival() {
    if (!calc) return;
    let entries: { pack: number; cases: number; unit: number | null }[];
    if (isUnit) {
      // 株数管理品:ケース数 × ケース入数 を「株数」として記録する
      const cases = Number(arrivalInput[1] || 0);
      if (!Number.isInteger(cases) || cases < 1) {
        setMessage({ type: "error", text: "今回の入荷ケース数を1以上の整数で入力してください" });
        return;
      }
      if (!caseSize) {
        setMessage({ type: "error", text: "ケース入数を入力してください" });
        return;
      }
      entries = [{ pack: 1, cases: cases * caseSize, unit: caseSize }];
    } else {
      entries = calc.packs
        .map((p) => ({ pack: p, cases: Number(arrivalInput[p] || 0), unit: null as number | null }))
        .filter((e) => e.cases !== 0);
      if (entries.length === 0) {
        setMessage({ type: "error", text: "今回の入荷数(箱)を入力してください" });
        return;
      }
      if (entries.some((e) => !Number.isInteger(e.cases) || e.cases < 1)) {
        setMessage({ type: "error", text: "入荷数は1以上の整数で入力してください" });
        return;
      }
    }
    setBusy(true);
    setMessage(null);
    try {
      const { userId, locationId } = await getActor();
      const { error } = await supabase.from("t_arrivals").insert(
        entries.map((e) => ({
          order_line_id: lineId,
          pack_size: e.pack,
          case_count: e.cases,
          unit_size: e.unit,
          user_id: userId,
          location_id: locationId,
        }))
      );
      if (error) throw error;
      setArrivalInput({});
      await refresh();
      setMessage({ type: "ok", text: "入荷数を記録しました" });
    } catch (e) {
      setMessage({ type: "error", text: "入荷数の記録に失敗しました: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  // 入力ミスの取り消し。取り消すと、発行済みのラベル数が入荷数を上回る場合は取り消せない
  async function cancelArrival(a: ArrivalFull) {
    if (!calc) return;
    const arrivedP = calc.arrived.get(a.pack_size) ?? 0;
    const issuedP = calc.issued.get(a.pack_size) ?? 0;
    if (arrivedP - a.case_count < issuedP) {
      setMessage({
        type: "error",
        text: "この入荷記録を取り消すと、発行済みのラベルの数量が入荷数を上回ってしまうため、取り消せません",
      });
      return;
    }
    const desc =
      a.unit_size && a.unit_size > 0
        ? `${a.unit_size}株×${a.case_count / a.unit_size}ケース`
        : `入数${a.pack_size}・${a.case_count}箱`;
    if (!window.confirm(`入荷記録(${desc})を取り消します。よろしいですか?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase.from("t_arrivals").delete().eq("arrival_id", a.arrival_id);
      if (error) throw error;
      await refresh();
      setMessage({ type: "ok", text: "入荷記録を取り消しました" });
    } catch (e) {
      setMessage({ type: "error", text: "取り消しに失敗しました: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  // ---- ラベルの印刷 ----------------------------------------------------
  // 1枚ずつ順番に印刷する。途中で失敗したら、そこで止めて、未印刷分を記録しておく
  async function printAll(items: PendingPrint[]): Promise<boolean> {
    for (let i = 0; i < items.length; i++) {
      setProgress(`${i + 1}/${items.length}枚目を印刷中…`);
      try {
        await printLabel(items[i].data);
      } catch (e) {
        setFailedPrints(items.slice(i));
        setProgress(null);
        setMessage({
          type: "error",
          text:
            `${i + 1}枚目の印刷でエラーが発生しました: ${errorText(e)}。` +
            "ラベルの番号は登録済みです。b-PAC拡張機能・プリンター名・テンプレート(C:\\logisys\\label.lbx)を確認して、" +
            "「未印刷のラベルを再印刷」を押してください",
        });
        return false;
      }
    }
    setFailedPrints([]);
    setProgress(null);
    return true;
  }

  // 発行済みのラベルを、番号を変えずにそのまま印刷し直す(印刷エラー・別端末で発行した場合など)
  async function reprintIssued(labels: IssuedLabel[]) {
    if (!data || labels.length === 0) return;
    if (labels.length > 1 && !window.confirm(`${labels.length}枚のラベルを再印刷します。よろしいですか?`)) return;
    setBusy(true);
    setMessage(null);
    setFailedPrints([]);
    try {
      const items: PendingPrint[] = [];
      for (const l of labels) {
        const row = data.rows.find((r) => r.id === l.order_line_store_qty_id);
        if (!row) continue;
        items.push({
          label_id: l.label_id,
          data: buildPrintData(
            data,
            { ...row, pack_size: l.pack_size },
            l.case_count,
            l.label_id,
            l.label_kind,
            l.unit_size
          ),
        });
      }
      const ok = await printAll(items);
      if (ok) setMessage({ type: "ok", text: `${items.length}枚を再印刷しました。出てきたラベルを確認してください` });
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

  // ラベルの発行。①最新の状態で検証 → ②番号を確保 → ③DBに登録 → ④印刷
  async function issue(specs: LabelSpec[]) {
    if (specs.length === 0) return;
    setBusy(true);
    setMessage(null);
    setFailedPrints([]);
    try {
      const fresh = await refresh();
      // 同じ店舗のラベル(ケース+ばら)は合計して検証する
      const perRow = new Map<number, number>();
      specs.forEach((s) => perRow.set(s.row.id, (perRow.get(s.row.id) ?? 0) + s.units));
      const problem = validateIssue(
        fresh.rows,
        fresh.arrivals,
        fresh.labels,
        Array.from(perRow.entries()).map(([rowId, cases]) => ({ rowId, cases }))
      );
      if (problem) {
        setMessage({ type: "error", text: problem });
        return;
      }

      const { userId, locationId } = await getActor();
      const count = specs.length;
      const { data: last, error: rpcErr } = await supabase.rpc("reserve_label_numbers", {
        p_supplier: fresh.line.supplier_code,
        p_date: fresh.line.target_date,
        p_count: count,
      });
      if (rpcErr) throw rpcErr;
      const first = (last as number) - count + 1;

      const newLabels = specs.map((s, i) => ({
        label_id: formatLabelId(fresh.line.supplier_code, fresh.line.target_date, first + i),
        order_line_store_qty_id: s.row.id,
        pack_size: s.row.pack_size,
        case_count: s.units,
        qty: s.row.pack_size * s.units,
        label_kind: s.kind,
        unit_size: s.unitSize,
        issued_by: userId,
        location_id: locationId,
      }));
      const { error: insErr } = await supabase.from("t_labels").insert(newLabels);
      if (insErr) throw insErr;

      const updated = await refresh();
      setIssueInput({});

      const pending: PendingPrint[] = newLabels.map((l, i) => ({
        label_id: l.label_id,
        data: buildPrintData(updated, specs[i].row, specs[i].units, l.label_id, specs[i].kind, specs[i].unitSize),
      }));
      const ok = await printAll(pending);
      if (ok) {
        setMessage({
          type: "ok",
          text: `${count}枚のラベルを発行・印刷しました。出てきたラベルを確認してください(番号:${newLabels[0].label_id}${count > 1 ? " 〜" : ""})`,
        });
      }
    } catch (e) {
      setMessage({ type: "error", text: "ラベルの発行に失敗しました: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  // 1店舗分のラベル仕様(株数管理品はケースとばらに分ける)
  function specsFor(row: StoreQtyRow, units: number): LabelSpec[] {
    if (isUnit) return splitUnits(row, units, caseSize);
    return [{ row, units, kind: "通常", unitSize: null }];
  }

  function issueOne(row: StoreQtyRow) {
    if (!calc) return;
    if (isUnit && !caseSize) {
      setMessage({ type: "error", text: "ケース入数を入力してください" });
      return;
    }
    const remaining = calc.remainingOf(row);
    const maxIssuable = Math.max(0, Math.min(remaining, calc.available(row.pack_size)));
    const raw = issueInput[row.id];
    const cases = raw === undefined || raw === "" ? maxIssuable : Number(raw);
    const unitWord = isUnit ? "株" : "箱";
    if (!Number.isInteger(cases) || cases < 1) {
      setMessage({
        type: "error",
        text:
          maxIssuable === 0
            ? "発行できる数がありません(入荷数を記録してください)"
            : `${unitWord}数は1以上の整数で入力してください`,
      });
      return;
    }
    if (cases > maxIssuable) {
      setMessage({ type: "error", text: `この店舗で今発行できるのは${maxIssuable}${unitWord}までです` });
      return;
    }
    issue(specsFor(row, cases));
  }

  function issueBulk(pack: number) {
    if (!data || !calc) return;
    if (isUnit && !caseSize) {
      setMessage({ type: "error", text: "ケース入数を入力してください" });
      return;
    }
    const specs = data.rows
      .filter((r) => r.pack_size === pack)
      .map((r) => ({ row: r, n: calc.remainingOf(r) }))
      .filter((t) => t.n > 0)
      .flatMap((t) => specsFor(t.row, t.n));
    if (specs.length === 0) return;
    if (!window.confirm(`${specs.length}枚のラベルを発行・印刷します。よろしいですか?`)) return;
    issue(specs);
  }

  // ---- 入荷完了(欠品確定)と再開 ---------------------------------------
  async function closeLine() {
    if (!data || !calc) return;
    const remainingTotal = data.rows.reduce((a, r) => a + calc.remainingOf(r), 0);
    if (
      !window.confirm(
        `未発行の${remainingTotal}${isUnit ? "株" : "箱"}分を欠品として記録し、この品目の入荷を完了します。よろしいですか?`
      )
    )
      return;
    setBusy(true);
    setMessage(null);
    try {
      const { userId } = await getActor();
      const { error } = await supabase
        .from("t_order_lines")
        .update({
          arrival_status: "欠品確定",
          arrival_closed_by: userId,
          arrival_closed_at: new Date().toISOString(),
        })
        .eq("order_line_id", lineId);
      if (error) throw error;
      await refresh();
      setMessage({ type: "ok", text: "入荷を完了しました(未発行の残りは欠品として記録されます)" });
    } catch (e) {
      setMessage({ type: "error", text: "入荷完了の処理に失敗しました: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function reopenLine() {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      const status = computeStatus(data.rows, data.arrivals, data.labels, "");
      const { error } = await supabase
        .from("t_order_lines")
        .update({ arrival_status: status, arrival_closed_by: null, arrival_closed_at: null })
        .eq("order_line_id", lineId);
      if (error) throw error;
      await refresh();
      setMessage({ type: "ok", text: "入荷を再開しました" });
    } catch (e) {
      setMessage({ type: "error", text: "入荷の再開に失敗しました: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  // ---- 表示 ------------------------------------------------------------
  if (loading) return <p className="text-sm text-gray-500">読み込み中…</p>;
  if (loadError || !data || !calc) {
    return (
      <div>
        <p className="text-sm text-red-600 mb-3">{loadError ?? "データを取得できませんでした"}</p>
        <Link href="/inbound" className="text-sm text-brand underline">
          ← 品目一覧へ戻る
        </Link>
      </div>
    );
  }

  const { line, rows, arrivals, stores, originByRow, issuedLabels } = data;

  // まとめグループの品目(ハーブ類など)は、まとめ入荷の画面で処理する
  if (line.bundle_group) {
    return (
      <div className="max-w-3xl">
        <Link href="/inbound" className="text-sm text-brand underline">
          ← 品目一覧へ
        </Link>
        <h1 className="text-lg font-semibold mt-2 mb-3">{line.item_name}</h1>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
          <p className="mb-3">
            この品目は「{line.bundle_group}」として、店舗ごとに1箱・ラベル1枚にまとめて処理します。
            まとめ入荷の画面で入荷とラベル発行を行ってください(欠品もそこで設定できます)。
          </p>
          <Link href="/inbound/bundle" className="inline-block bg-brand text-white rounded-lg px-4 py-2">
            まとめ入荷の画面へ
          </Link>
        </div>
      </div>
    );
  }
  const statusColor: Record<string, string> = {
    未入荷: "bg-gray-100 text-gray-600",
    一部入荷: "bg-amber-100 text-amber-700",
    入荷完了: "bg-green-100 text-green-700",
    欠品確定: "bg-red-100 text-red-700",
  };

  return (
    <div className="max-w-3xl">
      <Link href="/inbound" className="text-sm text-brand underline">
        ← 品目一覧へ
      </Link>

      <div className="flex items-baseline gap-3 mt-2 mb-1 flex-wrap">
        <h1 className="text-lg font-semibold">
          {line.item_name}
          {line.spec ? <span className="text-gray-500 font-normal"> {line.spec}</span> : null}
        </h1>
        <span className={"text-xs px-2 py-0.5 rounded-full " + (statusColor[line.arrival_status] ?? "")}>
          {line.arrival_status}
        </span>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        {line.supplier_name} / 納品日 {line.target_date.replace(/-/g, "/")} / EOS {line.item_code}
        {line.origin ? ` / 産地:${line.origin}` : ""} /{" "}
        {isUnit
          ? `全店計 ${rows.reduce((a, r) => a + r.case_count, 0)}株(株数管理品)`
          : `全店計 ${line.total_display ?? ""}`}
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

      {/* 入荷数の入力 */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        {isUnit ? (
          <>
            <h2 className="text-sm font-semibold mb-1">① 入荷数を記録(ケース数)</h2>
            <p className="text-xs text-gray-500 mb-3">
              株数で管理する品目です。伝票の「入数×」は無視して、数字を株数として扱います。
              入荷したケースの入数(2L・L・Mなどで変わります)とケース数を入力してください。
            </p>
            <div className="flex flex-wrap items-end gap-4 mb-3 text-sm">
              <label className="flex flex-col text-xs text-gray-500">
                ケース入数(株/ケース)
                <input
                  type="number"
                  min={1}
                  value={caseSizeInput !== "" ? caseSizeInput : caseSize ? String(caseSize) : ""}
                  onChange={(e) => setCaseSizeInput(e.target.value)}
                  disabled={busy || closed}
                  className="border border-gray-300 rounded px-2 py-1 text-sm text-right w-28 mt-1"
                />
              </label>
              <label className="flex flex-col text-xs text-gray-500">
                今回の入荷ケース数
                <input
                  type="number"
                  min={1}
                  value={arrivalInput[1] ?? ""}
                  onChange={(e) => setArrivalInput({ ...arrivalInput, 1: e.target.value })}
                  disabled={busy || closed}
                  placeholder="ケース"
                  className="border border-gray-300 rounded px-2 py-1 text-sm text-right w-28 mt-1"
                />
              </label>
              <span className="text-xs text-gray-500 pb-1">
                {Number(arrivalInput[1] || 0) > 0 && caseSize
                  ? `= ${Number(arrivalInput[1]) * caseSize}株`
                  : ""}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-x-3 text-xs text-gray-500 pb-2 border-b border-gray-200">
              <span>発注</span>
              <span>累計入荷</span>
              <span>発行可能(残)</span>
            </div>
            <div className="grid grid-cols-3 gap-x-3 py-2 text-sm border-b border-gray-100">
              <span>
                {calc.ordered.get(1) ?? 0}株
                {caseSize ? (
                  <span className="text-xs text-gray-500">
                    {" "}
                    (約{Math.ceil((calc.ordered.get(1) ?? 0) / caseSize)}ケース)
                  </span>
                ) : null}
              </span>
              <span>{calc.arrived.get(1) ?? 0}株</span>
              <span className="text-brand font-medium">{Math.max(0, calc.available(1))}株</span>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold mb-3">① 入荷数を記録(箱数)</h2>
            <div className="grid grid-cols-[5rem_1fr_1fr_1fr_7rem] gap-x-3 text-xs text-gray-500 pb-2 border-b border-gray-200">
              <span>入数</span>
              <span>発注</span>
              <span>累計入荷</span>
              <span>発行可能(残)</span>
              <span>今回の入荷数</span>
            </div>
            {calc.packs.map((p) => (
              <div
                key={p}
                className="grid grid-cols-[5rem_1fr_1fr_1fr_7rem] gap-x-3 items-center py-2 text-sm border-b border-gray-100"
              >
                <span className="font-medium">{p}入り</span>
                <span>{calc.ordered.get(p) ?? 0}箱</span>
                <span>{calc.arrived.get(p) ?? 0}箱</span>
                <span className="text-brand font-medium">{Math.max(0, calc.available(p))}箱</span>
                <input
                  type="number"
                  min={1}
                  value={arrivalInput[p] ?? ""}
                  onChange={(e) => setArrivalInput({ ...arrivalInput, [p]: e.target.value })}
                  disabled={busy || closed}
                  placeholder="箱"
                  className="border border-gray-300 rounded px-2 py-1 text-sm text-right w-full"
                />
              </div>
            ))}
          </>
        )}
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={recordArrival}
            disabled={busy || closed}
            className="bg-brand text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
          >
            入荷を記録
          </button>
          {!isUnit && calc.packs.length > 1 && (
            <span className="text-xs text-gray-500">入数混載の品目です。入数ごとに入荷数を入力してください</span>
          )}
        </div>

        {arrivals.length > 0 && (
          <details className="mt-4 text-xs text-gray-600">
            <summary className="cursor-pointer">入荷の記録({arrivals.length}件)・入力ミスの取り消し</summary>
            <ul className="mt-2 space-y-1">
              {arrivals.map((a) => (
                <li key={a.arrival_id} className="flex items-center gap-3">
                  <span>
                    {new Date(a.arrived_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span>
                    {a.unit_size
                      ? `${a.unit_size}株×${a.case_count / a.unit_size}ケース(${a.case_count}株)`
                      : `入数${a.pack_size} / ${a.case_count}箱`}
                  </span>
                  <button
                    onClick={() => cancelArrival(a)}
                    disabled={busy || closed}
                    className="text-red-600 underline disabled:opacity-50"
                  >
                    取り消す
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ラベルの発行 */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold">② 店舗別にラベルを発行</h2>
          <label className="flex items-center gap-2 text-xs text-gray-500">
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

        <div className="flex flex-wrap gap-2 mb-4">
          {calc.packs.map((p) => {
            const ready = (calc.arrived.get(p) ?? 0) >= (calc.ordered.get(p) ?? 0);
            const targets = rows.filter((r) => r.pack_size === p && calc.remainingOf(r) > 0).length;
            const label =
              calc.packs.length > 1 && !isUnit ? `${p}入りの店舗を発注どおり一括発行` : "全店舗を発注どおり一括発行";
            return (
              <button
                key={p}
                onClick={() => issueBulk(p)}
                disabled={busy || closed || !ready || targets === 0}
                title={ready ? "" : "全量入荷するまでは、店舗ごとの個別発行になります"}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {label}({targets}枚)
              </button>
            );
          })}
        </div>

        {isUnit && (
          <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-3">
            {caseSize ? (
              (() => {
                const looseTotal = rows.reduce((a, r) => a + (r.case_count % caseSize), 0);
                return (
                  <>
                    ケース入数{caseSize}株。店舗ごとに「ケースのラベル」と「ばら(端数)のラベル」を発行します。
                    ばらの合計は<b>{looseTotal}株</b>
                    {looseTotal > 0 && looseTotal % caseSize === 0
                      ? `(=${looseTotal / caseSize}ケースをばらして分けます)`
                      : looseTotal > 0
                        ? `(ケース入数で割り切れません。発注数かケース入数を確認してください)`
                        : ""}
                    。
                  </>
                );
              })()
            ) : (
              "ケース入数を入力してください(① の欄)"
            )}
          </div>
        )}
        <div className="grid grid-cols-[1fr_5rem_4rem_4rem_5rem_4.5rem] gap-x-3 text-xs text-gray-500 pb-2 border-b border-gray-200">
          <span>店舗</span>
          <span>発注</span>
          <span>発行済</span>
          <span>残</span>
          <span>{isUnit ? "株数" : "箱数"}</span>
          <span />
        </div>
        {rows.map((r) => {
          const store = stores[r.store_code];
          const remaining = calc.remainingOf(r);
          const issuedN = r.case_count - remaining;
          const maxIssuable = Math.max(0, Math.min(remaining, calc.available(r.pack_size)));
          const done = remaining === 0;
          return (
            <div
              key={r.id}
              className={
                "grid grid-cols-[1fr_5rem_4rem_4rem_5rem_4.5rem] gap-x-3 items-center py-2 text-sm border-b border-gray-100 " +
                (!done && maxIssuable > 0 ? "bg-amber-50/50" : "")
              }
            >
              <span>
                {r.store_code} {store?.store_name ?? ""}
                {store?.sign ? <span className="text-gray-400">({store.sign})</span> : null}
                {originByRow[r.id] ? (
                  <span className="text-xs text-blue-700 ml-2">産地:{originByRow[r.id]}</span>
                ) : null}
              </span>
              <span>
                {isUnit ? (
                  <>
                    {r.case_count}株
                    {caseSize ? (
                      <span className="block text-[10px] text-gray-400">
                        {Math.floor(r.case_count / caseSize)}ケース
                        {r.case_count % caseSize ? `+${r.case_count % caseSize}株` : ""}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    {r.pack_size}×{r.case_count}
                  </>
                )}
              </span>
              <span className={done ? "text-green-600" : ""}>{issuedN}</span>
              <span className={done ? "text-green-600 font-medium" : "font-medium"}>{remaining}</span>
              {done ? (
                <span className="text-green-600 text-xs col-span-2">完了</span>
              ) : (
                <>
                  <input
                    type="number"
                    min={1}
                    value={issueInput[r.id] ?? ""}
                    onChange={(e) => setIssueInput({ ...issueInput, [r.id]: e.target.value })}
                    placeholder={String(maxIssuable)}
                    disabled={busy || closed || maxIssuable === 0}
                    className="border border-gray-300 rounded px-2 py-1 text-sm text-right w-full"
                  />
                  <button
                    onClick={() => issueOne(r)}
                    disabled={busy || closed || maxIssuable === 0}
                    className="bg-brand text-white rounded px-2 py-1 text-xs disabled:opacity-40"
                  >
                    発行
                  </button>
                </>
              )}
            </div>
          );
        })}
        <p className="text-xs text-gray-500 mt-3">
          {isUnit
            ? "株数を空欄のまま「発行」を押すと、その店舗で今発行できる最大の株数(薄い文字の数)で、ケースとばらのラベルを発行します。"
            : "箱数を空欄のまま「発行」を押すと、その店舗で今発行できる最大の箱数(薄い文字の数)で発行します。1つの店舗を複数のラベルに分けるときは、箱数を入れて何度か発行してください。"}
        </p>
      </section>

      {/* 発行済みラベルの再印刷(同じ番号) */}
      {issuedLabels.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              ③ 発行済みラベルの再印刷(同じ番号で印刷し直す・{issuedLabels.length}枚)
            </summary>
            <p className="text-xs text-gray-500 mt-2 mb-3">
              印刷エラーや、別の端末で発行して印刷できなかったときに使います。ラベルの番号は変わりません。
              印刷には、b-PAC拡張機能とプリンターがつながったパソコン(FZ-M1など)が必要です。
              汚れや破損でラベルを作り直すときは、「ラベル再発行」を使ってください。
            </p>
            <button
              onClick={() => reprintIssued(issuedLabels)}
              disabled={busy}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm mb-3 disabled:opacity-50"
            >
              すべて再印刷({issuedLabels.length}枚)
            </button>
            <ul className="divide-y divide-gray-100 text-sm">
              {issuedLabels.map((l) => {
                const store = stores[rows.find((r) => r.id === l.order_line_store_qty_id)?.store_code ?? ""];
                return (
                  <li key={l.label_id} className="py-2 flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-xs w-48">{l.label_id}</span>
                    <span className="flex-1">
                      {store?.store_name ?? ""}
                      {store?.sign ? <span className="text-gray-400">({store.sign})</span> : null}
                      <span className="ml-2 text-gray-600">
                        {qtyText(l.label_kind, l.pack_size, l.case_count, l.unit_size)}
                      </span>
                    </span>
                    <button
                      onClick={() => reprintIssued([l])}
                      disabled={busy}
                      className="border border-gray-300 rounded px-3 py-1 text-xs disabled:opacity-50"
                    >
                      再印刷
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      )}

      {/* 入荷の完了(欠品確定) */}
      <section className="mb-10">
        {closed ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-red-600">この品目は入荷完了(欠品確定)済みです。</span>
            <button
              onClick={reopenLine}
              disabled={busy}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm disabled:opacity-50"
            >
              入荷を再開する
            </button>
          </div>
        ) : line.arrival_status !== "入荷完了" ? (
          <button
            onClick={closeLine}
            disabled={busy}
            className="border border-gray-300 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
          >
            この品目の入荷を完了する(残りは欠品として記録)
          </button>
        ) : null}
      </section>
    </div>
  );
}
