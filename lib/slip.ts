import JSZip from "jszip";
// 仕分け伝票(Excel)の生成。public/slip_template.xlsx に値を流し込む。

/** 伝票の店舗列の並び(テンプレートの E〜O 列に対応) */
export const SLIP_STORES = ["20", "30", "35", "40", "45", "60", "50", "51", "77", "78", "90"];
const STORE_COLS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; // E..O
const ROWS_PER_SHEET = 24;
const FIRST_ROW = 5;

export type SlipItem = {
  eos: string;
  origin: string;
  name: string;
  spec: string;
  /** 店コード → (入数 → 箱数) */
  stores: Record<string, Record<number, number>>;
};

export type SlipData = {
  vendorCode: string;
  vendorName: string;
  targetDate: string; // YYYY-MM-DD
  items: SlipItem[];
};

function storeText(pm: Record<number, number> | undefined): string {
  if (!pm) return "";
  const parts = Object.keys(pm)
    .map(Number)
    .sort((a, b) => b - a)
    .filter((p) => pm[p] > 0)
    .map((p) => `${p}×${pm[p]}`);
  return parts.join("+");
}

function totalText(item: SlipItem): string | number {
  const tot: Record<number, number> = {};
  for (const sc of Object.keys(item.stores)) {
    for (const p of Object.keys(item.stores[sc])) {
      tot[Number(p)] = (tot[Number(p)] ?? 0) + item.stores[sc][Number(p)];
    }
  }
  const packs = Object.keys(tot).map(Number);
  if (packs.length === 0) return "";
  if (packs.length === 1) return `${packs[0]}×${tot[packs[0]]}`;
  return packs.reduce((s, p) => s + p * tot[p], 0);
}

function asNumOrText(v: string): string | number {
  return /^\d+$/.test(v) ? Number(v) : v;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** シートXML内のセルの値を差し替える(スタイルは元のまま) */
function setCell(xml: string, ref: string, value: string | number | null): string {
  const re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)');
  const m = re.exec(xml);
  if (!m) throw new Error("テンプレートにセル " + ref + " がありません");
  const sm = /s="(\d+)"/.exec(m[1]);
  const s = sm ? ' s="' + sm[1] + '"' : "";
  let cell: string;
  if (value === null || value === "") cell = '<c r="' + ref + '"' + s + "/>";
  else if (typeof value === "number") cell = '<c r="' + ref + '"' + s + ' t="n"><v>' + value + "</v></c>";
  else cell = '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t>' + esc(value) + "</t></is></c>";
  return xml.slice(0, m.index) + cell + xml.slice(m.index + m[0].length);
}

function excelSerial(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

/** テンプレートに値を流し込み、xlsxのバイナリを返す(ExcelJSを使わずXMLを直接編集) */
export async function fillSlip(templateBuf: ArrayBuffer, data: SlipData): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(templateBuf);
  const baseXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");

  const items = [...data.items].sort((a, b) => a.eos.localeCompare(b.eos));
  const pageCount = Math.max(1, Math.ceil(items.length / ROWS_PER_SHEET));

  const [y, m, d] = data.targetDate.split("-").map(Number);
  const now = new Date();
  const issued = excelSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());

  const cols = ["", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];

  for (let p = 0; p < pageCount; p++) {
    let xml = p === 0 ? baseXml : baseXml.replace(' tabSelected="1"', "");
    xml = setCell(xml, "A2", asNumOrText(data.vendorCode));
    xml = setCell(xml, "A3", data.vendorName);
    xml = setCell(xml, "C2", y);
    xml = setCell(xml, "D2", m);
    xml = setCell(xml, "E2", d);
    xml = setCell(xml, "M1", issued);
    xml = setCell(xml, "P1", p + 1);
    const chunk = items.slice(p * ROWS_PER_SHEET, (p + 1) * ROWS_PER_SHEET);
    chunk.forEach((it, i) => {
      const r = FIRST_ROW + i;
      xml = setCell(xml, "A" + r, asNumOrText(it.eos));
      xml = setCell(xml, "B" + r, it.origin);
      xml = setCell(xml, "C" + r, it.name);
      xml = setCell(xml, "D" + r, it.spec);
      SLIP_STORES.forEach((sc, si) => {
        const t = storeText(it.stores[sc]);
        if (t) xml = setCell(xml, cols[STORE_COLS[si]] + r, t);
      });
      const tt = totalText(it);
      if (tt !== "") xml = setCell(xml, "P" + r, tt);
    });
    zip.file("xl/worksheets/sheet" + (p + 1) + ".xml", xml);
  }

  if (pageCount > 1) {
    let wbx = await zip.file("xl/workbook.xml")!.async("string");
    let rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
    let ct = await zip.file("[Content_Types].xml")!.async("string");
    let sheetsAdd = "";
    let relsAdd = "";
    let ctAdd = "";
    for (let p = 2; p <= pageCount; p++) {
      sheetsAdd +=
        '<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="' +
        p + '" sheetId="' + p + '" state="visible" r:id="rIdSheet' + p + '"/>';
      relsAdd +=
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet' +
        p + '.xml" Id="rIdSheet' + p + '"/>';
      ctAdd +=
        '<Override PartName="/xl/worksheets/sheet' + p +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    wbx = wbx.replace("</sheets>", sheetsAdd + "</sheets>");
    rels = rels.replace("</Relationships>", relsAdd + "</Relationships>");
    ct = ct.replace("</Types>", ctAdd + "</Types>");
    zip.file("xl/workbook.xml", wbx);
    zip.file("xl/_rels/workbook.xml.rels", rels);
    zip.file("[Content_Types].xml", ct);
  }

  return await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

export async function buildSlipBuffer(data: SlipData): Promise<ArrayBuffer> {
  const res = await fetch("/slip_template.xlsx", { cache: "no-store" });
  if (!res.ok) throw new Error("伝票テンプレート(public/slip_template.xlsx)が見つかりません");
  return fillSlip(await res.arrayBuffer(), data);
}

export function slipFileName(d: SlipData): string {
  const nm = d.vendorName.replace(/[\\/:*?"<>|）（ 　]/g, "");
  return `仕分け伝票_${d.vendorCode}_${nm}_${d.targetDate.replace(/-/g, "")}.xlsx`;
}

export function downloadBuffer(buf: ArrayBuffer, filename: string) {
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
