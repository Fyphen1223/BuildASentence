import fs from "node:fs";
import readline from "node:readline";
import nlp from "compromise";

const INPUT_FILE = "raw.jsonl";
const OUTPUT_FILE = "parsed.jsonl";

// ------------------------------------------------------------------
// 1. シャッフル処理 (元と一致しないように制御)
// ------------------------------------------------------------------
function shuffleChunks(chunks) {
  if (chunks.length <= 1) return { options: chunks, correctOrder: [0] };

  let indices = chunks.map((_, i) => i);
  let attempts = 0;

  while (attempts < 10) {
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const isOriginal = indices.every((val, idx) => val === idx);
    if (!isOriginal) break;
    attempts++;
  }

  const options = indices.map((i) => chunks[i]);
  const correctOrder = chunks.map((chunk) => options.indexOf(chunk));

  return { options, correctOrder };
}

// ------------------------------------------------------------------
// 2. 賢いトークン化 & チャンキング
// ------------------------------------------------------------------
function chunkSentence(sentence) {
  // 文末のピリオド・疑問符を除去
  let clean = sentence.trim().replace(/[.?!]$/, "");

  const doc = nlp(clean);

  // ① 複数解防止: "smooth and strong" のような等位接続詞で結ばれた形容詞/名詞だけ結合
  doc.match("#Adjective and #Adjective").tag("FixedUnit");

  const terms = doc.terms().json();
  const rawTokens = [];

  // ② ハイフン結合バグの修復 (long- + term -> long-term)
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    const text = t.text;

    // 直前がハイフンで終わっている場合、またはこの単語がハイフン始まりの場合合体
    if (
      rawTokens.length > 0 &&
      rawTokens[rawTokens.length - 1].text.endsWith("-")
    ) {
      const prev = rawTokens.pop();
      rawTokens.push({
        text: prev.text + text,
        tags: new Set([...prev.tags, ...(t.tags || [])]),
      });
    } else if (text === "-" && rawTokens.length > 0 && i + 1 < terms.length) {
      // ハイフン単体でトークン化されている場合
      const prev = rawTokens.pop();
      const next = terms[++i];
      rawTokens.push({
        text: `${prev.text}-${next.text}`,
        tags: new Set([...prev.tags, ...(next.tags || [])]),
      });
    } else {
      rawTokens.push({
        text: text,
        tags: new Set(t.tags || []),
      });
    }
  }

  // ③ 文頭の大文字・小文字処理
  // 1番目のトークンが "I" や固有名詞(ProperNoun) でない場合は小文字化
  if (rawTokens.length > 0) {
    const first = rawTokens[0];
    const isProper = first.tags.has("ProperNoun");
    const isI =
      first.text === "I" || first.text === "I'm" || first.text === "I've";
    if (!isProper && !isI) {
      first.text = first.text.charAt(0).toLowerCase() + first.text.slice(1);
    }
  }

  // ④ チャンキング（1語で独立させるもの vs 2語まで束ねるもの）
  const chunks = [];
  let currentBuffer = [];

  // 単独1語で独立させる条件判定
  const shouldBeSingle = (token) => {
    const textClean = token.text.replace(/[,;]/g, "").trim().toLowerCase();
    const isPronoun = token.tags.has("Pronoun"); // I, you, he, she, it, they...
    const isIntro = [
      "yes",
      "no",
      "sure",
      "well",
      "oh",
      "yeah",
      "please",
      "however",
    ].includes(textClean);
    const hasComma = token.text.includes(","); // カンマ付きの語はそこで切る
    return isPronoun || isIntro || hasComma;
  };

  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i];

    // 「FixedUnit(smooth and strong)」に該当する場合
    if (token.tags.has("FixedUnit")) {
      if (currentBuffer.length > 0) {
        chunks.push(currentBuffer.join(" "));
        currentBuffer = [];
      }
      // FixedUnit は1つにまとめる
      currentBuffer.push(token.text);
      continue;
    }

    // 「I」「It」「Yes,」などは強制的に単独1チャンク
    if (shouldBeSingle(token)) {
      if (currentBuffer.length > 0) {
        chunks.push(currentBuffer.join(" "));
        currentBuffer = [];
      }
      chunks.push(token.text);
      continue;
    }

    currentBuffer.push(token.text);

    // 最大2語で細かく刻む（巨大なチャンク化を防ぐ）
    if (currentBuffer.length >= 2) {
      chunks.push(currentBuffer.join(" "));
      currentBuffer = [];
    }
  }

  // 残った端数処理（無理に直前とくっつけず、1語でも独立したチャンクにする）
  if (currentBuffer.length > 0) {
    chunks.push(currentBuffer.join(" "));
  }

  return chunks;
}

// ------------------------------------------------------------------
// 3. 再開用 ID ローダー
// ------------------------------------------------------------------
async function loadProcessedIds(filePath) {
  const processedIds = new Set();
  if (!fs.existsSync(filePath)) return processedIds;

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.id) processedIds.add(data.id);
    } catch {
      // パースエラーは無視
    }
  }
  return processedIds;
}

// ------------------------------------------------------------------
// 4. メインパイプライン
// ------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Error: "${INPUT_FILE}" が見つかりません。`);
    process.exit(1);
  }

  const processedIds = await loadProcessedIds(OUTPUT_FILE);
  console.log(`既存の処理済み件数: ${processedIds.size} 件`);

  const readStream = fs.createReadStream(INPUT_FILE);
  const rl = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity,
  });

  const writeStream = fs.createWriteStream(OUTPUT_FILE, { flags: "a" });

  let totalProcessed = 0;
  let skipped = 0;
  let errors = 0;

  console.log("変換処理を開始します...");

  for await (const line of rl) {
    if (!line.trim()) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      errors++;
      continue;
    }

    if (processedIds.has(row.id)) {
      skipped++;
      continue;
    }

    try {
      const chunks = chunkSentence(row.answer);
      const { options, correctOrder } = shuffleChunks(chunks);

      const parsedItem = {
        id: row.id,
        metadata: {
          cefr: row.cefr,
          skill: row.skill,
          topic: row.topic,
          model: row.model,
        },
        prompt: row.question,
        targetSentence: row.answer,
        chunksOriginal: chunks,
        options: options,
        correctOrder: correctOrder,
        parsedAt: new Date().toISOString(),
      };

      writeStream.write(JSON.stringify(parsedItem) + "\n");
      processedIds.add(row.id);
      totalProcessed++;

      if (totalProcessed % 200 === 0) {
        console.log(
          `進捗: ${totalProcessed} 件新規処理完了 (スキップ: ${skipped} 件)`,
        );
      }
    } catch (err) {
      console.error(`Error processing ID: ${row.id}`, err);
      errors++;
    }
  }

  writeStream.end();
  console.log(`\n=== 完了 ===`);
  console.log(`新規処理: ${totalProcessed} 件`);
  console.log(`スキップ: ${skipped} 件`);
  console.log(`エラー: ${errors} 件`);
}

main().catch(console.error);
