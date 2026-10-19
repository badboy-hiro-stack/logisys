// 出荷検品の共通部品。

// データベースのビュー(v_labels)の1行。ラベル1枚の、店舗・品目・納品日・確定状況をまとめたもの。
export type LabelView = {
  label_id: string;
  status: string; // 未検品 / 検品済 / 無効
  pack_size: number;
  case_count: number;
  qty: number;
  qty_text: string | null; // ラベルに出す数量の文字(ケース/ばら対応)
  label_kind: string;
  unit_size: number | null;
  bundle_items: { item_name: string; qty: number }[] | null; // まとめラベルの中身の内訳
  issued_at: string;
  store_qty_id: number;
  store_code: string;
  store_name: string;
  store_sign: string | null;
  order_line_id: number;
  item_code: string;
  item_name: string;
  spec: string | null;
  origin: string | null;
  target_date: string;
  supplier_code: string;
  supplier_name: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
};

// ログイン時に選んだ拠点(端末のブラウザに保存してある)
export function getLocationId(): number | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem("logisys:location_id");
  return v ? Number(v) : null;
}

// 「35 佐原店（G）」のような表示用の店舗名
export function storeTitle(code: string, name: string, sign: string | null | undefined): string {
  return `${code} ${name}${sign ? `（${sign}）` : ""}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
