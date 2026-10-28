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
export const SMOOTHPRINT_TEMPLATE = "label_sp_1209.lbx";
// 用紙の指定(DK-1209:62mm×29mmのダイカットラベル)
export const SMOOTHPRINT_SIZE = "DieCutW62H29";
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

// 「小原店（B）」から記号「B」だけを取り出す。記号がなければ、そのまま返す
export function storeSignText(store: string): string {
  const m = /[（(]([^）)]+)[）)]\s*$/.exec(store);
  return m ? m[1] : store;
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
    await androidJob(() => printBatchAndroidOnce([data]));
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
      sign: storeSignText(data.store),
      qty: data.qty,
      origin: data.origin,
      spec: data.spec,
      qr: data.qr,
      label_id: data.qr,
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

function androidJob(send: () => Promise<void>): Promise<void> {
  const job = androidQueue.then(async () => {
    const wait = androidLastDone + ANDROID_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    let lastErr: unknown = null;
    for (let i = 1; i <= ANDROID_MAX_TRIES; i++) {
      try {
        await send();
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

// Smooth Print に送る1回分(複数枚)。複数レイアウト印刷の書き方:filename1, filename2, …
//   text_filename1.オブジェクト名 / barcode_filename1.オブジェクト名
// 1回の依頼にまとめた複数枚は、Smooth Print の「最後をカット」で、最後の1枚の後だけカットされる。
async function printBatchAndroidOnce(list: LabelPrintData[]): Promise<void> {
  const e = encodeURIComponent;
  const parts: string[] = [`size=${e(SMOOTHPRINT_SIZE)}`];
  if (list.length === 1) {
    // 1枚のときは、従来の単一レイアウトの書き方(動作確認済み)
    const d = list[0];
    parts.push(
      `filename=${e(SMOOTHPRINT_TEMPLATE)}`,
      "copies=1",
      `text_item=${e(d.item)}`,
      `text_sign=${e(storeSignText(d.store))}`,
      `text_qty=${e(d.qty)}`,
      `text_origin=${e(d.origin)}`,
      `text_spec=${e(d.spec)}`,
      `barcode_qr=${e(d.qr)}`,
      `text_label_id=${e(d.qr)}`
    );
  } else {
    list.forEach((d, i) => {
      const n = i + 1;
      parts.push(
        `filename${n}=${e(SMOOTHPRINT_TEMPLATE)}`,
        `text_filename${n}.item=${e(d.item)}`,
        `text_filename${n}.sign=${e(storeSignText(d.store))}`,
        `text_filename${n}.qty=${e(d.qty)}`,
        `text_filename${n}.origin=${e(d.origin)}`,
        `text_filename${n}.spec=${e(d.spec)}`,
        `barcode_filename${n}.qr=${e(d.qr)}`,
        `text_filename${n}.label_id=${e(d.qr)}`
      );
    });
  }
  const url = `${SMOOTHPRINT_URL}?${parts.join("&")}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let text: string;
  try {
    const res = await fetch(url, { method: "POST", signal: ctrl.signal });
    text = await res.text();
    if (!res.ok) throw new Error(`Smooth Print がエラーを返しました(HTTP ${res.status})`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Smooth Print")) throw err;
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

// 途中で失敗したときに、何枚目まで印刷できたかを伝える例外
export class PrintBatchError extends Error {
  printed: number;
  constructor(message: string, printed: number) {
    super(message);
    this.printed = printed;
  }
}

// 複数枚をまとめて印刷する。
//   ・Android:25枚ずつ1回の依頼にまとめる(各回の最後にカット)。失敗した回から後は未印刷。
//   ・Windows:従来どおり1枚ずつ。
// 失敗したときは PrintBatchError を投げる(printed = 印刷できた枚数)。
const ANDROID_BATCH_SIZE = 25;
export async function printLabels(list: LabelPrintData[]): Promise<void> {
  if (list.length === 0) return;
  let printed = 0;
  try {
    if (isAndroid()) {
      for (let i = 0; i < list.length; i += ANDROID_BATCH_SIZE) {
        const chunk = list.slice(i, i + ANDROID_BATCH_SIZE);
        await androidJob(() => printBatchAndroidOnce(chunk));
        printed += chunk.length;
      }
    } else {
      for (const d of list) {
        await printLabel(d);
        printed++;
      }
    }
  } catch (e) {
    throw new PrintBatchError(errorText(e), printed);
  }
}
