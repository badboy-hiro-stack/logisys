/* eslint-disable @typescript-eslint/no-explicit-any */
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

function cloneSheet(wb: any, src: any, name: string) {
  const ws = wb.addWorksheet(name);
  ws.pageSetup = JSON.parse(JSON.stringify(src.pageSetup));
  for (let c = 1; c <= 16; c++) {
    const w = src.getColumn(c).width;
    if (w) ws.getColumn(c).width = w;
  }
  for (let r = 1; r <= 28; r++) {
    const h = src.getRow(r).height;
    if (h) ws.getRow(r).height = h;
    for (let c = 1; c <= 16; c++) {
      const s = src.getCell(r, c);
      const d = ws.getCell(r, c);
      d.value = s.value;
      d.style = JSON.parse(JSON.stringify(s.style));
    }
  }
  const merges: string[] = (src.model && src.model.merges) || [];
  merges.forEach((m) => ws.mergeCells(m));
  return ws;
}

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

/** 1ベンダー分のExcelを作り、バイナリを返す */
export async function buildSlipBuffer(data: SlipData): Promise<ArrayBuffer> {
  const ExcelJS: any = (await import("exceljs")).default;
  const res = await fetch("/slip_template.xlsx", { cache: "no-store" });
  if (!res.ok) throw new Error("伝票テンプレート(public/slip_template.xlsx)が見つかりません");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const base = wb.worksheets[0];

  const items = [...data.items].sort((a, b) => a.eos.localeCompare(b.eos));
  const pageCount = Math.max(1, Math.ceil(items.length / ROWS_PER_SHEET));
  const sheets: any[] = [base];
  for (let n = 2; n <= pageCount; n++) sheets.push(cloneSheet(wb, base, String(n)));

  const [y, m, d] = data.targetDate.split("-").map(Number);
  const now = new Date();
  const issued = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

  sheets.forEach((ws, idx) => {
    ws.name = String(idx + 1);
    ws.getCell("A2").value = asNumOrText(data.vendorCode);
    ws.getCell("A3").value = data.vendorName;
    ws.getCell("C2").value = y;
    ws.getCell("C2").numFmt = '0"年"';
    ws.getCell("D2").value = m;
    ws.getCell("D2").numFmt = '0"月"';
    ws.getCell("E2").value = d;
    ws.getCell("M1").value = issued;
    ws.getCell("M1").numFmt = "m/d";
    const pg = ws.getCell("P1");
    pg.value = idx + 1;
    pg.font = { size: 36, bold: true };
    pg.alignment = { horizontal: "center", vertical: "middle" };

    const chunk = items.slice(idx * ROWS_PER_SHEET, (idx + 1) * ROWS_PER_SHEET);
    chunk.forEach((it, i) => {
      const r = FIRST_ROW + i;
      ws.getCell(r, 1).value = asNumOrText(it.eos);
      ws.getCell(r, 2).value = it.origin;
      ws.getCell(r, 3).value = it.name;
      ws.getCell(r, 4).value = it.spec;
      SLIP_STORES.forEach((sc, si) => {
        const t = storeText(it.stores[sc]);
        if (t) ws.getCell(r, STORE_COLS[si]).value = t;
      });
      const tt = totalText(it);
      if (tt !== "") ws.getCell(r, 16).value = tt;
    });
  });

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
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
