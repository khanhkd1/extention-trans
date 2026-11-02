// ============================================================================
// YouTube AI Subtitle Translator - Content Script (content.js - ISOLATED World)
// Điều phối lấy transcript (Bridge + Direct DOM Fallback + Push Listener),
// chia batch dịch cuốn chiếu theo vị trí xem, đồng bộ timestamp & hiển thị UI.
// ============================================================================

(function () {
  if (window.__YT_AI_SUB_CONTENT_INITIALIZED__) return;
  window.__YT_AI_SUB_CONTENT_INITIALIZED__ = true;

  const state = {
    currentVideoId: null,
    videoTitle: "",
    videoMetadata: null,
    topicProfile: null,
    cues: [],                 // [{ id, start, end, duration, text }]
    translations: {},         // { [id]: "Bản dịch tiếng Việt" }
    cachedEntry: null,
    inFlightIds: new Set(),
    pendingBatches: [],
    activeWorkers: 0,
    sessionToken: 0,
    activeCueId: null,
    settings: {
      displayMode: "bilingual",
      fontSize: 20,
      autoTranslate: true,
      batchSize: 25,
      concurrency: 2,
      model: "gemini-3.5-flash-lite"
    },
    statusText: "Đang chờ video...",
    lastKeyInfo: null,
    bottomOffsetPercent: 12
  };

  let overlayContainer = null;
  let viLineEl = null;
  let enLineEl = null;
  let statusBadgeEl = null;
  let statusTextEl = null;
  let modeBtnEl = null;
  let syncTimer = null;

  function isLikelyRealTranscript(cues) {
    if (!Array.isArray(cues) || cues.length < 5) return false;
    if (cues.length >= 18) return true;

    const gaps = [];
    for (let i = 1; i < cues.length; i++) {
      gaps.push(cues[i].start - cues[i - 1].start);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)] || 999;
    return medianGap < 18;
  }

  // --------------------------------------------------------------------------
  // 1. Khởi tạo & Lắng nghe thay đổi Video trên YouTube (SPA Navigation)
  // --------------------------------------------------------------------------
  async function init() {
    await loadSettingsFromBackground();
    setupBridgeListener();
    setupRuntimeListener();
    setupNavigationWatcher();
    setupDirectDomRecoveryPolling();
    checkAndHandleCurrentUrl();
  }

  async function loadSettingsFromBackground() {
    try {
      const res = await sendMessageAsync({ type: "GET_SETTINGS_AND_STATS" });
      if (res && res.ok && res.settings) {
        state.settings = { ...state.settings, ...res.settings };
      }
    } catch (_) {}
  }

  function getWatchVideoId() {
    if (!location.pathname.startsWith("/watch")) return null;
    const params = new URLSearchParams(location.search);
    return params.get("v");
  }

  function setupNavigationWatcher() {
    window.addEventListener("yt-navigate-finish", () => {
      setTimeout(checkAndHandleCurrentUrl, 200);
    });
    window.addEventListener("popstate", () => {
      setTimeout(checkAndHandleCurrentUrl, 200);
    });
    setInterval(() => {
      const vid = getWatchVideoId();
      if (vid && vid !== state.currentVideoId) {
        checkAndHandleCurrentUrl();
      } else if (!vid && state.currentVideoId) {
        resetVideoState();
      }
    }, 1200);
  }

  function resetVideoState() {
    state.sessionToken += 1;
    state.currentVideoId = null;
    state.videoMetadata = null;
    state.topicProfile = null;
    state.cues = [];
    state.translations = {};
    state.cachedEntry = null;
    state.inFlightIds.clear();
    state.pendingBatches = [];
    state.activeCueId = null;
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (overlayContainer) {
      overlayContainer.classList.add("yt-ai-sub-hidden");
    }
  }

  function normalizeTextKey(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  async function checkAndHandleCurrentUrl() {
    const videoId = getWatchVideoId();
    if (!videoId) {
      resetVideoState();
      return;
    }
    if (videoId === state.currentVideoId && state.cues.length > 0) {
      return;
    }

    resetVideoState();
    state.currentVideoId = videoId;
    const currentSession = state.sessionToken;

    await ensureOverlayMounted();
    updateStatusBadge("⏳ Đang kiểm tra Cache & Transcript...", "loading");

    // 1. Kiểm tra Cache thông minh trước tiên (Khôi phục tức thì nếu video đã từng mở/dịch)
    try {
      const cacheRes = await sendMessageAsync({
        type: "GET_VIDEO_CACHE",
        videoId
      });
      if (cacheRes?.ok && cacheRes.cache && currentSession === state.sessionToken) {
        state.cachedEntry = cacheRes.cache;
        const cached = cacheRes.cache;

        // Nếu trong Cache đã lưu sẵn danh sách cues của video này -> Khôi phục ngay (0ms)!
        if (isLikelyRealTranscript(cached.cues)) {
          state.videoTitle = cached.videoTitle || document.title.replace(/ - YouTube$/, "");
          state.videoMetadata = cached.videoMetadata || null;
          state.topicProfile = cached.topicProfile || null;
          state.cues = cached.cues;
          state.translations = { ...(cached.translations || {}) };

          // Bổ sung khớp theo nội dung câu (byText) nếu có
          if (cached.byText) {
            for (const cue of state.cues) {
              if (state.translations[cue.id] === undefined) {
                const tKey = normalizeTextKey(cue.text);
                if (tKey && cached.byText[tKey]) {
                  state.translations[cue.id] = cached.byText[tKey];
                }
              }
            }
          }

          startVideoTimeSync();
          const doneCount = Object.keys(state.translations).length;
          const totalCount = state.cues.length;
          const topicTag = state.topicProfile?.shortLabel ? ` [${state.topicProfile.shortLabel}]` : "";

          // Nếu đã dịch đủ 100% câu trong Cache -> Hoàn tất ngay, không cần mở panel hay gọi AI!
          if (doneCount >= totalCount && totalCount > 0) {
            updateStatusBadge(`⚡ Đã tải ${doneCount}/${totalCount} câu từ Cache${topicTag}`, "ready");
            renderCurrentSubtitle();
            return;
          }

          // Nếu mới dịch một phần từ lần xem trước -> Dịch tiếp phần còn thiếu!
          if (doneCount > 0 && state.settings.autoTranslate && state.settings.displayMode !== "off") {
            updateStatusBadge(`⚡ Cache ${doneCount}/${totalCount} câu • Đang dịch phần còn lại...`, "translating");
            scheduleTranslationBatches(currentSession);
            return;
          }
        }
      }
    } catch (_) {}

    if (currentSession !== state.sessionToken) return;

    // 2. Nếu chưa có trong Cache, yêu cầu page-bridge.js trích xuất transcript từ YouTube
    updateStatusBadge("⏳ Đang lấy transcript...", "loading");
    const transcriptRes = await requestTranscriptFromBridge(videoId);
    if (currentSession !== state.sessionToken) return;

    if (
      transcriptRes &&
      transcriptRes.ok &&
      isLikelyRealTranscript(transcriptRes.cues)
    ) {
      state.videoMetadata = transcriptRes.videoMetadata || null;
      await applyExtractedCues(transcriptRes.cues, transcriptRes.videoTitle, currentSession);
      return;
    }

    // 3. Fallback đọc trực tiếp từ DOM nếu bảng "Bản chép lời" đã hiển thị
    const retryDomCues = extractCuesDirectlyFromDom();
    if (isLikelyRealTranscript(retryDomCues)) {
      await applyExtractedCues(retryDomCues, document.title.replace(/ - YouTube$/, ""), currentSession);
      return;
    }

    const errMsg = transcriptRes?.error || "Hãy bấm chọn tab 'Bản chép lời' bên phải video để nạp phụ đề.";
    updateStatusBadge(`⚠️ ${errMsg}`, "error");
  }

  async function applyExtractedCues(cues, videoTitle, sessionToken) {
    if (sessionToken !== state.sessionToken || !isLikelyRealTranscript(cues)) return;

    // Chỉ cập nhật nếu bộ cues mới đầy đủ hơn bộ hiện tại
    if (state.cues.length > 0 && cues.length <= state.cues.length) return;

    state.videoTitle = videoTitle || document.title.replace(/ - YouTube$/, "");
    state.cues = cues;
    state.inFlightIds.clear();
    state.pendingBatches = [];

    // Gửi bộ cues lên Background để lưu vào Cache và đối chiếu lại toàn bộ câu đã dịch (qua byText & byId)
    try {
      const saveRes = await sendMessageAsync({
        type: "SAVE_VIDEO_CUES",
        payload: {
          videoId: state.currentVideoId,
          videoTitle: state.videoTitle,
          videoMetadata: state.videoMetadata,
          cues: state.cues
        }
      });
      if (saveRes?.ok && saveRes.cache && sessionToken === state.sessionToken) {
        state.cachedEntry = saveRes.cache;
        if (saveRes.cache.topicProfile) {
          state.topicProfile = saveRes.cache.topicProfile;
        }
        if (saveRes.cache.translations) {
          state.translations = { ...state.translations, ...saveRes.cache.translations };
        }
      }
    } catch (_) {}

    if (sessionToken !== state.sessionToken) return;

    // Khớp bổ sung từ cachedEntry.byText nếu có
    if (state.cachedEntry?.byText) {
      for (const cue of state.cues) {
        if (state.translations[cue.id] === undefined) {
          const tKey = normalizeTextKey(cue.text);
          if (tKey && state.cachedEntry.byText[tKey]) {
            state.translations[cue.id] = state.cachedEntry.byText[tKey];
          }
        }
      }
    }

    startVideoTimeSync();

    const translatedCount = Object.keys(state.translations).length;
    const totalCount = state.cues.length;
    const topicTag = state.topicProfile?.shortLabel ? ` [${state.topicProfile.shortLabel}]` : "";

    if (translatedCount >= totalCount) {
      updateStatusBadge(`⚡ Đã tải ${totalCount}/${totalCount} câu từ Cache${topicTag}`, "ready");
      renderCurrentSubtitle();
      return;
    }

    if (state.settings.autoTranslate && state.settings.displayMode !== "off") {
      scheduleTranslationBatches(sessionToken);
    } else {
      updateStatusBadge(`⏸ Đã lấy ${totalCount} câu (Bấm để dịch)`, "idle");
    }
  }

  // --------------------------------------------------------------------------
  // 2. Bộ Đọc Trực Tiếp Bảng "Bản chép lời" trên DOM (Loại trừ hoàn toàn "Phân cảnh")
  // --------------------------------------------------------------------------
  function parseTimestampToSec(str) {
    if (!str || typeof str !== "string") return NaN;
    const cleaned = str.trim();
    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(cleaned)) return NaN;
    const parts = cleaned.split(":").map(Number);
    if (parts.some(isNaN)) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }

  function extractCuesDirectlyFromDom() {
    try {
      // Ưu tiên 1: Các thẻ segment chuẩn của Bản chép lời
      const segmentNodes = Array.from(
        document.querySelectorAll(
          "ytd-transcript-segment-renderer, transcript-segment-view-model, ytw-transcript-segment-view-model"
        )
      );
      if (segmentNodes.length >= 6) {
        const rawCues = [];
        for (const node of segmentNodes) {
          const fullText = (node.innerText || node.textContent || "").trim();
          const match = fullText.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
          if (match) {
            const startSec = parseTimestampToSec(match[1]);
            const text = match[2].replace(/\s+/g, " ").trim();
            if (!isNaN(startSec) && text && !/^\[.*\]$/.test(text)) {
              rawCues.push({
                start: startSec,
                duration: 4.0,
                end: startSec + 4.0,
                text
              });
            }
          }
        }
        if (isLikelyRealTranscript(rawCues)) {
          return normalizeDomCues(rawCues);
        }
      }

      // Ưu tiên 2: Quét các phần tử lá timestamp trong bảng Bản chép lời (bỏ qua hoàn toàn Phân cảnh)
      const panels = Array.from(
        document.querySelectorAll(
          "ytd-transcript-renderer, ytd-transcript-search-panel-renderer, ytd-transcript-segment-list-renderer, ytd-engagement-panel-section-list-renderer"
        )
      );

      for (const panel of panels) {
        const panelId = panel.getAttribute("target-id") || panel.getAttribute("panel-identifier") || "";
        if (panelId.includes("comments") || panelId.includes("macro-markers") || panelId.includes("description")) {
          continue;
        }

        const headerText = (
          panel.querySelector("ytd-engagement-panel-title-header-renderer")?.textContent || ""
        ).toLowerCase();

        if (
          headerText &&
          !headerText.includes("bản chép lời") &&
          !headerText.includes("transcript") &&
          !headerText.includes("trong video này") &&
          !headerText.includes("in this video")
        ) {
          continue;
        }

        const allEls = panel.querySelectorAll("*");
        const timeLeaves = [];
        for (const el of allEls) {
          if (el.children.length > 0) continue;
          // Loại trừ tuyệt đối các phần tử thuộc tab Phân cảnh (Chapters)
          if (
            el.closest(
              "ytd-macro-markers-list-renderer, ytd-macro-markers-list-item-renderer, macro-markers-panel-item-view-model"
            )
          ) {
            continue;
          }
          const t = (el.textContent || "").trim();
          if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) {
            timeLeaves.push({ el, timeStr: t, startSec: parseTimestampToSec(t) });
          }
        }

        if (timeLeaves.length >= 6) {
          const rawCues = [];
          const leafSet = new Set(timeLeaves.map(x => x.el));

          for (const item of timeLeaves) {
            if (isNaN(item.startSec)) continue;

            let rowEl = item.el.parentElement;
            let bestRowEl = null;

            for (let depth = 0; depth < 5 && rowEl && rowEl !== panel; depth++) {
              let count = 0;
              const descendants = rowEl.querySelectorAll("*");
              for (const d of descendants) {
                if (leafSet.has(d)) {
                  count += 1;
                  if (count > 1) break;
                }
              }
              if (count > 1) break;

              const txt = (rowEl.innerText || rowEl.textContent || "").trim();
              if (txt.length > item.timeStr.length + 1) {
                bestRowEl = rowEl;
              }
              rowEl = rowEl.parentElement;
            }

            if (bestRowEl) {
              let fullText = (bestRowEl.innerText || bestRowEl.textContent || "").trim();
              if (fullText.startsWith(item.timeStr)) {
                fullText = fullText.slice(item.timeStr.length).trim();
              } else {
                fullText = fullText.replace(item.timeStr, "").trim();
              }
              fullText = fullText.replace(/\s+/g, " ").trim();

              if (fullText && !/^\[.*\]$/.test(fullText)) {
                rawCues.push({
                  start: item.startSec,
                  duration: 4.0,
                  end: item.startSec + 4.0,
                  text: fullText
                });
              }
            }
          }

          if (isLikelyRealTranscript(rawCues)) {
            return normalizeDomCues(rawCues);
          }
        }
      }
    } catch (_) {}
    return [];
  }

  function normalizeDomCues(rawCues) {
    const sorted = [...rawCues].sort((a, b) => a.start - b.start);
    const deduped = [];

    for (let i = 0; i < sorted.length; i++) {
      const cur = { ...sorted[i] };
      if (!cur.text) continue;
      if (deduped.length > 0) {
        const prev = deduped[deduped.length - 1];
        if (prev.text === cur.text && Math.abs(cur.start - prev.start) < 2.5) continue;
        // Nối liền mạch end của câu trước tới start của câu tiếp theo nếu cách nhau <= 10s
        if (prev.end > cur.start || cur.start - prev.start <= 10.0) {
          prev.end = cur.start;
          prev.duration = Math.max(0.4, prev.end - prev.start);
        }
      }
      deduped.push(cur);
    }

    const merged = [];
    let buffer = null;
    for (const seg of deduped) {
      if (!buffer) {
        buffer = { ...seg };
        continue;
      }
      const gap = seg.start - buffer.end;
      const combinedDuration = seg.end - buffer.start;
      const combinedText = `${buffer.text} ${seg.text}`.trim();
      const endsWithPunct = /[.!?…]$/.test(buffer.text);

      if (gap <= 0.8 && !endsWithPunct && combinedDuration <= 6.5 && combinedText.length <= 135) {
        buffer.text = combinedText;
        buffer.end = seg.end;
        buffer.duration = buffer.end - buffer.start;
      } else {
        merged.push(buffer);
        buffer = { ...seg };
      }
    }
    if (buffer) merged.push(buffer);

    return merged.map((c, idx) => ({
      id: idx,
      start: Number(c.start.toFixed(2)),
      end: Number(c.end.toFixed(2)),
      duration: Number(Math.max(0.5, c.end - c.start).toFixed(2)),
      text: c.text
    }));
  }

  function setupDirectDomRecoveryPolling() {
    setInterval(() => {
      if (!state.currentVideoId) return;
      const domCues = extractCuesDirectlyFromDom();
      if (isLikelyRealTranscript(domCues) && domCues.length > state.cues.length) {
        applyExtractedCues(domCues, document.title.replace(/ - YouTube$/, ""), state.sessionToken);
      }
    }, 1200);
  }

  // --------------------------------------------------------------------------
  // 3. Giao tiếp với Page Bridge (MAIN World)
  // --------------------------------------------------------------------------
  const pendingBridgeRequests = new Map();

  function setupBridgeListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== "YT_AI_SUB_BRIDGE") return;

      if (msg.type === "TRANSCRIPT_RESULT" && msg.requestId) {
        const resolver = pendingBridgeRequests.get(msg.requestId);
        if (resolver) {
          pendingBridgeRequests.delete(msg.requestId);
          resolver(msg.payload);
        }
      } else if (msg.type === "TRANSCRIPT_PUSH" && msg.payload?.ok) {
        const p = msg.payload;
        if (
          p.videoId === state.currentVideoId &&
          isLikelyRealTranscript(p.cues) &&
          p.cues.length > state.cues.length
        ) {
          if (p.videoMetadata) state.videoMetadata = p.videoMetadata;
          applyExtractedCues(p.cues, p.videoTitle, state.sessionToken);
        }
      }
    });
  }

  function requestTranscriptFromBridge(videoId) {
    return new Promise((resolve) => {
      const requestId = `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const timeoutId = setTimeout(() => {
        if (pendingBridgeRequests.has(requestId)) {
          pendingBridgeRequests.delete(requestId);
          resolve({ ok: false, error: "Quá thời gian trích xuất transcript." });
        }
      }, 15000);

      pendingBridgeRequests.set(requestId, (payload) => {
        clearTimeout(timeoutId);
        resolve(payload);
      });

      window.postMessage({
        source: "YT_AI_SUB_CONTENT",
        type: "FETCH_TRANSCRIPT",
        requestId,
        videoId
      }, "*");
    });
  }

  // --------------------------------------------------------------------------
  // 4. Chia Batch Dịch Cuốn Chiếu & Ưu tiên Vị trí Đang Xem (Seek-Aware)
  // --------------------------------------------------------------------------
  function scheduleTranslationBatches(sessionToken) {
    if (sessionToken !== state.sessionToken || state.cues.length === 0) return;

    const videoEl = document.querySelector("video.html5-main-video");
    const currentTime = videoEl ? videoEl.currentTime : 0;

    let startIdx = findCueIndexNearTime(currentTime);
    if (startIdx < 0) startIdx = 0;

    const untranslatedFromCurrent = [];
    const untranslatedBeforeCurrent = [];

    for (let i = 0; i < state.cues.length; i++) {
      const cue = state.cues[i];
      if (state.translations[cue.id] !== undefined || state.inFlightIds.has(cue.id)) {
        continue;
      }
      if (i >= startIdx) {
        untranslatedFromCurrent.push(cue);
      } else {
        untranslatedBeforeCurrent.push(cue);
      }
    }

    const orderedUntranslated = [...untranslatedFromCurrent, ...untranslatedBeforeCurrent];
    if (orderedUntranslated.length === 0) {
      updateProgressStatus();
      return;
    }

    state.pendingBatches = [];

    const firstPrioritySize = Math.min(10, orderedUntranslated.length);
    const firstBatch = orderedUntranslated.slice(0, firstPrioritySize);
    state.pendingBatches.push(firstBatch);

    const normalBatchSize = Math.max(10, Number(state.settings.batchSize) || 25);
    for (let i = firstPrioritySize; i < orderedUntranslated.length; i += normalBatchSize) {
      state.pendingBatches.push(orderedUntranslated.slice(i, i + normalBatchSize));
    }

    updateProgressStatus();
    pumpTranslationQueue(sessionToken);
  }

  function reprioritizeQueueForTime(targetTimeSec) {
    if (state.cues.length === 0 || state.settings.displayMode === "off") return;
    const idx = findCueIndexNearTime(targetTimeSec);
    if (idx < 0) return;

    const cueAtTime = state.cues[idx];
    if (!cueAtTime || state.translations[cueAtTime.id] !== undefined || state.inFlightIds.has(cueAtTime.id)) {
      return;
    }

    scheduleTranslationBatches(state.sessionToken);
  }

  function pumpTranslationQueue(sessionToken) {
    if (sessionToken !== state.sessionToken) return;
    const maxConcurrency = Math.max(1, Math.min(3, Number(state.settings.concurrency) || 2));

    while (state.activeWorkers < maxConcurrency && state.pendingBatches.length > 0) {
      const nextBatch = state.pendingBatches.shift();
      const validItems = nextBatch.filter(
        c => state.translations[c.id] === undefined && !state.inFlightIds.has(c.id)
      );
      if (validItems.length === 0) continue;

      validItems.forEach(c => state.inFlightIds.add(c.id));
      state.activeWorkers += 1;

      processSingleBatch(validItems, sessionToken).finally(() => {
        state.activeWorkers = Math.max(0, state.activeWorkers - 1);
        if (sessionToken === state.sessionToken) {
          pumpTranslationQueue(sessionToken);
        }
      });
    }
  }

  async function processSingleBatch(batchItems, sessionToken) {
    const firstId = batchItems[0].id;
    const prevCue = firstId > 0 ? state.cues[firstId - 1] : null;
    const contextHint = prevCue ? prevCue.text : "";

    updateProgressStatus();

    const response = await sendMessageAsync({
      type: "TRANSLATE_BATCH",
      payload: {
        videoId: state.currentVideoId,
        videoTitle: state.videoTitle,
        videoMetadata: state.videoMetadata,
        items: batchItems.map(c => ({ id: c.id, text: c.text })),
        contextHint,
        totalCount: state.cues.length,
        model: state.settings.model
      }
    });

    if (sessionToken !== state.sessionToken) return;

    batchItems.forEach(c => state.inFlightIds.delete(c.id));

    if (response && response.ok && response.translations) {
      Object.assign(state.translations, response.translations);
      state.lastKeyInfo = {
        keyIndex: response.keyIndex,
        maskedKey: response.maskedKey,
        model: response.model
      };
      if (response.topicProfile) {
        state.topicProfile = response.topicProfile;
      }
      updateProgressStatus();
      renderCurrentSubtitle();
    } else {
      const errMsg = response?.error || "Lỗi gọi Gemini API";
      updateStatusBadge(`⚠️ ${errMsg}`, "error");
    }
  }

  function updateProgressStatus() {
    const total = state.cues.length;
    const done = Object.keys(state.translations).length;
    const keyTag = state.lastKeyInfo ? ` • Key #${state.lastKeyInfo.keyIndex}` : "";
    const topicTag = state.topicProfile?.shortLabel ? ` [${state.topicProfile.shortLabel}]` : "";

    if (done >= total && total > 0) {
      updateStatusBadge(`✅ Đã dịch ${done}/${total} câu${keyTag}${topicTag}`, "ready");
    } else {
      updateStatusBadge(`🔄 Đang dịch ${done}/${total} câu${keyTag}${topicTag}`, "translating");
    }
  }

  // --------------------------------------------------------------------------
  // 5. Đồng bộ Timestamp Độ Chính Xác Cao (Binary Search O(log N))
  // --------------------------------------------------------------------------
  function findActiveCueAtTime(timeSec) {
    const cues = state.cues;
    if (!cues || cues.length === 0) return null;

    let low = 0;
    let high = cues.length - 1;
    let candidate = null;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];

      if (timeSec < cue.start - 0.15) {
        high = mid - 1;
      } else if (timeSec > cue.end + 0.35) {
        low = mid + 1;
      } else {
        candidate = cue;
        break;
      }
    }

    return candidate;
  }

  function findCueIndexNearTime(timeSec) {
    const cues = state.cues;
    if (!cues || cues.length === 0) return -1;

    for (let i = 0; i < cues.length; i++) {
      if (cues[i].end >= timeSec) return i;
    }
    return 0;
  }

  function startVideoTimeSync() {
    if (syncTimer) clearInterval(syncTimer);

    const videoEl = document.querySelector("video.html5-main-video");
    if (videoEl && !videoEl.__ytAiSubBound) {
      videoEl.__ytAiSubBound = true;
      videoEl.addEventListener("timeupdate", renderCurrentSubtitle);
      videoEl.addEventListener("seeked", () => {
        renderCurrentSubtitle();
        reprioritizeQueueForTime(videoEl.currentTime);
      });
    }

    syncTimer = setInterval(renderCurrentSubtitle, 90);
    renderCurrentSubtitle();
  }

  function renderCurrentSubtitle() {
    if (!overlayContainer || !viLineEl || !enLineEl) return;

    if (state.settings.displayMode === "off" || state.cues.length === 0) {
      overlayContainer.classList.add("yt-ai-sub-hidden");
      return;
    }

    const videoEl = document.querySelector("video.html5-main-video");
    if (!videoEl) return;

    const currentTime = videoEl.currentTime;
    const activeCue = findActiveCueAtTime(currentTime);

    if (!activeCue) {
      overlayContainer.classList.add("yt-ai-sub-hidden");
      state.activeCueId = null;
      return;
    }

    overlayContainer.classList.remove("yt-ai-sub-hidden");
    const translatedText = state.translations[activeCue.id];

    const baseFontPx = Number(state.settings.fontSize) || 20;
    viLineEl.style.fontSize = `${baseFontPx}px`;
    enLineEl.style.fontSize = `${Math.max(12, Math.round(baseFontPx * 0.76))}px`;

    if (translatedText) {
      viLineEl.textContent = translatedText;
      viLineEl.classList.remove("yt-ai-sub-pending");
    } else {
      viLineEl.textContent = "⏳ Đang dịch bằng Gemini AI...";
      viLineEl.classList.add("yt-ai-sub-pending");
    }

    if (state.settings.displayMode === "bilingual") {
      enLineEl.textContent = activeCue.text;
      enLineEl.style.display = "block";
    } else {
      enLineEl.style.display = "none";
    }
  }

  // --------------------------------------------------------------------------
  // 6. Giao diện Overlay Phụ đề & Thanh Trạng thái trên #movie_player
  // --------------------------------------------------------------------------
  async function ensureOverlayMounted() {
    let player = document.getElementById("movie_player");
    for (let i = 0; i < 20 && !player; i++) {
      await new Promise(r => setTimeout(r, 250));
      player = document.getElementById("movie_player");
    }
    if (!player) return;

    if (!overlayContainer || !player.contains(overlayContainer)) {
      overlayContainer = document.createElement("div");
      overlayContainer.id = "yt-ai-subtitle-overlay";
      overlayContainer.className = "yt-ai-sub-overlay yt-ai-sub-hidden";
      overlayContainer.style.bottom = `${state.bottomOffsetPercent}%`;

      const box = document.createElement("div");
      box.className = "yt-ai-sub-box";

      viLineEl = document.createElement("div");
      viLineEl.className = "yt-ai-sub-line-vi";

      enLineEl = document.createElement("div");
      enLineEl.className = "yt-ai-sub-line-en";

      box.appendChild(viLineEl);
      box.appendChild(enLineEl);
      overlayContainer.appendChild(box);
      player.appendChild(overlayContainer);

      enableVerticalDrag(overlayContainer, player);
    }

    if (!statusBadgeEl || !player.contains(statusBadgeEl)) {
      statusBadgeEl = document.createElement("div");
      statusBadgeEl.id = "yt-ai-subtitle-badge";
      statusBadgeEl.className = "yt-ai-sub-badge";

      statusTextEl = document.createElement("span");
      statusTextEl.className = "yt-ai-sub-badge-text";
      statusTextEl.textContent = "🤖 AI Sub";

      modeBtnEl = document.createElement("button");
      modeBtnEl.className = "yt-ai-sub-badge-btn";
      modeBtnEl.title = "Đổi chế độ hiển thị phụ đề (Song ngữ / Chỉ Tiếng Việt / Tắt)";
      updateModeButtonLabel();

      modeBtnEl.addEventListener("click", async (e) => {
        e.stopPropagation();
        const modes = ["bilingual", "vi-only", "off"];
        const nextIdx = (modes.indexOf(state.settings.displayMode) + 1) % modes.length;
        state.settings.displayMode = modes[nextIdx];
        updateModeButtonLabel();
        renderCurrentSubtitle();

        await sendMessageAsync({
          type: "UPDATE_SETTINGS",
          settings: { displayMode: state.settings.displayMode }
        });

        if (state.settings.displayMode !== "off" && Object.keys(state.translations).length < state.cues.length) {
          scheduleTranslationBatches(state.sessionToken);
        }
      });

      const retryBtn = document.createElement("button");
      retryBtn.className = "yt-ai-sub-badge-btn";
      retryBtn.textContent = "↻";
      retryBtn.title = "Xoá cache video này và dịch lại";
      retryBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!state.currentVideoId) return;
        await sendMessageAsync({ type: "CLEAR_VIDEO_CACHE", videoId: state.currentVideoId });
        state.currentVideoId = null;
        checkAndHandleCurrentUrl();
      });

      statusBadgeEl.appendChild(statusTextEl);
      statusBadgeEl.appendChild(modeBtnEl);
      statusBadgeEl.appendChild(retryBtn);
      player.appendChild(statusBadgeEl);
    }
  }

  function updateModeButtonLabel() {
    if (!modeBtnEl) return;
    const map = {
      "bilingual": "Việt + Anh",
      "vi-only": "Chỉ Việt",
      "off": "Đang Tắt"
    };
    modeBtnEl.textContent = map[state.settings.displayMode] || "Việt + Anh";
  }

  function updateStatusBadge(text, statusType) {
    state.statusText = text;
    if (statusTextEl) {
      statusTextEl.textContent = text;
    }
    if (statusBadgeEl) {
      statusBadgeEl.setAttribute("data-status", statusType || "info");
    }
  }

  function enableVerticalDrag(overlayEl, playerEl) {
    let isDragging = false;
    let startY = 0;
    let startBottomPercent = state.bottomOffsetPercent;

    overlayEl.addEventListener("mousedown", (e) => {
      isDragging = true;
      startY = e.clientY;
      startBottomPercent = state.bottomOffsetPercent;
      overlayEl.classList.add("yt-ai-sub-dragging");
      e.stopPropagation();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const playerRect = playerEl.getBoundingClientRect();
      if (playerRect.height <= 0) return;
      const deltaY = startY - e.clientY;
      const deltaPercent = (deltaY / playerRect.height) * 100;
      state.bottomOffsetPercent = Math.max(4, Math.min(80, startBottomPercent + deltaPercent));
      overlayEl.style.bottom = `${state.bottomOffsetPercent}%`;
    });

    window.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        overlayEl.classList.remove("yt-ai-sub-dragging");
      }
    });
  }

  // --------------------------------------------------------------------------
  // 7. Lắng nghe Lệnh từ Popup Extension
  // --------------------------------------------------------------------------
  function setupRuntimeListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return false;

      if (message.type === "SETTINGS_UPDATED") {
        state.settings = { ...state.settings, ...(message.settings || {}) };
        updateModeButtonLabel();
        renderCurrentSubtitle();
        if (state.settings.displayMode !== "off" && state.cues.length > 0 && state.activeWorkers === 0) {
          scheduleTranslationBatches(state.sessionToken);
        }
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "GET_PAGE_STATUS") {
        sendResponse({
          ok: true,
          videoId: state.currentVideoId,
          videoTitle: state.videoTitle,
          topicProfile: state.topicProfile,
          totalCues: state.cues.length,
          translatedCues: Object.keys(state.translations).length,
          statusText: state.statusText,
          lastKeyInfo: state.lastKeyInfo
        });
        return false;
      }

      if (message.type === "FORCE_RETRANSLATE") {
        const vid = state.currentVideoId;
        if (vid) {
          sendMessageAsync({ type: "CLEAR_VIDEO_CACHE", videoId: vid }).then(() => {
            state.currentVideoId = null;
            checkAndHandleCurrentUrl();
          });
        }
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });
  }

  function sendMessageAsync(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  init();
})();
