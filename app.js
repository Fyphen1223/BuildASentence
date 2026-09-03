let allQuestions = []; // parsed.jsonl の全データ
let questions = []; // フィルター合致出題リスト
let currentIndex = 0;
let score = { correct: 0, total: 0 };
let slots = [];
let timerSeconds = 0;
let timerInterval = null;

const STORAGE_KEY = "toefl_bas_storage_v1";

// 要素取得
const loadingEl = document.getElementById("loading");
const quizScreenEl = document.getElementById("quiz-screen");
const emptyScreenEl = document.getElementById("empty-screen");
const endScreenEl = document.getElementById("end-screen");
const promptBox = document.getElementById("prompt-box");
const slotsContainer = document.getElementById("slots-container");
const wordbankContainer = document.getElementById("wordbank-container");
const feedbackPanel = document.getElementById("feedback-panel");
const feedbackHeader = document.getElementById("feedback-header");
const feedbackBody = document.getElementById("feedback-body");
const qCounter = document.getElementById("q-counter");
const badgeCefr = document.getElementById("badge-cefr");
const badgeSkill = document.getElementById("badge-skill");
const badgeChunks = document.getElementById("badge-chunks");
const timerDisplay = document.getElementById("timer-display");

// フィルター要素
const filterMode = document.getElementById("filter-mode");
const filterSkill = document.getElementById("filter-skill");
const filterCefr = document.getElementById("filter-cefr");
const filterChunksMin = document.getElementById("filter-chunks-min");
const filterChunksMax = document.getElementById("filter-chunks-max");

const btnCheck = document.getElementById("btn-check");
const btnNext = document.getElementById("btn-next");
const btnReset = document.getElementById("btn-reset");
const btnSkip = document.getElementById("btn-skip");
const btnRestart = document.getElementById("btn-restart");

// モーダル
const modalHistory = document.getElementById("modal-history");
const modalBackup = document.getElementById("modal-backup");
const btnOpenHistory = document.getElementById("btn-open-history");
const btnCloseHistory = document.getElementById("btn-close-history");
const btnOpenBackup = document.getElementById("btn-open-backup");
const btnCloseBackup = document.getElementById("btn-close-backup");
const historyList = document.getElementById("history-list");
const skillStatsList = document.getElementById("skill-stats-list");

const btnExportJson = document.getElementById("btn-export-json");
const btnImportTrigger = document.getElementById("btn-import-trigger");
const fileImportJson = document.getElementById("file-import-json");
const btnClearHistory = document.getElementById("btn-clear-history");

// ==========================================
// localStorage 管理
// ==========================================
function getStoredData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { history: [], stats: {} };
    return JSON.parse(raw);
  } catch (e) {
    return { history: [], stats: {} };
  }
}

function saveStoredData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function recordAttempt(q, isCorrect, userOrder, userSentence, timeSpent) {
  const store = getStoredData();
  const record = {
    id: q.id || `q_${Date.now()}`,
    metadata: q.metadata || {},
    skill: q.metadata?.skill || "general",
    prompt: q.prompt || "",
    targetSentence: q.targetSentence,
    userOrder: userOrder,
    correctOrder: q.correctOrder,
    userSentence: userSentence,
    isCorrect: isCorrect,
    timeSpentSeconds: timeSpent,
    timestamp: new Date().toISOString(),
  };

  store.history.unshift(record);

  if (!store.stats[record.id]) {
    store.stats[record.id] = {
      attempts: 0,
      correct: 0,
      incorrect: 0,
      lastIsCorrect: false,
    };
  }
  const s = store.stats[record.id];
  s.attempts++;
  if (isCorrect) s.correct++;
  else s.incorrect++;
  s.lastIsCorrect = isCorrect;
  s.lastTimestamp = record.timestamp;

  saveStoredData(store);
}

// ==========================================
// 初期化 & フィルター構築
// ==========================================
async function init() {
  try {
    const res = await fetch("./generator/parsed.jsonl");
    if (!res.ok)
      throw new Error(
        `HTTP ${res.status}: Cannot read ./generator/parsed.jsonl`,
      );

    const text = await res.text();
    allQuestions = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    if (allQuestions.length === 0) throw new Error("File is empty.");

    buildFilterOptions();
    loadingEl.classList.add("hidden");
    setupWordBankDropZone();

    applyFilter();
  } catch (err) {
    loadingEl.innerHTML = `
      <div style="color: #dc2626; padding: 1.5rem; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;">
        <strong>Error loading data:</strong><br>${err.message}
      </div>
    `;
  }
}

/**
 * Skill, CEFR, Chunks Range の選択肢を動的生成
 */
function buildFilterOptions() {
  const skillSet = new Set();
  const cefrSet = new Set();
  const chunksSet = new Set();

  allQuestions.forEach((q) => {
    if (q.metadata?.skill) skillSet.add(q.metadata.skill);
    if (q.metadata?.cefr) cefrSet.add(q.metadata.cefr);
    const count = q.correctOrder?.length || q.options?.length || 0;
    if (count > 0) chunksSet.add(count);
  });

  // 1. Skill ドロップダウン
  Array.from(skillSet)
    .sort()
    .forEach((sk) => {
      const opt = document.createElement("option");
      opt.value = sk;
      opt.textContent = sk;
      filterSkill.appendChild(opt);
    });

  // 2. CEFR ドロップダウン
  const cefrOrder = ["A1", "A2", "B1", "B2", "C1", "C2"];
  const sortedCefr = Array.from(cefrSet).sort((a, b) => {
    const ia = cefrOrder.indexOf(a.toUpperCase());
    const ib = cefrOrder.indexOf(b.toUpperCase());
    return ia !== -1 && ib !== -1 ? ia - ib : a.localeCompare(b);
  });
  sortedCefr.forEach((lvl) => {
    const opt = document.createElement("option");
    opt.value = lvl;
    opt.textContent = `CEFR: ${lvl}`;
    filterCefr.appendChild(opt);
  });

  // 3. Chunks Range (Min 〜 Max)
  const sortedChunks = Array.from(chunksSet).sort((a, b) => a - b);
  const minVal = sortedChunks[0] || 1;
  const maxVal = sortedChunks[sortedChunks.length - 1] || 10;

  sortedChunks.forEach((cnt) => {
    const optMin = document.createElement("option");
    optMin.value = cnt;
    optMin.textContent = cnt;
    if (cnt === minVal) optMin.selected = true;
    filterChunksMin.appendChild(optMin);

    const optMax = document.createElement("option");
    optMax.value = cnt;
    optMax.textContent = cnt;
    if (cnt === maxVal) optMax.selected = true;
    filterChunksMax.appendChild(optMax);
  });

  filterMode.addEventListener("change", applyFilter);
  filterSkill.addEventListener("change", applyFilter);
  filterCefr.addEventListener("change", applyFilter);
  filterChunksMin.addEventListener("change", onChunksRangeChange);
  filterChunksMax.addEventListener("change", onChunksRangeChange);
}

function onChunksRangeChange() {
  let min = parseInt(filterChunksMin.value, 10);
  let max = parseInt(filterChunksMax.value, 10);
  if (min > max) {
    filterChunksMax.value = min;
  }
  applyFilter();
}

// ==========================================
// フィルター & モード適用
// ==========================================
function applyFilter() {
  const selectedMode = filterMode.value;
  const selectedSkill = filterSkill.value;
  const selectedCefr = filterCefr.value;
  const minChunks = parseInt(filterChunksMin.value, 10) || 0;
  const maxChunks = parseInt(filterChunksMax.value, 10) || 999;
  const store = getStoredData();

  let filtered = allQuestions.filter((q) => {
    const skill = q.metadata?.skill || "";
    const cefr = q.metadata?.cefr || "";
    const chunks = q.correctOrder?.length || q.options?.length || 0;

    const matchSkill = selectedSkill === "all" || skill === selectedSkill;
    const matchCefr =
      selectedCefr === "all" ||
      cefr.toLowerCase() === selectedCefr.toLowerCase();
    const matchChunks = chunks >= minChunks && chunks <= maxChunks;

    return matchSkill && matchCefr && matchChunks;
  });

  if (selectedMode === "review") {
    filtered = filtered.filter((q) => {
      const s = store.stats[q.id];
      return s && s.incorrect > 0;
    });
    filtered.sort(() => Math.random() - 0.5);
  } else if (selectedMode === "unsolved") {
    const unsolved = [];
    const solved = [];
    filtered.forEach((q) => {
      if (store.stats[q.id] && store.stats[q.id].attempts > 0) {
        solved.push(q);
      } else {
        unsolved.push(q);
      }
    });
    unsolved.sort(() => Math.random() - 0.5);
    solved.sort(() => Math.random() - 0.5);
    filtered = [...unsolved, ...solved];
  } else {
    filtered.sort(() => Math.random() - 0.5);
  }

  questions = filtered;
  currentIndex = 0;
  score = { correct: 0, total: 0 };

  if (questions.length === 0) {
    quizScreenEl.classList.add("hidden");
    endScreenEl.classList.add("hidden");
    emptyScreenEl.classList.remove("hidden");

    if (selectedMode === "review") {
      document.getElementById("empty-title").textContent =
        "No Mistakes to Review!";
      document.getElementById("empty-desc").textContent =
        "この条件で間違えた問題のストックはありません。素晴らしい！";
    } else {
      document.getElementById("empty-title").textContent = "No Questions Found";
      document.getElementById("empty-desc").textContent =
        "条件に一致する問題がありません。フィルター設定を変更してください。";
    }
    stopTimer();
    timerDisplay.textContent = "00:00";
  } else {
    emptyScreenEl.classList.add("hidden");
    quizScreenEl.classList.remove("hidden");
    renderQuestion();
  }
}

// ==========================================
// 問題レンダリング
// ==========================================
function renderQuestion() {
  if (currentIndex >= questions.length) {
    showEndScreen();
    return;
  }

  const q = questions[currentIndex];
  const totalSlotsNeeded = q.correctOrder?.length || q.options.length;

  slots = new Array(totalSlotsNeeded).fill(null);
  startTimer();

  qCounter.textContent = `Question ${currentIndex + 1} of ${questions.length}`;
  badgeCefr.textContent = `CEFR: ${q.metadata?.cefr || "N/A"}`;
  badgeSkill.textContent = `Skill: ${q.metadata?.skill || "General"}`;
  badgeChunks.textContent = `${totalSlotsNeeded} Chunks`;
  promptBox.textContent = q.prompt || "(No prompt context)";

  feedbackPanel.classList.add("hidden");
  feedbackPanel.className = "feedback-panel hidden";

  btnCheck.classList.remove("hidden");
  btnCheck.disabled = true;
  btnNext.classList.add("hidden");
  btnSkip.classList.remove("hidden");
  btnReset.disabled = false;

  updateViews();
}

function formatWordText(text, isFirst) {
  let cleaned = text.trim().replace(/\.$/, "");
  if (isFirst && cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

function updateViews() {
  const q = questions[currentIndex];
  slotsContainer.innerHTML = "";

  slots.forEach((optIdx, slotIdx) => {
    if (optIdx !== null) {
      const isFirst = slotIdx === 0;
      const displayText = formatWordText(q.options[optIdx], isFirst);
      const chip = createPlacedChip(displayText, optIdx, slotIdx);
      slotsContainer.appendChild(chip);
    } else {
      const emptySlot = createSlotDropTarget(slotIdx);
      slotsContainer.appendChild(emptySlot);
    }
  });

  wordbankContainer.innerHTML = "";
  q.options.forEach((opt, idx) => {
    if (!slots.includes(idx)) {
      const displayText = formatWordText(opt, false);
      const bankChip = createBankChip(displayText, idx);
      wordbankContainer.appendChild(bankChip);
    }
  });

  const isAllFilled = slots.every((val) => val !== null);
  btnCheck.disabled = !isAllFilled;
}

function createSlotDropTarget(slotIdx) {
  const slot = document.createElement("div");
  slot.className = "slot-placeholder";
  slot.textContent = `[ ${slotIdx + 1} ]`;

  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    slot.classList.add("drag-target");
  });

  slot.addEventListener("dragleave", () => {
    slot.classList.remove("drag-target");
  });

  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    slot.classList.remove("drag-target");

    const dataStr = e.dataTransfer.getData("text/plain");
    if (!dataStr) return;
    const data = JSON.parse(dataStr);

    if (data.source === "bank") {
      slots[slotIdx] = data.optIdx;
    } else if (data.source === "slot") {
      slots[slotIdx] = slots[data.fromSlot];
      slots[data.fromSlot] = null;
    }

    updateViews();
  });

  return slot;
}

function createPlacedChip(text, optIdx, slotIdx) {
  const btn = document.createElement("button");
  btn.className = "word-chip placed";
  btn.textContent = text;
  btn.draggable = true;

  btn.onclick = () => {
    slots[slotIdx] = null;
    updateViews();
  };

  btn.addEventListener("dragstart", (e) => {
    btn.classList.add("dragging");
    e.dataTransfer.setData(
      "text/plain",
      JSON.stringify({
        source: "slot",
        fromSlot: slotIdx,
        optIdx: optIdx,
      }),
    );
  });

  btn.addEventListener("dragend", () => {
    btn.classList.remove("dragging");
  });

  btn.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.add("drag-target");
  });

  btn.addEventListener("dragleave", (e) => {
    e.stopPropagation();
    btn.classList.remove("drag-target");
  });

  btn.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.remove("drag-target");

    const dataStr = e.dataTransfer.getData("text/plain");
    if (!dataStr) return;
    const data = JSON.parse(dataStr);

    if (data.source === "slot") {
      const temp = slots[slotIdx];
      slots[slotIdx] = slots[data.fromSlot];
      slots[data.fromSlot] = temp;
    } else if (data.source === "bank") {
      slots[slotIdx] = data.optIdx;
    }

    updateViews();
  });

  return btn;
}

function createBankChip(text, optIdx) {
  const btn = document.createElement("button");
  btn.className = "word-chip";
  btn.textContent = text;
  btn.draggable = true;

  btn.onclick = () => {
    const emptyIndex = slots.indexOf(null);
    if (emptyIndex !== -1) {
      slots[emptyIndex] = optIdx;
      updateViews();
    }
  };

  btn.addEventListener("dragstart", (e) => {
    btn.classList.add("dragging");
    e.dataTransfer.setData(
      "text/plain",
      JSON.stringify({
        source: "bank",
        optIdx: optIdx,
      }),
    );
  });

  btn.addEventListener("dragend", () => {
    btn.classList.remove("dragging");
  });

  return btn;
}

function setupWordBankDropZone() {
  wordbankContainer.addEventListener("dragover", (e) => {
    e.preventDefault();
    wordbankContainer.classList.add("drag-over");
  });

  wordbankContainer.addEventListener("dragleave", () => {
    wordbankContainer.classList.remove("drag-over");
  });

  wordbankContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    wordbankContainer.classList.remove("drag-over");

    const dataStr = e.dataTransfer.getData("text/plain");
    if (!dataStr) return;
    const data = JSON.parse(dataStr);

    if (data.source === "slot") {
      slots[data.fromSlot] = null;
      updateViews();
    }
  });
}

// ==========================================
// 判定 & ログ保存
// ==========================================
function submitAnswer() {
  stopTimer();
  const q = questions[currentIndex];
  const isCorrect = JSON.stringify(slots) === JSON.stringify(q.correctOrder);

  const userWords = slots.map((optIdx, i) =>
    formatWordText(q.options[optIdx], i === 0),
  );
  const userSentence = userWords.join(" ") + ".";

  recordAttempt(q, isCorrect, [...slots], userSentence, timerSeconds);

  score.total++;
  if (isCorrect) score.correct++;

  feedbackPanel.classList.remove("hidden");

  if (isCorrect) {
    feedbackPanel.className = "feedback-panel correct";
    feedbackHeader.innerHTML =
      '<i class="fa-solid fa-circle-check"></i> Correct!';
    feedbackBody.innerHTML = `<strong>Target Sentence:</strong> ${q.targetSentence}`;
  } else {
    feedbackPanel.className = "feedback-panel incorrect";
    feedbackHeader.innerHTML =
      '<i class="fa-solid fa-circle-xmark"></i> Incorrect';
    feedbackBody.innerHTML = `
      <div><strong>Your Sentence:</strong> <span style="color:#dc2626">${userSentence}</span></div>
      <div style="margin-top: 0.25rem;"><strong>Target Sentence:</strong> <span style="color:#059669">${q.targetSentence}</span></div>
    `;
  }

  btnCheck.classList.add("hidden");
  btnNext.classList.remove("hidden");
  btnSkip.classList.add("hidden");
  btnReset.disabled = true;
}

// ==========================================
// ★Skill別弱点分析 ＆ 履歴モーダルの描画
// ==========================================
function renderHistoryModal() {
  const store = getStoredData();
  const hist = store.history || [];

  const total = hist.length;
  const corrects = hist.filter((h) => h.isCorrect).length;
  const acc = total > 0 ? Math.round((corrects / total) * 100) : 0;

  const mistakeIds = new Set();
  Object.keys(store.stats || {}).forEach((id) => {
    if (store.stats[id].incorrect > 0) mistakeIds.add(id);
  });

  document.getElementById("stat-total-attempts").textContent = total;
  document.getElementById("stat-accuracy").textContent =
    `${acc}% (${corrects}/${total})`;
  document.getElementById("stat-mistakes").textContent = mistakeIds.size;

  // 1. Skill別集計
  const skillMap = {};
  hist.forEach((h) => {
    const sk = h.skill || h.metadata?.skill || "general";
    if (!skillMap[sk]) {
      skillMap[sk] = { total: 0, correct: 0, incorrect: 0 };
    }
    skillMap[sk].total++;
    if (h.isCorrect) skillMap[sk].correct++;
    else skillMap[sk].incorrect++;
  });

  // 正答率の低い順（弱点順）にソート
  const skillArray = Object.keys(skillMap)
    .map((sk) => {
      const item = skillMap[sk];
      const skillAcc = Math.round((item.correct / item.total) * 100);
      return { name: sk, ...item, accuracy: skillAcc };
    })
    .sort((a, b) => {
      // 正答率が低い順、同じならミスが多い順
      if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
      return b.incorrect - a.incorrect;
    });

  skillStatsList.innerHTML = "";
  if (skillArray.length === 0) {
    skillStatsList.innerHTML =
      '<p class="text-xs text-muted" style="grid-column: 1/-1;">まだSkill統計データがありません。</p>';
  } else {
    skillArray.forEach((sk) => {
      const card = document.createElement("div");
      const isWeak = sk.accuracy < 70;
      card.className = `skill-card ${isWeak ? "weak" : ""}`;

      let accClass = "high";
      let barColor = "#059669";
      if (sk.accuracy < 60) {
        accClass = "low";
        barColor = "#dc2626";
      } else if (sk.accuracy < 80) {
        accClass = "medium";
        barColor = "#d97706";
      }

      card.innerHTML = `
        <div class="skill-card-top">
          <span class="skill-name" title="${sk.name}">${sk.name}</span>
          <span class="skill-accuracy ${accClass}">${sk.accuracy}%</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${sk.accuracy}%; background: ${barColor};"></div>
        </div>
        <div class="skill-card-bottom">
          <span>${sk.correct}/${sk.total} (${sk.incorrect} misses)</span>
          <button class="btn-practice-skill" data-skill="${sk.name}">
            <i class="fa-solid fa-play"></i> Drill
          </button>
        </div>
      `;
      skillStatsList.appendChild(card);
    });

    // 「Drill」ボタンで該当Skillに絞り込み開始
    skillStatsList.querySelectorAll(".btn-practice-skill").forEach((btn) => {
      btn.onclick = () => {
        const targetSkill = btn.getAttribute("data-skill");
        modalHistory.classList.add("hidden");
        filterSkill.value = targetSkill;
        applyFilter();
      };
    });
  }

  // 2. 解答履歴リスト
  historyList.innerHTML = "";
  if (hist.length === 0) {
    historyList.innerHTML =
      '<p class="text-muted text-center" style="padding:1.5rem;">解答履歴がありません。</p>';
    return;
  }

  hist.slice(0, 50).forEach((h) => {
    const item = document.createElement("div");
    item.className = `history-item ${h.isCorrect ? "correct" : "incorrect"}`;

    const dateStr = new Date(h.timestamp).toLocaleString();
    item.innerHTML = `
      <div class="history-meta">
        <span>${h.isCorrect ? '<strong style="color:#059669">✓ CORRECT</strong>' : '<strong style="color:#dc2626">✗ INCORRECT</strong>'} (${h.timeSpentSeconds}s)</span>
        <span>${dateStr} | Skill: <strong>${h.skill}</strong> | CEFR: ${h.metadata?.cefr || "N/A"}</span>
      </div>
      <div class="history-prompt">Prompt: ${h.prompt || "-"}</div>
      ${
        !h.isCorrect
          ? `
        <div class="diff-line">
          <span class="diff-label">Your Answer:</span>
          <span class="diff-user wrong">${h.userSentence}</span>
        </div>
      `
          : ""
      }
      <div class="diff-line">
        <span class="diff-label">Target:</span>
        <span class="diff-target">${h.targetSentence}</span>
      </div>
    `;
    historyList.appendChild(item);
  });
}

// ==========================================
// チェックポイント
// ==========================================
function exportCheckpoint() {
  const store = getStoredData();
  const dataStr =
    "data:text/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(store, null, 2));
  const now = new Date().toISOString().slice(0, 10);
  const dlAnchor = document.createElement("a");
  dlAnchor.setAttribute("href", dataStr);
  dlAnchor.setAttribute("download", `toefl_sentence_checkpoint_${now}.json`);
  document.body.appendChild(dlAnchor);
  dlAnchor.click();
  dlAnchor.remove();
}

function importCheckpoint(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.history || !imported.stats) {
        throw new Error("無効なバックアップファイル形式です");
      }
      saveStoredData(imported);
      alert("チェックポイントを正常に復元しました！");
      modalBackup.classList.add("hidden");
      applyFilter();
    } catch (err) {
      alert("ファイルのインポートに失敗しました: " + err.message);
    }
  };
  reader.readAsText(file);
}

function startTimer() {
  stopTimer();
  timerSeconds = 0;
  renderTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds++;
    renderTimerDisplay();
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
}

function renderTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  timerDisplay.textContent = `${m}:${s}`;
}

function showEndScreen() {
  stopTimer();
  quizScreenEl.classList.add("hidden");
  endScreenEl.classList.remove("hidden");

  const pct =
    score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
  document.getElementById("final-stats").innerHTML = `
    Session completed!<br>
    Session Score: <strong>${score.correct} / ${score.total}</strong> (${pct}%)
  `;
}

// イベント
btnCheck.addEventListener("click", submitAnswer);
btnNext.addEventListener("click", () => {
  currentIndex++;
  renderQuestion();
});
btnSkip.addEventListener("click", () => {
  currentIndex++;
  renderQuestion();
});
btnReset.addEventListener("click", () => {
  slots.fill(null);
  updateViews();
});
btnRestart.addEventListener("click", () => {
  applyFilter();
});

btnOpenHistory.addEventListener("click", () => {
  renderHistoryModal();
  modalHistory.classList.remove("hidden");
});
btnCloseHistory.addEventListener("click", () => {
  modalHistory.classList.add("hidden");
});

btnOpenBackup.addEventListener("click", () => {
  modalBackup.classList.remove("hidden");
});
btnCloseBackup.addEventListener("click", () => {
  modalBackup.classList.add("hidden");
});

btnExportJson.addEventListener("click", exportCheckpoint);
btnImportTrigger.addEventListener("click", () => {
  fileImportJson.click();
});
fileImportJson.addEventListener("change", (e) => {
  if (e.target.files.length > 0) importCheckpoint(e.target.files[0]);
});
btnClearHistory.addEventListener("click", () => {
  if (confirm("本当にすべての解答履歴と統計をリセットしますか？")) {
    localStorage.removeItem(STORAGE_KEY);
    alert("履歴を消去しました");
    modalBackup.classList.add("hidden");
    applyFilter();
  }
});

window.addEventListener("click", (e) => {
  if (e.target === modalHistory) modalHistory.classList.add("hidden");
  if (e.target === modalBackup) modalBackup.classList.add("hidden");
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (!btnNext.classList.contains("hidden")) {
      btnNext.click();
    } else if (!btnCheck.disabled && !btnCheck.classList.contains("hidden")) {
      btnCheck.click();
    }
  }
});

init();
