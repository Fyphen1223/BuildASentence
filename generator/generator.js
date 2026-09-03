"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Groq = require("groq-sdk");

// ============================================================
// Configuration
// ============================================================

const ROOT = __dirname;

const TARGET_COUNT = Number(process.env.TARGET_COUNT || 5000);

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

// Wait between requests for EACH worker/model.
const MODEL_DELAY_MS = Number(process.env.MODEL_DELAY_MS || 2000);

// Wait after HTTP 429.
const RATE_LIMIT_RETRY_MS = Number(process.env.RATE_LIMIT_RETRY_MS || 5000);

// ============================================================
// File paths
// ============================================================

const ENV_FILE = path.join(ROOT, "env.json");
const TOPICS_FILE = path.join(ROOT, "topics.json");
const TYPES_FILE = path.join(ROOT, "types.json");
const PROMPT_FILE = path.join(ROOT, "generator.txt");

const OUTPUT_FILE = path.join(ROOT, "raw.jsonl");
const ERROR_FILE = path.join(ROOT, "errors.log");

// ============================================================
// Models
// ============================================================

const GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
  "groq/compound",
  "groq/compound-mini",
];

const MISTRAL_MODELS = [
  "ministral-3b-latest",
  "ministral-8b-latest",
  "ministral-14b-latest",
];

// ============================================================
// Load files
// ============================================================

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load ${file}: ${error.message}`);
  }
}

const env = loadJSON(ENV_FILE);
const topics = loadJSON(TOPICS_FILE);
const types = loadJSON(TYPES_FILE);

const prompt = fs.readFileSync(PROMPT_FILE, "utf8").trim();

// ============================================================
// Validate configuration
// ============================================================

if (!env.groq) {
  throw new Error('env.json is missing "groq".');
}

if (!env.mistral) {
  throw new Error('env.json is missing "mistral".');
}

if (!Array.isArray(topics) || topics.length === 0) {
  throw new Error("topics.json must contain a non-empty array.");
}

const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

for (const level of CEFR_LEVELS) {
  if (!Array.isArray(types[level]) || types[level].length === 0) {
    throw new Error(`types.json["${level}"] must contain a non-empty array.`);
  }
}

// ============================================================
// Groq clients
// ============================================================

const groqClients = new Map();

for (const model of GROQ_MODELS) {
  groqClients.set(
    model,
    new Groq({
      apiKey: env.groq,
    }),
  );
}

// ============================================================
// General helpers
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function timestamp() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomUUID();
}

function writeError(message) {
  fs.appendFileSync(ERROR_FILE, `[${timestamp()}] ${message}\n`, "utf8");
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

// ============================================================
// Generation spec
// ============================================================

function generateSpec() {
  const cefr = randomItem(CEFR_LEVELS);

  const skill = randomItem(types[cefr]);

  const topic = randomItem(topics);

  return {
    cefr,
    skill,
    topic,
  };
}

// ============================================================
// User prompt
// ============================================================

function buildUserPrompt(spec) {
  return `
Generate ONE item with the following specifications:

CEFR: ${spec.cefr}
Skill: ${spec.skill}
Topic: ${spec.topic}
`.trim();
}

// ============================================================
// JSON parsing
// ============================================================

function parseModelJSON(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Model returned empty content.");
  }

  let cleaned = text.trim();

  // Remove Markdown code fences.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Direct JSON parse.
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue to extraction.
  }

  // Extract first object.
  const start = cleaned.indexOf("{");

  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

// ============================================================
// Validate generated item
// ============================================================

function validateItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Model output is not an object.");
  }

  if (typeof item.question !== "string") {
    throw new Error("Missing or invalid question.");
  }

  if (typeof item.answer !== "string") {
    throw new Error("Missing or invalid answer.");
  }

  const question = item.question.trim();

  const answer = item.answer.trim();

  if (!question) {
    throw new Error("Question is empty.");
  }

  if (!answer) {
    throw new Error("Answer is empty.");
  }

  if (question.length > 1000) {
    throw new Error("Question is too long.");
  }

  if (answer.length > 1000) {
    throw new Error("Answer is too long.");
  }

  return {
    question,
    answer,
  };
}

// ============================================================
// Groq request
// ============================================================

async function generateGroq(model, spec) {
  const client = groqClients.get(model);

  if (!client) {
    throw new Error(`No Groq client for ${model}`);
  }

  const response = await client.chat.completions.create({
    model,

    messages: [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: buildUserPrompt(spec),
      },
    ],

    temperature: 0.9,

    max_completion_tokens: 300,
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq returned empty content.");
  }

  return validateItem(parseModelJSON(content));
}

// ============================================================
// Mistral request
// ============================================================

async function generateMistral(mistralClient, model, spec) {
  const response = await mistralClient.chat.complete({
    model,

    messages: [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: buildUserPrompt(spec),
      },
    ],

    temperature: 0.9,

    maxTokens: 300,
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Mistral returned empty content.");
  }

  // Some SDK/model configurations may return
  // content as an array of content parts.
  let text;

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("");
  } else {
    throw new Error("Unexpected Mistral content format.");
  }

  return validateItem(parseModelJSON(text));
}

// ============================================================
// Unified request
// ============================================================

async function generateOne(provider, model, spec, mistralClient) {
  if (provider === "groq") {
    return generateGroq(model, spec);
  }

  if (provider === "mistral") {
    return generateMistral(mistralClient, model, spec);
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ============================================================
// Retry
// ============================================================

async function generateWithRetry(provider, model, spec, jobId, mistralClient) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();

    log(
      `JOB=${jobId} ` +
        `[${provider}/${model}] ` +
        `ATTEMPT ${attempt}/${MAX_RETRIES} ` +
        `CEFR=${spec.cefr} ` +
        `SKILL=${spec.skill} ` +
        `TOPIC=${spec.topic}`,
    );

    try {
      const result = await generateOne(provider, model, spec, mistralClient);

      const latency = Date.now() - started;

      log(
        `JOB=${jobId} ` +
          `[${provider}/${model}] ` +
          `SUCCESS ` +
          `latency=${latency}ms`,
      );

      return result;
    } catch (error) {
      lastError = error;

      const latency = Date.now() - started;

      const status =
        error?.status ??
        error?.response?.status ??
        error?.statusCode ??
        "unknown";

      const message = error instanceof Error ? error.message : String(error);

      log(
        `JOB=${jobId} ` +
          `[${provider}/${model}] ` +
          `ERROR ` +
          `status=${status} ` +
          `latency=${latency}ms ` +
          `message=${message}`,
      );

      writeError(
        [
          `JOB=${jobId}`,
          `PROVIDER=${provider}`,
          `MODEL=${model}`,
          `ATTEMPT=${attempt}`,
          `STATUS=${status}`,
          `CEFR=${spec.cefr}`,
          `SKILL=${spec.skill}`,
          `TOPIC=${spec.topic}`,
          `LATENCY=${latency}ms`,
          `ERROR=${message}`,
        ].join(" "),
      );

      if (attempt >= MAX_RETRIES) {
        break;
      }

      let delay;

      if (Number(status) === 429) {
        delay = RATE_LIMIT_RETRY_MS;
      } else {
        delay = 500 * Math.pow(2, attempt - 1);
      }

      log(
        `JOB=${jobId} ` + `[${provider}/${model}] ` + `RETRY WAIT ${delay}ms`,
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

// ============================================================
// Resume support
// ============================================================

function getExistingRecords() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    return [];
  }

  const content = fs.readFileSync(OUTPUT_FILE, "utf8");

  const records = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    try {
      const record = JSON.parse(trimmed);

      if (
        record &&
        typeof record.question === "string" &&
        typeof record.answer === "string"
      ) {
        records.push(record);
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return records;
}

// ============================================================
// Statistics
// ============================================================

function printSummary(initialCount, completed, failed, startTime) {
  const elapsed = (Date.now() - startTime) / 1000;

  const generated = completed - initialCount;

  const rate = generated / Math.max(elapsed, 0.001);

  const remaining = Math.max(TARGET_COUNT - completed, 0);

  log("============================================================");

  log(
    `PROGRESS ${completed}/${TARGET_COUNT} ` +
      `| remaining=${remaining} ` +
      `| generated_this_run=${generated} ` +
      `| failed=${failed} ` +
      `| rate=${rate.toFixed(2)}/s`,
  );

  log(`ELAPSED ${elapsed.toFixed(1)}s`);

  log("============================================================");
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Dynamic import allows this file to remain CommonJS (.js).
  const { Mistral } = await import("@mistralai/mistralai");

  const mistralClient = new Mistral({
    apiKey: env.mistral,
  });

  // ----------------------------------------------------------
  // Resume
  // ----------------------------------------------------------

  const existing = getExistingRecords();

  const initialCount = existing.length;

  if (initialCount >= TARGET_COUNT) {
    log(`Already complete: ` + `${initialCount}/${TARGET_COUNT}`);

    return;
  }

  const remaining = TARGET_COUNT - initialCount;

  log("============================================================");

  log("TOEFL Build a Sentence Raw Generator");

  log("============================================================");

  log(`Target       : ${TARGET_COUNT}`);

  log(`Existing     : ${initialCount}`);

  log(`Remaining    : ${remaining}`);

  log(`Groq models  : ${GROQ_MODELS.length}`);

  log(`Mistral models: ${MISTRAL_MODELS.length}`);

  log(`Workers      : ${GROQ_MODELS.length + MISTRAL_MODELS.length}`);

  log(`Delay/model  : ${MODEL_DELAY_MS}ms`);

  log(`429 wait     : ${RATE_LIMIT_RETRY_MS}ms`);

  log("============================================================");

  // ----------------------------------------------------------
  // Job state
  // ----------------------------------------------------------

  let nextJob = 0;

  let completed = initialCount;

  let failed = 0;

  const startTime = Date.now();

  // ----------------------------------------------------------
  // Global write helper
  // ----------------------------------------------------------

  function saveRecord(record) {
    // Synchronous append ensures that a successfully
    // generated item is physically written before the
    // process proceeds.
    fs.appendFileSync(OUTPUT_FILE, JSON.stringify(record) + "\n", "utf8");
  }

  // ----------------------------------------------------------
  // Worker
  // ----------------------------------------------------------

  async function worker(provider, model) {
    log(`WORKER START [${provider}/${model}]`);

    while (true) {
      // Reserve one unique job.
      const jobIndex = nextJob++;

      if (jobIndex >= remaining) {
        log(`WORKER DONE [${provider}/${model}]`);

        return;
      }

      // Job numbering starts after already existing records.
      const jobId = initialCount + jobIndex + 1;

      const spec = generateSpec();

      log(`JOB=${jobId} ` + `[${provider}/${model}] ` + `START`);

      try {
        const result = await generateWithRetry(
          provider,
          model,
          spec,
          jobId,
          mistralClient,
        );

        const record = {
          id: makeId(),
          generatedAt: timestamp(),
          model,
          provider,
          cefr: spec.cefr,
          skill: spec.skill,
          topic: spec.topic,
          question: result.question,
          answer: result.answer,
        };

        saveRecord(record);

        completed++;

        log(
          `JOB=${jobId} ` +
            `[${provider}/${model}] ` +
            `SAVED ` +
            `progress=${completed}/${TARGET_COUNT}`,
        );
      } catch (error) {
        failed++;

        const message = error instanceof Error ? error.message : String(error);

        log(
          `JOB=${jobId} ` +
            `[${provider}/${model}] ` +
            `FINAL FAILURE ` +
            `${message}`,
        );

        writeError(
          [
            "FINAL_FAILURE",
            `JOB=${jobId}`,
            `PROVIDER=${provider}`,
            `MODEL=${model}`,
            `CEFR=${spec.cefr}`,
            `SKILL=${spec.skill}`,
            `TOPIC=${spec.topic}`,
            `ERROR=${message}`,
          ].join(" "),
        );
      }

      // ------------------------------------------------------
      // Important:
      // Only THIS worker waits.
      // All other workers continue.
      // ------------------------------------------------------

      log(`[${provider}/${model}] ` + `WAIT ${MODEL_DELAY_MS}ms`);

      await sleep(MODEL_DELAY_MS);

      // Print summary every 10 generated/failed items.
      const totalProcessed = completed - initialCount + failed;

      if (totalProcessed % 10 === 0) {
        printSummary(initialCount, completed, failed, startTime);
      }
    }
  }

  // ----------------------------------------------------------
  // Start all workers
  // ----------------------------------------------------------

  const workers = [];

  for (const model of GROQ_MODELS) {
    workers.push(worker("groq", model));
  }

  for (const model of MISTRAL_MODELS) {
    workers.push(worker("mistral", model));
  }

  await Promise.all(workers);

  // ----------------------------------------------------------
  // Final summary
  // ----------------------------------------------------------

  printSummary(initialCount, completed, failed, startTime);

  log("GENERATION FINISHED");

  log(`Final count: ${completed}/${TARGET_COUNT}`);
}

// ============================================================
// Graceful shutdown
// ============================================================

process.on("SIGINT", () => {
  console.log("");
  log("SIGINT received. Stopping.");
  log("raw.jsonl has been preserved. Re-run to resume.");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("");
  log("SIGTERM received. Stopping.");
  log("raw.jsonl has been preserved. Re-run to resume.");
  process.exit(0);
});

// ============================================================
// Run
// ============================================================

main().catch((error) => {
  console.error("");
  console.error(`[${timestamp()}] FATAL ERROR`);
  console.error(error);

  process.exit(1);
});
