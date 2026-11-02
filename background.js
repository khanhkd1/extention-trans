// ============================================================================
// YouTube AI Subtitle Translator - Background Service Worker (background.js)
// Quản lý Xoay vòng Gemini API Keys (Round-Robin + Failover) & Dịch Batch
// ============================================================================

const DEFAULT_API_KEYS = [];

// Khởi tạo rỗng để bảo mật tuyệt đối khi đẩy lên GitHub
const LEGACY_SAMPLE_KEYS = new Set();

const DEFAULT_SETTINGS = {
  apiKeys: DEFAULT_API_KEYS,
  model: "gemini-3.5-flash-lite",
  displayMode: "bilingual", // "bilingual" | "vi-only" | "off"
  fontSize: 20,             // px cho dòng Tiếng Việt
  autoTranslate: true,
  batchSize: 25,            // Số câu mỗi batch thông thường
  concurrency: 2            // Số batch dịch song song trên các key khác nhau
};

const COOLDOWN_MS_429 = 45 * 1000; // 45 giây khi gặp Rate Limit 429
const COOLDOWN_MS_ERR = 15 * 1000; // 15 giây khi gặp lỗi mạng/5xx
const MAX_CACHED_VIDEOS = 100;     // Lưu tối đa 100 video gần nhất (LRU Cache)
const CACHE_STORAGE_KEY = "translationCacheV3";

function normalizeTextKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Trạng thái runtime của bộ xoay vòng Key
class GeminiKeyRotator {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.stats = new Map();
  }

  updateKeys(newKeys) {
    const cleaned = (newKeys || [])
      .map(k => (typeof k === "string" ? k.trim() : ""))
      .filter(Boolean);
    this.keys = cleaned;
    this.currentIndex = 0;
    const oldStats = this.stats;
    this.stats = new Map();
    this.keys.forEach((key, idx) => {
      const prev = oldStats.get(key);
      this.stats.set(key, prev ? { ...prev, index: idx + 1 } : {
        index: idx + 1,
        maskedKey: this.maskKey(key),
        requests: 0,
        successes: 0,
        rateLimits: 0,
        errors: 0,
        cooldownUntil: 0,
        lastUsedAt: null,
        lastStatus: "ready"
      });
    });
  }

  maskKey(key) {
    if (!key || key.length < 12) return "***";
    return `${key.slice(0, 8)}...${key.slice(-5)}`;
  }

  /**
   * Chọn key tiếp theo theo thuật toán Round-Robin có kiểm tra Cooldown
   */
  acquireNextKey(excludeKeys = new Set()) {
    const now = Date.now();
    const total = this.keys.length;
    if (total === 0) {
      throw new Error("Chưa cấu hình Gemini API Key. Hãy mở Popup tiện ích để nhập Key.");
    }

    // Vòng 1: Tìm key đang khỏe mạnh (không nằm trong cooldown & chưa bị exclude)
    for (let offset = 0; offset < total; offset++) {
      const idx = (this.currentIndex + offset) % total;
      const key = this.keys[idx];
      if (excludeKeys.has(key)) continue;

      const st = this.stats.get(key);
      if (st && st.cooldownUntil <= now) {
        if (st.lastStatus === "cooldown") st.lastStatus = "ready";
        this.currentIndex = (idx + 1) % total;
        return { key, keyIndex: idx + 1 };
      }
    }

    // Vòng 2: Nếu tất cả key đều đang cooldown, chọn key sắp hết hạn cooldown sớm nhất
    let bestIdx = this.currentIndex % total;
    let earliestCooldown = Infinity;
    for (let i = 0; i < total; i++) {
      const key = this.keys[i];
      if (excludeKeys.has(key) && excludeKeys.size < total) continue;
      const st = this.stats.get(key);
      if (st && st.cooldownUntil < earliestCooldown) {
        earliestCooldown = st.cooldownUntil;
        bestIdx = i;
      }
    }

    const fallbackKey = this.keys[bestIdx];
    this.currentIndex = (bestIdx + 1) % total;
    return { key: fallbackKey, keyIndex: bestIdx + 1 };
  }

  markRequestStart(key) {
    const st = this.stats.get(key);
    if (st) {
      st.requests += 1;
      st.lastUsedAt = Date.now();
      st.lastStatus = "active";
    }
  }

  markSuccess(key) {
    const st = this.stats.get(key);
    if (st) {
      st.successes += 1;
      st.cooldownUntil = 0;
      st.lastStatus = "ready";
    }
  }

  markError(key, httpCode, message) {
    const st = this.stats.get(key);
    if (!st) return;

    if (httpCode === 429) {
      st.rateLimits += 1;
      st.cooldownUntil = Date.now() + COOLDOWN_MS_429;
      st.lastStatus = "cooldown";
      st.lastError = `HTTP 429 (Tạm nghỉ 45s)`;
    } else if (httpCode >= 500) {
      st.errors += 1;
      st.cooldownUntil = Date.now() + COOLDOWN_MS_ERR;
      st.lastStatus = "cooldown";
      st.lastError = `HTTP ${httpCode} (Server bận)`;
    } else {
      st.errors += 1;
      st.cooldownUntil = Date.now() + COOLDOWN_MS_ERR;
      st.lastStatus = "error";
      st.lastError = message || `HTTP ${httpCode}`;
    }
  }

  getPublicStats() {
    const now = Date.now();
    return this.keys.map((key, idx) => {
      const st = this.stats.get(key) || {};
      const remainingCooldownSec = Math.max(0, Math.ceil(((st.cooldownUntil || 0) - now) / 1000));
      return {
        index: idx + 1,
        maskedKey: this.maskKey(key),
        requests: st.requests || 0,
        successes: st.successes || 0,
        rateLimits: st.rateLimits || 0,
        errors: st.errors || 0,
        remainingCooldownSec,
        status: remainingCooldownSec > 0 ? "cooldown" : (st.lastStatus || "ready"),
        lastError: st.lastError || null
      };
    });
  }
}

const rotator = new GeminiKeyRotator();

// Khởi tạo cấu hình khi cài đặt hoặc khởi động Service Worker
async function ensureSettingsLoaded() {
  const stored = await chrome.storage.local.get(["settings", "legacyDefaultKeysCleared"]);
  if (!stored.settings) {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      legacyDefaultKeysCleared: true
    });
    rotator.updateKeys([]);
    return DEFAULT_SETTINGS;
  }

  const merged = { ...DEFAULT_SETTINGS, ...stored.settings };
  if (!Array.isArray(merged.apiKeys)) {
    merged.apiKeys = [];
  }

  // Xoá 3 key mặc định cũ một lần duy nhất nếu đang lưu từ phiên bản trước
  if (!stored.legacyDefaultKeysCleared) {
    merged.apiKeys = merged.apiKeys.filter(k => !LEGACY_SAMPLE_KEYS.has((k || "").trim()));
    await chrome.storage.local.set({
      settings: merged,
      legacyDefaultKeysCleared: true
    });
  }

  rotator.updateKeys(merged.apiKeys);
  return merged;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureSettingsLoaded();
});

// ============================================================================
// Phân tích Chủ đề Video (Topic & Domain Classifier) để tối ưu Prompt dịch
// ============================================================================
const DOMAIN_PROFILES = [
  {
    id: "ai-prompt-llm",
    shortLabel: "AI & Prompt Engineering",
    keywords: [
      /\bprompt(s|ing)?\b/i, /\bprompt engineering\b/i, /\banthropic\b/i, /\bclaude\b/i,
      /\bllm(s)?\b/i, /\bgpt\b/i, /\bgemini\b/i, /\bopenai\b/i, /\bai fluency\b/i,
      /\bgenerative ai\b/i, /\bmachine learning\b/i, /\bdeep learning\b/i, /\bneural network\b/i,
      /\bfew-shot\b/i, /\bzero-shot\b/i, /\bhallucinat/i, /\btransformer(s)?\b/i, /\bai agent(s)?\b/i,
      /\bfine-tun/i, /\brag\b/i, /\bembedding(s)?\b/i, /\btoken(s)?\b/i, /\bchatbot(s)?\b/i
    ],
    domain: "Trí tuệ nhân tạo (AI), Mô hình ngôn ngữ lớn (LLM) & Kỹ thuật tạo câu lệnh (Prompt Engineering)",
    style: "Học thuật - Công nghệ hiện đại, chuẩn xác, rõ ràng, dễ hiểu cho người học và làm việc với AI.",
    glossary: "Giữ nguyên hoặc dịch chuẩn ngữ cảnh AI: Prompt / Prompting (câu lệnh / kỹ thuật viết prompt), Prompt Engineering (kỹ thuật thiết kế câu lệnh), Context (ngữ cảnh), Few-shot / Examples (ví dụ mẫu), Output Constraints (ràng buộc đầu ra), Persona / Role (vai trò), Iterative prompting (tinh chỉnh câu lệnh lặp lại), Claude, LLM, Token, Agent, Hallucination (ảo giác AI)."
  },
  {
    id: "software-programming",
    shortLabel: "Lập trình & Công nghệ phần mềm",
    keywords: [
      /\bjavascript\b/i, /\btypescript\b/i, /\bpython\b/i, /\breact\b/i, /\bnextjs\b/i,
      /\bnodejs\b/i, /\bdocker\b/i, /\bkubernetes\b/i, /\bbackend\b/i, /\bfrontend\b/i,
      /\bfullstack\b/i, /\bdatabase\b/i, /\bsql\b/i, /\bapi\b/i, /\bdevops\b/i,
      /\balgorithm(s)?\b/i, /\bcoding\b/i, /\bprogramming\b/i, /\bsoftware engineer/i, /\bgit\b/i
    ],
    domain: "Lập trình phần mềm (Software Engineering), Kiến trúc hệ thống & Công nghệ thông tin",
    style: "Kỹ thuật phần mềm chuyên nghiệp, ngắn gọn, giữ nguyên các thuật ngữ code thông dụng.",
    glossary: "Giữ nguyên các thuật ngữ lập trình: API, SDK, Framework, Library, Backend, Frontend, Database, Query, Deploy, Container, Component, State, Props, Hook, Async/Await, Bug, Debug, Refactor."
  },
  {
    id: "finance-crypto-business",
    shortLabel: "Tài chính, Đầu tư & Kinh doanh",
    keywords: [
      /\bstock(s)?\b/i, /\btrading\b/i, /\binvest(ing|ment)?\b/i, /\bcrypto\b/i, /\bbitcoin\b/i,
      /\bmarket\b/i, /\beconom(y|ics)\b/i, /\binflation\b/i, /\bfinance\b/i, /\bstartup\b/i,
      /\bmarketing\b/i, /\brevenue\b/i, /\bvaluation\b/i, /\bportfolio\b/i
    ],
    domain: "Tài chính, Đầu tư, Kinh tế vĩ mô & Kinh doanh",
    style: "Chuyên ngành Kinh tế - Tài chính, chuyên nghiệp, chuẩn thuật ngữ thị trường.",
    glossary: "Dịch chuẩn thuật ngữ tài chính: Bull/Bear market (thị trường giá lên/xuống), Liquidity (thanh khoản), Yield (lợi suất), Portfolio (danh mục đầu tư), Valuation (định giá), ROI, Cash flow (dòng tiền), Fed, Lạm phát."
  },
  {
    id: "science-medicine-health",
    shortLabel: "Khoa học, Y tế & Sức khoẻ",
    keywords: [
      /\bmedicine\b/i, /\bmedical\b/i, /\bhealth\b/i, /\bbiology\b/i, /\bneuroscience\b/i,
      /\bphysics\b/i, /\bchemistry\b/i, /\bclinical\b/i, /\bsymptom(s)?\b/i, /\btherapy\b/i,
      /\bpsychology\b/i
    ],
    domain: "Khoa học tự nhiên, Y học, Sinh học & Chăm sóc sức khoẻ",
    style: "Khoa học - Y sinh chuẩn xác, khách quan, dễ tiếp thu.",
    glossary: "Dịch chuẩn xác các thuật ngữ giải phẫu, sinh học, tâm lý học và nghiên cứu lâm sàng."
  },
  {
    id: "gaming-esports",
    shortLabel: "Gaming & Esports",
    keywords: [
      /\bgaming\b/i, /\bgameplay\b/i, /\besports\b/i, /\bwalkthrough\b/i, /\bspeedrun\b/i,
      /\bmmorpg\b/i, /\bfps\b/i, /\bboss fight\b/i
    ],
    domain: "Trò chơi điện tử (Gaming), Esports & Giải trí",
    style: "Trẻ trung, tự nhiên, sinh động, giữ nguyên tên riêng nhân vật/vật phẩm/kỹ năng.",
    glossary: "Giữ nguyên các thuật ngữ game phổ biến: Buff, Nerf, Meta, Cooldown, DPS, Tank, Build, Quest, NPC."
  }
];

function detectVideoTopicProfile({ videoTitle = "", videoMetadata = {}, sampleItems = [] }) {
  const sampleText = (sampleItems || []).slice(0, 15).map(i => i.text || "").join(" ");
  const keywordsStr = Array.isArray(videoMetadata?.keywords) ? videoMetadata.keywords.join(" ") : "";
  const corpus = [
    videoTitle,
    videoMetadata?.author || "",
    videoMetadata?.category || "",
    videoMetadata?.shortDescription || "",
    keywordsStr,
    sampleText
  ].join(" ");

  let bestProfile = null;
  let bestScore = 0;

  for (const profile of DOMAIN_PROFILES) {
    let score = 0;
    for (const regex of profile.keywords) {
      if (regex.test(corpus)) {
        // Từ khoá xuất hiện ngay trên tiêu đề video được tính trọng số gấp đôi
        score += regex.test(videoTitle) ? 3 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  }

  if (bestProfile && bestScore >= 2) {
    return bestProfile;
  }

  const cat = videoMetadata?.category ? ` (${videoMetadata.category})` : "";
  return {
    id: "general-education",
    shortLabel: `Giáo dục & Chia sẻ kiến thức${cat}`,
    domain: `Giáo dục, Đào tạo & Chia sẻ kiến thức tổng hợp${cat}`,
    style: "Tự nhiên, mạch lạc, sát nghĩa gốc và phù hợp với ngữ cảnh người nói trong video.",
    glossary: "Giữ nguyên tên riêng, tên thương hiệu và các thuật ngữ chuyên môn tiếng Anh nếu dịch sang tiếng Việt bị gượng."
  };
}

// ============================================================================
// Gọi Gemini API với cơ chế Xoay vòng Key & Tự động Failover
// ============================================================================
async function translateBatchWithGemini({ items, videoTitle, videoMetadata, contextHint, preferredModel }) {
  const settings = await ensureSettingsLoaded();
  if (!rotator.keys || rotator.keys.length === 0) {
    return {
      ok: false,
      error: "Chưa có Gemini API Key. Hãy bấm vào icon tiện ích để thêm Key miễn phí.",
      keyStats: []
    };
  }

  const topicProfile = detectVideoTopicProfile({
    videoTitle,
    videoMetadata,
    sampleItems: items
  });

  const primaryModel = preferredModel || settings.model || "gemini-3.5-flash-lite";
  const candidateModels = Array.from(new Set([
    primaryModel,
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest"
  ]));

  const maxAttempts = Math.max(rotator.keys.length * 2, 4);
  const triedKeysInCycle = new Set();
  let lastErrorMsg = "Không thể kết nối tới Gemini API";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (triedKeysInCycle.size >= rotator.keys.length) {
      triedKeysInCycle.clear();
    }

    const { key, keyIndex } = rotator.acquireNextKey(triedKeysInCycle);
    triedKeysInCycle.add(key);
    rotator.markRequestStart(key);

    const modelToUse = candidateModels[Math.min(attempt, candidateModels.length - 1)];

    try {
      const translatedMap = await callGeminiGenerateContent({
        apiKey: key,
        model: modelToUse,
        items,
        videoTitle,
        videoMetadata,
        topicProfile,
        contextHint
      });

      rotator.markSuccess(key);
      return {
        ok: true,
        keyIndex,
        maskedKey: rotator.maskKey(key),
        model: modelToUse,
        topicProfile: {
          id: topicProfile.id,
          shortLabel: topicProfile.shortLabel,
          domain: topicProfile.domain
        },
        translations: translatedMap,
        keyStats: rotator.getPublicStats()
      };
    } catch (err) {
      const httpCode = err.httpCode || 0;
      lastErrorMsg = err.message || String(err);
      rotator.markError(key, httpCode, lastErrorMsg);

      if (attempt < maxAttempts - 1) {
        const backoffMs = httpCode === 429 ? 350 : 200;
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  return {
    ok: false,
    error: lastErrorMsg,
    keyStats: rotator.getPublicStats()
  };
}

async function callGeminiGenerateContent({ apiKey, model, items, videoTitle, videoMetadata, topicProfile, contextHint }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const inputPayload = items.map(item => ({
    id: item.id,
    text: item.text
  }));

  const profile = topicProfile || detectVideoTopicProfile({ videoTitle, videoMetadata, sampleItems: items });

  const promptText = [
    `Bạn là chuyên gia biên dịch phụ đề video YouTube sang Tiếng Việt chuẩn xác theo chủ đề chuyên môn.`,
    `Thông tin ngữ cảnh của video hiện tại:`,
    videoTitle ? `- Tiêu đề video: "${videoTitle}"` : "",
    videoMetadata?.author ? `- Kênh phát hành: "${videoMetadata.author}"` : "",
    `- Phân loại chủ đề (Domain): ${profile.domain}`,
    `- Phong cách dịch yêu cầu: ${profile.style}`,
    profile.glossary ? `- Quy tắc thuật ngữ chuyên ngành: ${profile.glossary}` : "",
    contextHint ? `- Ngữ cảnh câu liền trước: "${contextHint}"` : "",
    ``,
    `Yêu cầu bắt buộc khi dịch:`,
    `1. Dịch từng câu trong mảng JSON bên dưới sang Tiếng Việt thật sát nghĩa với chủ đề "${profile.shortLabel}", câu văn tự nhiên, súc tích, dễ đọc nhanh trên màn hình video.`,
    `2. Các câu liền kề trong danh sách là những mảnh nối tiếp của cùng một bài giảng/lời nói — hãy kết nối mạch ý giữa các câu để dịch chuẩn ngữ pháp, không dịch từng mảnh rời rạc.`,
    `3. Bảo toàn tuyệt đối số lượng phần tử và trường "id" tương ứng của từng câu.`,
    `4. Chỉ trả về duy nhất một mảng JSON hợp lệ theo cấu trúc: [{"id": <số>, "vi": "<bản dịch tiếng Việt>"}]`,
    ``,
    `Dữ liệu cần dịch:`,
    JSON.stringify(inputPayload)
  ].filter(Boolean).join("\n");

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  if (model.includes("3.8-flash")) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    const e = new Error(networkErr.name === "AbortError" ? "Quá thời gian chờ Gemini API (Timeout)" : networkErr.message);
    e.httpCode = 0;
    throw e;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    let errText = "";
    try {
      const errJson = await response.json();
      errText = errJson?.error?.message || response.statusText;
    } catch (_) {
      errText = response.statusText;
    }
    const e = new Error(`HTTP ${response.status}: ${errText}`);
    e.httpCode = response.status;
    throw e;
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    const e = new Error("Gemini trả về dữ liệu rỗng.");
    e.httpCode = 502;
    throw e;
  }

  return parseGeminiJsonOutput(rawText, items);
}

function parseGeminiJsonOutput(rawText, originalItems) {
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let arr;
  try {
    arr = JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      arr = JSON.parse(match[0]);
    } else {
      throw new Error("Không thể phân tích JSON từ phản hồi của Gemini.");
    }
  }

  if (!Array.isArray(arr)) {
    if (arr && Array.isArray(arr.translations)) {
      arr = arr.translations;
    } else if (arr && Array.isArray(arr.items)) {
      arr = arr.items;
    } else {
      throw new Error("Phản hồi Gemini không phải mảng JSON.");
    }
  }

  const result = {};
  const byId = new Map();
  for (const entry of arr) {
    if (entry && entry.id !== undefined) {
      const textVi = entry.vi || entry.text || entry.translation || "";
      byId.set(Number(entry.id), String(textVi).trim());
    }
  }

  originalItems.forEach((orig, idx) => {
    if (byId.has(Number(orig.id))) {
      result[orig.id] = byId.get(Number(orig.id));
    } else if (arr[idx]) {
      const fallbackVi = arr[idx].vi || arr[idx].text || arr[idx].translation || "";
      result[orig.id] = String(fallbackVi).trim();
    }
  });

  return result;
}

// ============================================================================
// Quản lý Bộ nhớ đệm Thông minh (Smart LRU Cache + Atomic Write Queue)
// Lưu cả danh sách cues gốc, bản dịch theo ID và bản dịch theo câu (byText)
// để khi reload hoặc vào lại video sẽ hiển thị tức thì (0 tốn API).
// ============================================================================
let memoryCacheMap = null;
let cacheWriteChain = Promise.resolve();

async function ensureCacheLoaded() {
  if (memoryCacheMap !== null) return memoryCacheMap;
  const stored = await chrome.storage.local.get([CACHE_STORAGE_KEY]);
  memoryCacheMap = stored[CACHE_STORAGE_KEY] || {};
  return memoryCacheMap;
}

function persistCacheAtomically() {
  cacheWriteChain = cacheWriteChain.then(async () => {
    if (!memoryCacheMap) return;
    // Áp dụng thuật toán LRU: chỉ giữ MAX_CACHED_VIDEOS được xem gần đây nhất
    const videoIds = Object.keys(memoryCacheMap);
    if (videoIds.length > MAX_CACHED_VIDEOS) {
      videoIds.sort(
        (a, b) => (memoryCacheMap[b].lastAccessedAt || memoryCacheMap[b].updatedAt || 0) -
                  (memoryCacheMap[a].lastAccessedAt || memoryCacheMap[a].updatedAt || 0)
      );
      for (let i = MAX_CACHED_VIDEOS; i < videoIds.length; i++) {
        delete memoryCacheMap[videoIds[i]];
      }
    }
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: memoryCacheMap });
  }).catch(() => {});
  return cacheWriteChain;
}

async function getVideoTranslationCache(videoId) {
  if (!videoId) return null;
  const cache = await ensureCacheLoaded();
  const entry = cache[videoId];
  if (!entry) return null;

  entry.lastAccessedAt = Date.now();
  persistCacheAtomically();
  return entry;
}

async function saveVideoCuesToCache({ videoId, videoTitle, videoMetadata, cues }) {
  if (!videoId || !Array.isArray(cues) || cues.length === 0) return null;
  const cache = await ensureCacheLoaded();
  const now = Date.now();

  const existing = cache[videoId] || {
    videoId,
    videoTitle: videoTitle || "",
    videoMetadata: videoMetadata || null,
    topicProfile: null,
    cues: [],
    translations: {},
    byText: {},
    totalCount: 0,
    updatedAt: now,
    lastAccessedAt: now
  };

  if (videoTitle) existing.videoTitle = videoTitle;
  if (videoMetadata) existing.videoMetadata = videoMetadata;

  // Nếu bộ cues mới nhiều câu hơn hoặc chưa có cues thì cập nhật và đồng bộ lại translations từ byText
  if (!Array.isArray(existing.cues) || cues.length >= existing.cues.length) {
    existing.cues = cues;
    existing.totalCount = cues.length;

    const remappedTranslations = {};
    for (const cue of cues) {
      const tKey = normalizeTextKey(cue.text);
      if (tKey && existing.byText && existing.byText[tKey]) {
        remappedTranslations[cue.id] = existing.byText[tKey];
      } else if (existing.translations && existing.translations[cue.id] !== undefined) {
        remappedTranslations[cue.id] = existing.translations[cue.id];
      }
    }
    existing.translations = remappedTranslations;
  }

  if (!existing.topicProfile) {
    const detected = detectVideoTopicProfile({
      videoTitle: existing.videoTitle,
      videoMetadata: existing.videoMetadata,
      sampleItems: existing.cues.slice(0, 15)
    });
    existing.topicProfile = {
      id: detected.id,
      shortLabel: detected.shortLabel,
      domain: detected.domain
    };
  }

  existing.updatedAt = now;
  existing.lastAccessedAt = now;
  cache[videoId] = existing;

  await persistCacheAtomically();
  return existing;
}

async function saveVideoTranslationBatchToCache({
  videoId,
  videoTitle,
  videoMetadata,
  topicProfile,
  batchItems,
  translatedMap,
  totalCount
}) {
  if (!videoId || !translatedMap) return;
  const cache = await ensureCacheLoaded();
  const now = Date.now();

  const existing = cache[videoId] || {
    videoId,
    videoTitle: videoTitle || "",
    videoMetadata: videoMetadata || null,
    topicProfile: topicProfile || null,
    cues: [],
    translations: {},
    byText: {},
    totalCount: totalCount || 0,
    updatedAt: now,
    lastAccessedAt: now
  };

  if (videoTitle) existing.videoTitle = videoTitle;
  if (videoMetadata) existing.videoMetadata = videoMetadata;
  if (topicProfile) existing.topicProfile = topicProfile;
  if (totalCount && totalCount > (existing.totalCount || 0)) {
    existing.totalCount = totalCount;
  }
  if (!existing.byText) existing.byText = {};
  if (!existing.translations) existing.translations = {};

  // Lưu theo ID và lưu cả theo nội dung câu tiếng Anh gốc (byText) để tái sử dụng bền vững
  Object.assign(existing.translations, translatedMap);

  if (Array.isArray(batchItems)) {
    for (const item of batchItems) {
      const vi = translatedMap[item.id];
      const tKey = normalizeTextKey(item.text);
      if (vi && tKey) {
        existing.byText[tKey] = vi;
      }
    }
  }

  existing.updatedAt = now;
  existing.lastAccessedAt = now;
  cache[videoId] = existing;

  await persistCacheAtomically();
}

async function clearVideoTranslationCache(videoId) {
  const cache = await ensureCacheLoaded();
  if (videoId) {
    delete cache[videoId];
  } else {
    for (const k of Object.keys(cache)) delete cache[k];
  }
  await persistCacheAtomically();
}

async function getCacheSummaryStats() {
  const cache = await ensureCacheLoaded();
  const videoIds = Object.keys(cache);
  let totalTranslatedSentences = 0;
  for (const vid of videoIds) {
    totalTranslatedSentences += Object.keys(cache[vid]?.translations || {}).length;
  }
  return {
    cachedVideosCount: videoIds.length,
    totalTranslatedSentences
  };
}

// ============================================================================
// Lắng nghe Message từ Content Script & Popup
// ============================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  (async () => {
    try {
      switch (message.type) {
        case "GET_SETTINGS_AND_STATS": {
          const settings = await ensureSettingsLoaded();
          const cacheStats = await getCacheSummaryStats();
          sendResponse({
            ok: true,
            settings,
            keyStats: rotator.getPublicStats(),
            cacheStats
          });
          break;
        }

        case "UPDATE_SETTINGS": {
          const current = await ensureSettingsLoaded();
          const updated = { ...current, ...(message.settings || {}) };
          if (!Array.isArray(updated.apiKeys)) {
            updated.apiKeys = [];
          }
          await chrome.storage.local.set({ settings: updated });
          rotator.updateKeys(updated.apiKeys);
          sendResponse({
            ok: true,
            settings: updated,
            keyStats: rotator.getPublicStats()
          });
          break;
        }

        case "SAVE_VIDEO_CUES": {
          const { videoId, videoTitle, videoMetadata, cues } = message.payload || {};
          const entry = await saveVideoCuesToCache({ videoId, videoTitle, videoMetadata, cues });
          sendResponse({ ok: true, cache: entry });
          break;
        }

        case "TRANSLATE_BATCH": {
          const { videoId, videoTitle, videoMetadata, items, contextHint, model, totalCount } = message.payload || {};
          if (!Array.isArray(items) || items.length === 0) {
            sendResponse({ ok: false, error: "Danh sách câu cần dịch trống." });
            return;
          }

          // Kiểm tra trong Cache trước khi gọi Gemini để tránh dịch lại các câu đã từng dịch
          const cachedEntry = videoId ? await getVideoTranslationCache(videoId) : null;
          const alreadyTranslated = {};
          const itemsNeedingApi = [];

          for (const item of items) {
            const tKey = normalizeTextKey(item.text);
            const fromByText = cachedEntry?.byText?.[tKey];
            const fromById = cachedEntry?.translations?.[item.id];
            if (fromByText) {
              alreadyTranslated[item.id] = fromByText;
            } else if (fromById) {
              alreadyTranslated[item.id] = fromById;
            } else {
              itemsNeedingApi.push(item);
            }
          }

          // Nếu 100% câu trong batch đã có trong Cache -> trả về ngay lập tức, 0 gọi API!
          if (itemsNeedingApi.length === 0) {
            sendResponse({
              ok: true,
              fromCache: true,
              keyIndex: 0,
              topicProfile: cachedEntry?.topicProfile || null,
              translations: alreadyTranslated,
              keyStats: rotator.getPublicStats()
            });
            return;
          }

          const result = await translateBatchWithGemini({
            items: itemsNeedingApi,
            videoTitle,
            videoMetadata,
            contextHint,
            preferredModel: model
          });

          if (result.ok) {
            const combinedTranslations = { ...alreadyTranslated, ...result.translations };
            result.translations = combinedTranslations;

            if (videoId) {
              await saveVideoTranslationBatchToCache({
                videoId,
                videoTitle,
                videoMetadata,
                topicProfile: result.topicProfile,
                batchItems: itemsNeedingApi,
                translatedMap: result.translations,
                totalCount
              });
            }
          }
          sendResponse(result);
          break;
        }

        case "GET_VIDEO_CACHE": {
          const entry = await getVideoTranslationCache(message.videoId);
          sendResponse({ ok: true, cache: entry });
          break;
        }

        case "CLEAR_VIDEO_CACHE": {
          await clearVideoTranslationCache(message.videoId);
          const cacheStats = await getCacheSummaryStats();
          sendResponse({ ok: true, cacheStats });
          break;
        }

        case "TEST_ALL_KEYS": {
          const settings = await ensureSettingsLoaded();
          if (rotator.keys.length === 0) {
            sendResponse({
              ok: false,
              error: "Chưa có API Key nào để kiểm tra.",
              keyStats: []
            });
            return;
          }
          const results = [];
          for (let i = 0; i < rotator.keys.length; i++) {
            const key = rotator.keys[i];
            const t0 = Date.now();
            try {
              const out = await callGeminiGenerateContent({
                apiKey: key,
                model: settings.model || "gemini-3.5-flash-lite",
                items: [{ id: 1, text: "Hello world" }],
                videoTitle: "Key Health Check"
              });
              rotator.markSuccess(key);
              results.push({
                index: i + 1,
                maskedKey: rotator.maskKey(key),
                ok: true,
                latencyMs: Date.now() - t0,
                sample: out[1] || "OK"
              });
            } catch (e) {
              rotator.markError(key, e.httpCode || 0, e.message);
              results.push({
                index: i + 1,
                maskedKey: rotator.maskKey(key),
                ok: false,
                latencyMs: Date.now() - t0,
                error: e.message
              });
            }
          }
          sendResponse({
            ok: true,
            results,
            keyStats: rotator.getPublicStats()
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true;
});
