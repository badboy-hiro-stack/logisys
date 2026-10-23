// ラベル印刷まわりの共通部品。
// 印刷は、端末によって方法が違う。
//   ・Windows(FZ-M1など):ブラウザに入れた「Brother b-PAC Extension」経由で、つないだQL-1115NWBに送る。
//   ・Android:Brother公式アプリ「Smooth Print」に、端末内のアドレス(localhost:8088)経由で送る。
//     Smooth Print にはテンプレート(SMOOTHPRINT_TEMPLATE)を、あらかじめ共有しておく必要がある。

// ラベルのテンプレート(P-touch Editorで作った .lbx ファイル)の置き場所。
// 印刷するPC(FZ-M1)の中のこの場所にファイルを置く。
export const LABEL_TEMPLATE_PATH = "C:\\logisys\\label.lbx";

// プリンター名の初期値。Windowsの「デバイスとプリンター」に表示されている名前と同じにする。
// 画面から変更でき、変更した名前はその端末のブラウザに保存される。
// ---- Android(Smooth Print)用の設定 ----
// Smooth Print に共有したテンプレートのファイル名。テンプレートの中の4項目(産地・規格・納品日・仕入先)は、
// 表の外に置いたもの(label_sp.lbx)でないと、差し替えが効かない。
export const SMOOTHPRINT_TEMPLATE = "label_sp.lbx";
// 用紙の指定(DK-2205:幅62mmの連続ロール紙)
export const SMOOTHPRINT_SIZE = "RollW62";
const SMOOTHPRINT_URL = "http://localhost:8088/print";

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

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
  if (isAndroid()) {
    await printLabelAndroid(data);
    return;
  }
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

// Android:Smooth Print に印刷を依頼する。
// 返事は XML(<response><result>メッセージ</result><code>コード</code></response>)。
// Smooth Print は、1枚の印刷が終わる前に次の依頼が来るとエラー(UnknownError)を返すことがある。
// そのため、依頼を1枚ずつ順番に送り、前の印刷から少し間をあけ、失敗したときは待ってやり直す。
const ANDROID_GAP_MS = 1000; // 前の印刷の完了から、次の依頼までの最低の間隔
const ANDROID_RETRY_WAIT_MS = 2000; // 失敗したときの待ち時間
const ANDROID_MAX_TRIES = 4;
let androidQueue: Promise<void> = Promise.resolve();
let androidLastDone = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function printLabelAndroid(data: LabelPrintData): Promise<void> {
  const job = androidQueue.then(async () => {
    const wait = androidLastDone + ANDROID_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    let lastErr: unknown = null;
    for (let i = 1; i <= ANDROID_MAX_TRIES; i++) {
      try {
        await printLabelAndroidOnce(data);
        androidLastDone = Date.now();
        return;
      } catch (e) {
        lastErr = e;
        // アプリと通信できない場合は、待っても直らないので、すぐ失敗にする
        if (e instanceof Error && e.message.startsWith("Smooth Print と通信")) break;
        if (i < ANDROID_MAX_TRIES) await sleep(ANDROID_RETRY_WAIT_MS);
      }
    }
    androidLastDone = Date.now();
    throw lastErr;
  });
  // 失敗しても、次の依頼が止まらないようにする
  androidQueue = job.catch(() => undefined);
  return job;
}

async function printLabelAndroidOnce(data: LabelPrintData): Promise<void> {
  const parts = [
    `filename=${encodeURIComponent(SMOOTHPRINT_TEMPLATE)}`,
    `size=${encodeURIComponent(SMOOTHPRINT_SIZE)}`,
    "copies=1",
    `text_item=${encodeURIComponent(data.item)}`,
    `text_store=${encodeURIComponent(data.store)}`,
    `text_qty=${encodeURIComponent(data.qty)}`,
    `text_origin=${encodeURIComponent(data.origin)}`,
    `text_spec=${encodeURIComponent(data.spec)}`,
    `text_date=${encodeURIComponent(data.date)}`,
    `text_supplier=${encodeURIComponent(data.supplier)}`,
    `barcode_qr=${encodeURIComponent(data.qr)}`,
  ];
  const url = `${SMOOTHPRINT_URL}?${parts.join("&")}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let text: string;
  try {
    const res = await fetch(url, { method: "POST", signal: ctrl.signal });
    text = await res.text();
    if (!res.ok) throw new Error(`Smooth Print がエラーを返しました(HTTP ${res.status})`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Smooth Print")) throw e;
    throw new Error(
      "Smooth Print と通信できませんでした。アプリを入れているか、プリンターとつながっているかを確認してください"
    );
  } finally {
    clearTimeout(timer);
  }

  const code = /<code>([^<]*)<\/code>/.exec(text)?.[1] ?? "";
  const result = /<result>([^<]*)<\/result>/.exec(text)?.[1] ?? "";
  const ok = /SUCCESS/i.test(code) || (!code && /SUCCESS/i.test(result));
  if (!ok) {
    throw new Error(`Smooth Print:${result || "印刷できませんでした"}${code ? `(${code})` : ""}`);
  }
}
