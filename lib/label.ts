// ラベル印刷まわりの共通部品。
// 印刷は、ブラウザに入れた「Brother b-PAC Extension」経由で、FZ-M1につないだQL-1115NWBに送る。

// ラベルのテンプレート(P-touch Editorで作った .lbx ファイル)の置き場所。
// 印刷するPC(FZ-M1)の中のこの場所にファイルを置く。
export const LABEL_TEMPLATE_PATH = "C:\\logisys\\label.lbx";

// プリンター名の初期値。Windowsの「デバイスとプリンター」に表示されている名前と同じにする。
// 画面から変更でき、変更した名前はその端末のブラウザに保存される。
export const DEFAULT_PRINTER_NAME = "Brother QL-1115NWB";
const PRINTER_STORAGE_KEY = "logisys:printer_name";

export function getPrinterName(): string {
  if (typeof window === "undefined") return DEFAULT_PRINTER_NAME;
  return window.localStorage.getItem(PRINTER_STORAGE_KEY) || DEFAULT_PRINTER_NAME;
}

export function setPrinterName(name: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PRINTER_STORAGE_KEY, name.trim() || DEFAULT_PRINTER_NAME);
}

// テンプレートに差し込む値。キー名は、テンプレート(.lbx)の中のオブジェクト名と
// 完全に一致させる必要がある(P-touch Editorで各オブジェクトにこの名前を付ける)。
//   item     品目名
//   store    店舗名(記号)  例:小原店(B)
//   qty      入数×箱数     例:20×3
//   origin   産地
//   spec     規格
//   date     納品日
//   supplier 仕入先
//   qr       QRコード(ラベル番号)
export type LabelPrintData = {
  item: string;
  store: string;
  qty: string;
  origin: string;
  spec: string;
  date: string;
  supplier: string;
  qr: string;
};

// ラベル番号(QRコードの内容)。「仕入先コード-納品日(YYMMDD)-連番4桁」
// 例:185091-260924-0001
// 形式を変えたくなったら、この関数だけを直せばよい。
export function formatLabelId(supplierCode: string, targetDate: string, no: number): string {
  const [y, m, d] = targetDate.split("-");
  return `${supplierCode}-${y.slice(2)}${m}${d}-${String(no).padStart(4, "0")}`;
}

// 店舗名(記号)。記号が未登録の店舗は店舗名だけにする。
export function formatStoreLabel(storeName: string, sign: string | null | undefined): string {
  return sign ? `${storeName}（${sign}）` : storeName;
}

// 例外から画面に出す文字列を取り出す(bpac-jsは文字列やオブジェクトを投げることがある)
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

// ラベルを1枚印刷する。失敗した場合は例外を投げる。
// ※ 印刷データをプリンターに送れたことしか確認できない。カバーが開いている等の
//   物理的なエラーは検知できないため、出てきたラベルを目視で確認する運用とする。
export async function printLabel(data: LabelPrintData): Promise<void> {
  // ブラウザ側(拡張機能)でしか動かないライブラリなので、使うときに読み込む
  const { default: BrotherSDK } = await import("bpac-js");
  const label = new BrotherSDK({
    templatePath: LABEL_TEMPLATE_PATH,
    printer: getPrinterName(),
  });
  // ignoreMissingKeys は指定しない(既定=false)。テンプレートに無い名前があれば
  // エラーにして、見本の文字のままのラベルが印刷されるのを防ぐ。
  const ok = await label.print(
    {
      item: data.item,
      store: data.store,
      qty: data.qty,
      origin: data.origin,
      spec: data.spec,
      date: data.date,
      supplier: data.supplier,
      qr: data.qr,
    },
    { copies: 1, printName: "logisys", ignoreMissingKeys: true }
  );
  if (!ok) throw new Error("プリンターに印刷データを送信できませんでした");
}
