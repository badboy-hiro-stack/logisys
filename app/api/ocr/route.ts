import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

const STORE_REFERENCE = [
  { code: "20", name: "小原店" },
  { code: "30", name: "武山店" },
  { code: "35", name: "佐原店" },
  { code: "40", name: "平作店" },
  { code: "45", name: "衣笠店" },
  { code: "60", name: "平成町店" },
  { code: "50", name: "新鶴見店" },
  { code: "51", name: "南部市場店" },
  { code: "77", name: "りんかんモール店" },
  { code: "78", name: "南町田店" },
  { code: "90", name: "ARAI店" },
];

const SUPPLIER_REFERENCE = [
  { code: "185091", name: "横須賀青果物" },
  { code: "133401", name: "駿河屋" },
  { code: "125021", name: "港南商事" },
  { code: "145145", name: "TOKYOフレッシュ大田" },
  { code: "122185", name: "かねはら" },
  { code: "113001", name: "昭島松源" },
];

// 伝票上の店舗の並び順(左から右)。店舗コードの数字順ではなく、60が50・51より左にある点に注意。
const STORE_ORDER = ["20", "30", "35", "40", "45", "60", "50", "51", "77", "78", "90"];

const SYSTEM_PROMPT = `あなたは市場の仕分け伝票(EDPシステム発注分)を読み取り、構造化データに変換するアシスタントです。

伝票は「EOSコード・産地・品名・規格」の列と、店舗ごとの「入数×箱数」の列、「全店計」列を持つ表です。
以下の店舗マスタ・仕入先マスタを参照し、伝票上の表記ゆれ(店名の省略形など)があっても正しいコードに対応付けてください。

店舗マスタ: ${JSON.stringify(STORE_REFERENCE)}
仕入先マスタ: ${JSON.stringify(SUPPLIER_REFERENCE)}
店舗コードの左から右への並び順(伝票のヘッダー行と同じ順序): ${JSON.stringify(STORE_ORDER)}

出力は次のJSON形式のみとしてください。説明文やMarkdownのコードブロック記号は一切含めないでください。

{
  "supplier_code": "伝票左上の仕入先名に対応するコード(マスタに無ければ null)",
  "target_date": "伝票右上の発行日、または伝票本文の年月日分からYYYY-MM-DD形式で推定。不明ならnull",
  "page_no": 伝票右上に大きく書かれているページ番号(数値。無ければ1),
  "lines": [
    {
      "eos_code": "EOSコード(文字列)",
      "item_name": "品名",
      "origin": "産地欄の内容。空欄なら空文字列",
      "spec": "規格欄の内容。空欄なら空文字列",
      "store_qty": [
        { "store_code": "20", "pack_size": 0, "case_count": 0 },
        { "store_code": "30", "pack_size": 0, "case_count": 0 },
        { "store_code": "35", "pack_size": 0, "case_count": 0 },
        { "store_code": "40", "pack_size": 0, "case_count": 0 },
        { "store_code": "45", "pack_size": 0, "case_count": 0 },
        { "store_code": "60", "pack_size": 0, "case_count": 0 },
        { "store_code": "50", "pack_size": 0, "case_count": 0 },
        { "store_code": "51", "pack_size": 0, "case_count": 0 },
        { "store_code": "77", "pack_size": 0, "case_count": 0 },
        { "store_code": "78", "pack_size": 0, "case_count": 0 },
        { "store_code": "90", "pack_size": 0, "case_count": 0 }
      ],
      "total_display": "伝票の全店計欄の表記そのまま(例:'20×11' または 入数混載時の実個数のみの数値'346')",
      "total_qty": 全店計を実個数に換算した数値(入数×箱数の合計。入数混載の場合もこの値で自動検算に使う)
    }
  ]
}

注意点(非常に重要。特に1と2は過去に実際の誤りとして発生したので厳守してください):

1. **store_qty には、必ず上記11店舗すべてを、指定した順番のまま含めてください。** 値が空欄の店舗は pack_size=0, case_count=0 としてください。途中の店舗が空欄だからといって、その店舗を省略したり、後ろの店舗の値を前に詰めて読んだりしないでください。空欄を飛ばして次の値を読んでしまい、全体が1列ズレることが最も多い誤りです。
2. 店舗ごとの値を読み取る際は、伝票上部の店舗コード見出し行(20, 30, 35, 40, 45, 60, 50, 51, 77, 78, 90の順。**数字の小さい順ではなく、60が45の次、50・51がその右です**)と、今読み取ろうとしている数値が**縦の位置として正しく揃っているか**を、1列ずつ目で追って確認してください。
3. 品名が小さい文字や手書きで判読しにくい場合、推測で別の単語に置き換えないでください。確信が持てない場合は、読み取れた範囲をそのまま書くか、低い確信度であることが分かるようにしてください。
4. 同じ行内で店舗ごとに入数(pack_size)が異なる場合(入数混載)があります。各店舗ごとに実際の入数をそのまま記録してください。
5. total_qty は必ず store_qty の (pack_size × case_count) の合計と一致するように計算してください(人間が後で自動検算に使います)。
6. 途中で出力を切らず、伝票に写っている行をすべて出力し終えてから終了してください。
7. **数値は先頭に0を付けないでください(例:08は不可、8と書く)。JSON以外の文字(コメントや説明)は一切含めないでください。文字列内で改行やタブ文字を使わないでください。**
8. **応答は必ず最初の文字が "{" から始まり、最後の文字が "}" で終わるようにしてください。「承知しました」「読み取ります」のような前置きや、説明・感想などの後書きは一切書かないでください。**`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEYが設定されていません(.env.localを確認してください)" },
      { status: 500 }
    );
  }

  const body = await req.json();
  const { imageBase64, mediaType } = body as {
    imageBase64: string;
    mediaType: string;
  };

  if (!imageBase64) {
    return NextResponse.json({ error: "画像データがありません" }, { status: 400 });
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (mediaType || "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: "この伝票を読み取って、指定したJSON形式で出力してください。11店舗すべてを順番どおり含めること、空欄は0にすること、最後の行まで出力し切ることを忘れないでください。",
            },
          ],
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawText = textBlock && "text" in textBlock ? textBlock.text : "";

    // AIが指示に反してコードブロックや前置き・後書きの文章を付けてくることがあるため、
    // コードブロック記号を除去したうえで、最初の "{" から最後の "}" までだけを取り出す。
    let cleaned = rawText.replace(/```json|```/g, "").trim();
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // JSON.parseのエラーメッセージから、問題が起きた位置(文字数)を取り出し、
      // その前後を切り出して返す。これでどこが壊れているかが分かる。
      const msg = (parseErr as Error).message;
      const posMatch = msg.match(/position (\d+)/);
      const pos = posMatch ? Number(posMatch[1]) : null;
      const around =
        pos !== null
          ? cleaned.slice(Math.max(0, pos - 300), pos + 300)
          : null;

      return NextResponse.json(
        {
          error: "AIの応答をJSONとして解釈できませんでした",
          parse_error_message: msg,
          stop_reason: message.stop_reason,
          raw_length: rawText.length,
          error_position: pos,
          around_error_position: around,
          raw_tail: rawText.slice(-500),
        },
        { status: 502 }
      );
    }

    if (parsed?.lines) {
      for (const line of parsed.lines) {
        if (Array.isArray(line.store_qty)) {
          line.store_qty = line.store_qty.filter(
            (s: { pack_size: number; case_count: number }) =>
              !(s.pack_size === 0 && s.case_count === 0)
          );
        }
      }
    }

    return NextResponse.json({ result: parsed });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Claude APIの呼び出しに失敗しました: " + (err as Error).message },
      { status: 502 }
    );
  }
}
