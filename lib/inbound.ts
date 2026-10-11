// 入荷・ラベル発行の計算ロジック(画面に依存しない部分)。
// 数量はすべて「箱数(ケース数)」。入数ごとに分けて管理する(入数混載の品目に対応するため)。

// 伝票上の店舗の並び順(左から右)。60が50・51より左にある点に注意。
export const SLIP_STORE_ORDER = ["20", "30", "35", "40", "45", "60", "50", "51", "77", "78", "90"];

export type StoreQtyRow = { id: number; store_code: string; pack_size: number; case_count: number };
export type ArrivalRow = { pack_size: number; case_count: number };
export type LabelRow = { order_line_store_qty_id: number; pack_size: number; case_count: number };

export type ArrivalStatus = "未入荷" | "一部入荷" | "入荷完了" | "欠品確定";

// PostgRESTは、結合したデータを「1件のオブジェクト」または「配列」で返すことがあるため、1件に揃える
export function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export function slipOrderIndex(storeCode: string): number {
  const i = SLIP_STORE_ORDER.indexOf(storeCode);
  return i === -1 ? 999 : i;
}

export function sortBySlipOrder<T extends { store_code: string; id: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => slipOrderIndex(a.store_code) - slipOrderIndex(b.store_code) || a.id - b.id);
}

// 入数ごとに箱数を合計する
export function sumByPack<T extends { pack_size: number }>(
  rows: T[],
  pick: (r: T) => number
): Map<number, number> {
  const m = new Map<number, number>();
  rows.forEach((r) => m.set(r.pack_size, (m.get(r.pack_size) ?? 0) + pick(r)));
  return m;
}

// 店舗ごと(発注明細の店舗別数量ごと)の発行済み箱数
export function issuedByRow(labels: LabelRow[]): Map<number, number> {
  const m = new Map<number, number>();
  labels.forEach((l) =>
    m.set(l.order_line_store_qty_id, (m.get(l.order_line_store_qty_id) ?? 0) + l.case_count)
  );
  return m;
}

// 品目の入荷状態を計算する。
//   未入荷   : 入荷の記録が1件もない
//   一部入荷 : 入荷の記録はあるが、「全量入荷して全店舗分を発行済み」にはなっていない
//   入荷完了 : 全量入荷し、全店舗分のラベルを発行済み(品目一覧から除外される)
//   欠品確定 : 担当者が手動で入荷を完了させた(未発行の残りは欠品)。この状態は自動では変えない
export function computeStatus(
  storeQty: StoreQtyRow[],
  arrivals: ArrivalRow[],
  labels: LabelRow[],
  current: string
): ArrivalStatus {
  if (current === "欠品確定") return "欠品確定";

  const arrivedTotal = arrivals.reduce((a, r) => a + r.case_count, 0);
  if (arrivedTotal === 0) return "未入荷";

  const ordered = sumByPack(storeQty, (r) => r.case_count);
  const arrived = sumByPack(arrivals, (r) => r.case_count);
  const fullyArrived = Array.from(ordered.entries()).every(
    ([pack, n]) => (arrived.get(pack) ?? 0) >= n
  );

  const orderedTotal = storeQty.reduce((a, r) => a + r.case_count, 0);
  const issuedTotal = labels.reduce((a, r) => a + r.case_count, 0);

  return fullyArrived && issuedTotal >= orderedTotal ? "入荷完了" : "一部入荷";
}

// ラベル発行の前に、最新のデータで「発行してよいか」を検証する。問題があればメッセージを返す。
//   ・各店舗の発注箱数を超えて発行しない
//   ・入数ごとの累計入荷箱数を超えて発行しない
export function validateIssue(
  storeQty: StoreQtyRow[],
  arrivals: ArrivalRow[],
  labels: LabelRow[],
  targets: { rowId: number; cases: number }[]
): string | null {
  const issuedRow = issuedByRow(labels);
  const arrived = sumByPack(arrivals, (r) => r.case_count);
  const issuedPack = sumByPack(labels, (r) => r.case_count);
  const requestedPack = new Map<number, number>();

  for (const t of targets) {
    const row = storeQty.find((r) => r.id === t.rowId);
    if (!row) return "対象の店舗が見つかりません。画面を更新してもう一度お試しください";
    if (!Number.isInteger(t.cases) || t.cases < 1) return "箱数は1以上の整数で入力してください";

    const remaining = row.case_count - (issuedRow.get(row.id) ?? 0);
    if (t.cases > remaining) {
      return `店舗 ${row.store_code} の残りは${remaining}箱です(${t.cases}箱は発行できません)`;
    }
    requestedPack.set(row.pack_size, (requestedPack.get(row.pack_size) ?? 0) + t.cases);
  }

  for (const [pack, cases] of Array.from(requestedPack.entries())) {
    const available = (arrived.get(pack) ?? 0) - (issuedPack.get(pack) ?? 0);
    if (cases > available) {
      return `入数${pack}の発行可能数は${Math.max(0, available)}箱です(${cases}箱は入荷数を超えるため発行できません)。先に入荷数を記録してください`;
    }
  }
  return null;
}
