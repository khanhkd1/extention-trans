// ============================================================================
// YouTube AI Subtitle Translator - Page Bridge (page-bridge.js - MAIN World)
// Chạy trong ngữ cảnh trang YouTube (MAIN world) để truy cập trực tiếp
// movie_player, ytInitialData, Polymer/Wiz state, Network XHR/Fetch & DOM.
// ============================================================================

(function () {
  if (window.__YT_AI_SUB_BRIDGE_INSTALLED__) return;
  window.__YT_AI_SUB_BRIDGE_INSTALLED__ = true;

  const interceptedTimedTextByVideo = new Map();
  const interceptedPotUrlByVideo = new Map();

  function getVideoIdFromUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      return u.searchParams.get("v") || null;
    } catch (_) {
      return null;
    }
  }

  function getCurrentVideoId() {
    return getVideoIdFromUrl(location.href);
  }

  /**
   * Kiểm tra chắc chắn mảng cues là Bản chép lời (Transcript) thực sự
   * chứ KHÔNG PHẢI danh sách Phân cảnh (Chapters - chỉ có 4-10 mục cách nhau 1-2 phút)
   */
  function isLikelyRealTranscript(cues) {
    if (!Array.isArray(cues) || cues.length < 5) return false;
    if (cues.length >= 18) return true;

    const gaps = [];
    for (let i = 1; i < cues.length; i++) {
      gaps.push(cues[i].start - cues[i - 1].start);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)] || 999;
    // Transcript thực sự có khoảng cách trung vị giữa các câu < 18 giây (Chapters thường > 45 giây)
    return medianGap < 18;
  }

  function extractVideoMetadata(pr) {
    const vd = pr?.videoDetails || {};
    const mf = pr?.microformat?.playerMicroformatRenderer || {};
    return {
      title: vd.title || document.title.replace(/ - YouTube$/, "") || "YouTube Video",
      author: vd.author || "",
      shortDescription: (vd.shortDescription || "").slice(0, 350),
      keywords: Array.isArray(vd.keywords) ? vd.keywords.slice(0, 15) : [],
      category: mf.category || ""
    };
  }

  function notifyTranscriptCaptured(videoId, cues, source) {
    if (!videoId || !isLikelyRealTranscript(cues)) return;

    const existing = interceptedTimedTextByVideo.get(videoId) || [];
    const merged = existing.length > cues.length ? existing : cues;
    interceptedTimedTextByVideo.set(videoId, merged);

    const pr = getActivePlayerResponse(videoId);
    const meta = extractVideoMetadata(pr);

    window.postMessage({
      source: "YT_AI_SUB_BRIDGE",
      type: "TRANSCRIPT_PUSH",
      payload: {
        ok: true,
        source,
        videoId,
        videoTitle: meta.title,
        videoMetadata: meta,
        cues: merged
      }
    }, "*");
  }

  // --------------------------------------------------------------------------
  // 1. Hook Fetch & XMLHttpRequest cho mọi gói tin Phụ đề & Innertube Transcript
  // --------------------------------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    let reqUrl = "";
    try {
      if (typeof args[0] === "string") {
        reqUrl = args[0];
      } else if (args[0] && typeof args[0].url === "string") {
        reqUrl = args[0].url;
      }
    } catch (_) {}

    const response = await originalFetch.apply(this, args);

    try {
      if (reqUrl.includes("/api/timedtext")) {
        const vid = getVideoIdFromUrl(reqUrl) || getCurrentVideoId();
        if (vid && reqUrl.includes("pot=")) {
          interceptedPotUrlByVideo.set(vid, reqUrl);
        }
        const clone = response.clone();
        clone.text().then(text => {
          if (vid && text && text.length > 20) {
            const cues = parseTimedTextPayload(text);
            if (isLikelyRealTranscript(cues)) {
              notifyTranscriptCaptured(vid, cues, "fetch-timedtext");
            }
          }
        }).catch(() => {});
      } else if (
        reqUrl.includes("get_transcript") ||
        reqUrl.includes("/youtubei/v1/next")
      ) {
        const vid = getCurrentVideoId();
        const clone = response.clone();
        clone.text().then(text => {
          if (!vid || !text || text.length < 50) return;
          if (text.includes("transcript") || text.includes("startMs")) {
            const json = JSON.parse(text);
            const cues = parseGetTranscriptResponse(json);
            if (isLikelyRealTranscript(cues)) {
              notifyTranscriptCaptured(vid, cues, "fetch-innertube");
            }
          }
        }).catch(() => {});
      }
    } catch (_) {}

    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytAiUrl = typeof url === "string" ? url : String(url || "");
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__ytAiUrl || "";
        if (url.includes("/api/timedtext")) {
          const vid = getVideoIdFromUrl(url) || getCurrentVideoId();
          if (vid && url.includes("pot=")) {
            interceptedPotUrlByVideo.set(vid, url);
          }
          if (vid && this.responseText && this.responseText.length > 20) {
            const cues = parseTimedTextPayload(this.responseText);
            if (isLikelyRealTranscript(cues)) {
              notifyTranscriptCaptured(vid, cues, "xhr-timedtext");
            }
          }
        } else if (
          url.includes("get_transcript") ||
          url.includes("/youtubei/v1/next")
        ) {
          const vid = getCurrentVideoId();
          const text = this.responseText || "";
          if (vid && text.length > 50 && (text.includes("transcript") || text.includes("startMs"))) {
            const json = JSON.parse(text);
            const cues = parseGetTranscriptResponse(json);
            if (isLikelyRealTranscript(cues)) {
              notifyTranscriptCaptured(vid, cues, "xhr-innertube");
            }
          }
        }
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };

  // --------------------------------------------------------------------------
  // 2. Các hàm Parse Phụ đề Đa Định Dạng (Tuân thủ TrustedHTML CSP của YouTube)
  // --------------------------------------------------------------------------
  function decodeHtmlEntities(str) {
    if (!str || typeof str !== "string") return "";
    const namedEntities = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&apos;": "'",
      "&nbsp;": " "
    };
    return str
      .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (m) => namedEntities[m.toLowerCase()] || m)
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode( parseInt(dec, 10) ))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode( parseInt(hex, 16) ))
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractTextFromYouTubeTextObj(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj.trim();
    if (typeof obj.simpleText === "string") return obj.simpleText.trim();
    if (typeof obj.content === "string") return obj.content.trim();
    if (obj.elementsAttributedString && typeof obj.elementsAttributedString.content === "string") {
      return obj.elementsAttributedString.content.trim();
    }
    if (Array.isArray(obj.runs)) {
      return obj.runs.map(r => r.text || "").join("").trim();
    }
    return "";
  }

  function parseTimestampString(str) {
    if (!str || typeof str !== "string") return NaN;
    const cleaned = str.trim();
    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(cleaned)) return NaN;
    const parts = cleaned.split(":").map(Number);
    if (parts.some(isNaN)) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }

  function parseTimedTextPayload(rawText) {
    const trimmed = (rawText || "").trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed);
        if (Array.isArray(data.events)) {
          const rawCues = [];
          for (const ev of data.events) {
            if (!ev.segs || typeof ev.tStartMs !== "number") continue;
            const text = ev.segs
              .map(s => s.utf8 || "")
              .join("")
              .replace(/\n+/g, " ")
              .replace(/\s+/g, " ")
              .trim();

            if (!text || /^\[.*\]$/.test(text)) continue;

            const startSec = ev.tStartMs / 1000;
            const durSec = (ev.dDurationMs || 3500) / 1000;
            rawCues.push({
              start: startSec,
              duration: durSec,
              end: startSec + durSec,
              text: decodeHtmlEntities(text)
            });
          }
          if (rawCues.length > 0) return normalizeAndMergeCues(rawCues);
        }

        const transcriptCues = parseGetTranscriptResponse(data);
        if (transcriptCues.length > 0) return transcriptCues;
      } catch (_) {}
    }

    if (trimmed.startsWith("<")) {
      try {
        const rawCues = [];
        // Parse bằng RegExp thuần để không vi phạm TrustedHTML của DOMParser trên YouTube
        const tagRegex = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
        let match;
        while ((match = tagRegex.exec(trimmed)) !== null) {
          const attrs = match[2] || "";
          const innerRaw = (match[3] || "").replace(/<[^>]+>/g, "");
          const content = decodeHtmlEntities(innerRaw);
          if (!content || /^\[.*\]$/.test(content)) continue;

          let startSec = NaN;
          let durSec = 3.5;

          const startMatch = attrs.match(/\bstart=["']([^"']+)["']/i);
          const durMatch = attrs.match(/\bdur=["']([^"']+)["']/i);
          const tMatch = attrs.match(/\bt=["']([^"']+)["']/i);
          const dMatch = attrs.match(/\bd=["']([^"']+)["']/i);

          if (startMatch) {
            startSec = parseFloat(startMatch[1]);
            if (durMatch) durSec = parseFloat(durMatch[1]);
          } else if (tMatch) {
            startSec = parseFloat(tMatch[1]) / 1000;
            if (dMatch) durSec = parseFloat(dMatch[1]) / 1000;
          }

          if (!isNaN(startSec)) {
            rawCues.push({
              start: startSec,
              duration: Math.max(0.5, durSec || 3.5),
              end: startSec + Math.max(0.5, durSec || 3.5),
              text: content
            });
          }
        }
        if (rawCues.length > 0) return normalizeAndMergeCues(rawCues);
      } catch (_) {}
    }

    return [];
  }

  function parseGetTranscriptResponse(rootObj) {
    try {
      const rawCues = [];
      const visited = new WeakSet();

      const tryExtractCue = (obj) => {
        if (!obj || typeof obj !== "object") return false;
        // Bỏ qua các đối tượng Phân cảnh (Chapters)
        if (obj.timeDescription || obj.macroMarkersListItemRenderer) return false;

        let startSec = NaN;
        if (obj.startMs !== undefined && !isNaN(parseFloat(obj.startMs))) {
          startSec = parseFloat(obj.startMs) / 1000;
        } else if (obj.startOffsetMs !== undefined && !isNaN(parseFloat(obj.startOffsetMs))) {
          startSec = parseFloat(obj.startOffsetMs) / 1000;
        } else {
          const timeStr =
            extractTextFromYouTubeTextObj(obj.startTimeText) ||
            extractTextFromYouTubeTextObj(obj.timestampText) ||
            extractTextFromYouTubeTextObj(obj.timestamp);
          if (timeStr) {
            startSec = parseTimestampString(timeStr);
          }
        }

        if (isNaN(startSec) || startSec < 0) return false;

        let endSec = startSec + 4.0;
        if (obj.endMs !== undefined && !isNaN(parseFloat(obj.endMs))) {
          endSec = parseFloat(obj.endMs) / 1000;
        } else if (obj.durationMs !== undefined && !isNaN(parseFloat(obj.durationMs))) {
          endSec = startSec + parseFloat(obj.durationMs) / 1000;
        }

        const text =
          extractTextFromYouTubeTextObj(obj.snippet) ||
          extractTextFromYouTubeTextObj(obj.text) ||
          extractTextFromYouTubeTextObj(obj.cue) ||
          extractTextFromYouTubeTextObj(obj.content);

        if (!text || text.length < 2 || /^\[.*\]$/.test(text) || /^\d{1,2}:\d{2}/.test(text)) {
          return false;
        }

        rawCues.push({
          start: startSec,
          duration: Math.max(0.8, endSec - startSec),
          end: Math.max(startSec + 0.8, endSec),
          text: decodeHtmlEntities(text)
        });
        return true;
      };

      const walk = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (visited.has(obj)) return;
        visited.add(obj);

        if (obj.transcriptSegmentRenderer && tryExtractCue(obj.transcriptSegmentRenderer)) return;
        if (obj.transcriptSegmentViewModel && tryExtractCue(obj.transcriptSegmentViewModel)) return;
        if (obj.transcriptCueRenderer && tryExtractCue(obj.transcriptCueRenderer)) return;
        if (tryExtractCue(obj)) return;

        if (Array.isArray(obj)) {
          for (const item of obj) walk(item);
        } else {
          for (const k of Object.keys(obj)) {
            if (
              k === "playerOverlays" ||
              k === "topbar" ||
              k === "microformat" ||
              k === "macroMarkersListEntity" ||
              k === "macroMarkersListRenderer" ||
              k === "macroMarkersListItemRenderer" ||
              k === "structuredDescriptionContentRenderer"
            ) {
              continue;
            }
            walk(obj[k]);
          }
        }
      };

      walk(rootObj);
      if (!isLikelyRealTranscript(rawCues)) return [];
      return normalizeAndMergeCues(rawCues);
    } catch (_) {
      return [];
    }
  }

  /**
   * Chuẩn hóa mốc thời gian (nối liền end của câu trước tới start của câu tiếp theo
   * nếu cách nhau <= 10s để phụ đề hiển thị liên tục không bị ngắt quãng).
   */
  function normalizeAndMergeCues(rawCues) {
    if (!rawCues || rawCues.length === 0) return [];

    const sorted = [...rawCues].sort((a, b) => a.start - b.start);

    const deduped = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = { ...sorted[i] };
      if (!cur.text) continue;

      if (deduped.length > 0) {
        const prev = deduped[deduped.length - 1];
        if (prev.text === cur.text && Math.abs(cur.start - prev.start) < 2.5) {
          prev.end = Math.max(prev.end, cur.end);
          prev.duration = prev.end - prev.start;
          continue;
        }
        // Khớp nối liền mạch câu trước với câu sau nếu khoảng cách <= 10 giây
        const gapToNext = cur.start - prev.start;
        if (prev.end > cur.start || gapToNext <= 10.0) {
          prev.end = cur.start;
          prev.duration = Math.max(0.4, prev.end - prev.start);
        }
      }
      deduped.push(cur);
    }

    const merged = [];
    let buffer = null;

    for (let i = 0; i < deduped.length; i++) {
      const seg = deduped[i];
      if (!buffer) {
        buffer = { ...seg };
        continue;
      }

      const gap = seg.start - buffer.end;
      const combinedDuration = seg.end - buffer.start;
      const combinedText = `${buffer.text} ${seg.text}`.trim();
      const endsWithSentencePunct = /[.!?…]$/.test(buffer.text);

      const shouldMerge =
        gap <= 0.8 &&
        !endsWithSentencePunct &&
        combinedDuration <= 6.5 &&
        combinedText.length <= 135;

      if (shouldMerge) {
        buffer.text = combinedText;
        buffer.end = seg.end;
        buffer.duration = buffer.end - buffer.start;
      } else {
        merged.push(buffer);
        buffer = { ...seg };
      }
    }
    if (buffer) merged.push(buffer);

    return merged.map((cue, idx) => ({
      id: idx,
      start: Number(cue.start.toFixed(2)),
      end: Number(cue.end.toFixed(2)),
      duration: Number(Math.max(0.5, cue.end - cue.start).toFixed(2)),
      text: cue.text
    }));
  }

  // --------------------------------------------------------------------------
  // 3. Bộ Đọc DOM Vạn Năng từ Bảng "Bản chép lời" (Loại trừ hoàn toàn "Phân cảnh")
  // --------------------------------------------------------------------------
  function readTranscriptDomSegments() {
    const allPanels = Array.from(
      document.querySelectorAll(
        "ytd-transcript-renderer, ytd-transcript-search-panel-renderer, ytd-transcript-segment-list-renderer, ytd-engagement-panel-section-list-renderer"
      )
    );

    // Cách A: Đọc từ Polymer/Wiz .data gắn trên các panel hoặc custom element con
    for (const panel of allPanels) {
      const panelId = panel.getAttribute("target-id") || panel.getAttribute("panel-identifier") || "";
      if (panelId.includes("macro-markers") || panelId.includes("comments") || panelId.includes("description")) {
        continue;
      }

      const pData = panel.data || panel.__data?.data || panel.__data || panel.polymerController?.data;
      if (pData) {
        const parsed = parseGetTranscriptResponse(pData);
        if (isLikelyRealTranscript(parsed)) return parsed;
      }
    }

    // Cách B: Đọc từ các thẻ segment (<ytd-transcript-segment-renderer>, <transcript-segment-view-model>)
    const segmentNodes = Array.from(
      document.querySelectorAll(
        "ytd-transcript-segment-renderer, transcript-segment-view-model, ytw-transcript-segment-view-model"
      )
    );

    if (segmentNodes.length >= 5) {
      const rawCues = [];
      for (const node of segmentNodes) {
        const fullText = (node.innerText || node.textContent || "").trim();
        const match = fullText.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
        if (match) {
          const startSec = parseTimestampString(match[1]);
          const text = decodeHtmlEntities(match[2].replace(/\s+/g, " ").trim());
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
        return normalizeAndMergeCues(rawCues);
      }
    }

    // Cách C: Universal Timestamp-Leaf Walker (Loại trừ hoàn toàn các thẻ Phân cảnh / Chapters)
    for (const panel of allPanels) {
      const panelId = panel.getAttribute("target-id") || panel.getAttribute("panel-identifier") || "";
      if (panelId.includes("macro-markers") || panelId.includes("comments") || panelId.includes("description")) {
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

      const allElements = panel.querySelectorAll("*");
      const timeLeaves = [];

      for (const el of allElements) {
        if (el.children.length > 0) continue;
        // Loại trừ các phần tử nằm trong danh sách Phân cảnh (Chapters)
        if (
          el.closest(
            "ytd-macro-markers-list-renderer, ytd-macro-markers-list-item-renderer, macro-markers-panel-item-view-model"
          )
        ) {
          continue;
        }
        const t = (el.textContent || "").trim();
        if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) {
          timeLeaves.push({ el, timeStr: t, startSec: parseTimestampString(t) });
        }
      }

      if (timeLeaves.length >= 6) {
        const rawCues = [];
        const timeLeafSet = new Set(timeLeaves.map(item => item.el));

        for (const item of timeLeaves) {
          if (isNaN(item.startSec)) continue;

          let rowEl = item.el.parentElement;
          let bestRowEl = null;

          for (let depth = 0; depth < 5 && rowEl && rowEl !== panel; depth++) {
            let leafCount = 0;
            const subEls = rowEl.querySelectorAll("*");
            for (const s of subEls) {
              if (timeLeafSet.has(s)) {
                leafCount += 1;
                if (leafCount > 1) break;
              }
            }
            if (leafCount > 1) break;

            const rowText = (rowEl.innerText || rowEl.textContent || "").trim();
            if (rowText.length > item.timeStr.length + 1) {
              bestRowEl = rowEl;
            }
            rowEl = rowEl.parentElement;
          }

          if (bestRowEl) {
            let fullRowText = (bestRowEl.innerText || bestRowEl.textContent || "").trim();
            if (fullRowText.startsWith(item.timeStr)) {
              fullRowText = fullRowText.slice(item.timeStr.length).trim();
            } else {
              fullRowText = fullRowText.replace(item.timeStr, "").trim();
            }
            fullRowText = decodeHtmlEntities(fullRowText.replace(/\s+/g, " ").trim());

            if (fullRowText && !/^\[.*\]$/.test(fullRowText)) {
              rawCues.push({
                start: item.startSec,
                duration: 4.0,
                end: item.startSec + 4.0,
                text: fullRowText
              });
            }
          }
        }

        if (isLikelyRealTranscript(rawCues)) {
          return normalizeAndMergeCues(rawCues);
        }
      }
    }

    return [];
  }

  // --------------------------------------------------------------------------
  // 4. Quy trình Trích xuất Đa Tầng
  // --------------------------------------------------------------------------
  function getActivePlayerResponse(expectedVideoId) {
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        const pr = player.getPlayerResponse();
        if (pr && (!expectedVideoId || pr?.videoDetails?.videoId === expectedVideoId)) {
          return pr;
        }
      }
    } catch (_) {}

    if (window.ytInitialPlayerResponse) {
      const pr = window.ytInitialPlayerResponse;
      if (!expectedVideoId || pr?.videoDetails?.videoId === expectedVideoId) {
        return pr;
      }
    }
    return null;
  }

  function pickBestCaptionTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const manualEn = tracks.find(t => t.languageCode?.startsWith("en") && t.kind !== "asr");
    if (manualEn) return manualEn;
    const autoEn = tracks.find(t => t.languageCode?.startsWith("en"));
    if (autoEn) return autoEn;
    return tracks[0];
  }

  async function extractTranscriptForVideo(videoId) {
    let playerResponse = null;
    for (let i = 0; i < 10; i++) {
      playerResponse = getActivePlayerResponse(videoId);
      if (playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }

    const videoMetadata = extractVideoMetadata(playerResponse);
    const videoTitle = videoMetadata.title;

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    // 1. Kiểm tra nếu đã bắt được toàn bộ transcript từ XHR/Fetch trước đó
    if (interceptedTimedTextByVideo.has(videoId)) {
      const cached = interceptedTimedTextByVideo.get(videoId);
      if (isLikelyRealTranscript(cached)) {
        return {
          ok: true,
          source: "intercepted-network",
          videoId,
          videoTitle,
          videoMetadata,
          cues: cached
        };
      }
    }

    // 2. Kiểm tra nếu bảng "Bản chép lời" đang hiển thị sẵn trên màn hình
    const existingDomCues = readTranscriptDomSegments();
    if (isLikelyRealTranscript(existingDomCues)) {
      interceptedTimedTextByVideo.set(videoId, existingDomCues);
      return {
        ok: true,
        source: "dom-transcript-panel",
        videoId,
        videoTitle,
        videoMetadata,
        cues: existingDomCues
      };
    }

    // 3. Tự động kích hoạt bảng "Bản chép lời" và chờ dữ liệu
    const panelCues = await extractFromEngagementPanel(videoId);
    if (isLikelyRealTranscript(panelCues)) {
      interceptedTimedTextByVideo.set(videoId, panelCues);
      return {
        ok: true,
        source: "engagement-panel",
        videoId,
        videoTitle,
        videoMetadata,
        cues: panelCues
      };
    }

    // 4. Bật nhanh CC trên #movie_player để bắt gói tin có POT token
    const potCues = await triggerPlayerSubtitleFetch(videoId);
    if (isLikelyRealTranscript(potCues)) {
      interceptedTimedTextByVideo.set(videoId, potCues);
      return {
        ok: true,
        source: "player-pot",
        videoId,
        videoTitle,
        videoMetadata,
        cues: potCues
      };
    }

    // 5. Fallback gọi trực tiếp baseUrl
    const chosenTrack = pickBestCaptionTrack(tracks);
    if (chosenTrack && chosenTrack.baseUrl) {
      for (const fmt of ["json3", "srv3", ""]) {
        try {
          const u = new URL(chosenTrack.baseUrl, location.origin);
          if (fmt) u.searchParams.set("fmt", fmt);
          const res = await originalFetch(u.toString(), { credentials: "include" });
          if (res.ok) {
            const text = await res.text();
            const cues = parseTimedTextPayload(text);
            if (isLikelyRealTranscript(cues)) {
              interceptedTimedTextByVideo.set(videoId, cues);
              return {
                ok: true,
                source: `baseurl-${fmt || "xml"}`,
                videoId,
                videoTitle,
                videoMetadata,
                cues
              };
            }
          }
        } catch (_) {}
      }
    }

    if (tracks.length === 0) {
      return {
        ok: false,
        error: "Video này không có phụ đề/script trên YouTube."
      };
    }

    return {
      ok: false,
      error: "Hãy bấm chọn tab 'Bản chép lời' ở khung bên phải video để nạp phụ đề."
    };
  }

  async function extractFromEngagementPanel(videoId) {
    try {
      let segments = readTranscriptDomSegments();
      if (isLikelyRealTranscript(segments)) return segments;

      const app = document.querySelector("ytd-app");
      const transcriptCmd = findTranscriptOpenCommandInInitialData();
      if (app && transcriptCmd) {
        if (typeof app.handleCommand === "function") {
          app.handleCommand(transcriptCmd);
        } else if (typeof app.resolveCommand === "function") {
          app.resolveCommand(transcriptCmd);
        }
      }

      const transcriptBtn = document.querySelector(
        'ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i], button[aria-label*="bản chép lời" i]'
      );
      if (transcriptBtn) {
        transcriptBtn.click();
      }

      clickTranscriptChipIfPresent();

      for (let wait = 0; wait < 28; wait++) {
        await new Promise(r => setTimeout(r, 250));

        if (wait === 2 || wait === 6 || wait === 12) {
          clickTranscriptChipIfPresent();
        }

        if (interceptedTimedTextByVideo.has(videoId)) {
          const intercepted = interceptedTimedTextByVideo.get(videoId);
          if (isLikelyRealTranscript(intercepted)) {
            return intercepted;
          }
        }

        segments = readTranscriptDomSegments();
        if (isLikelyRealTranscript(segments)) {
          return segments;
        }
      }
    } catch (_) {}
    return [];
  }

  function clickTranscriptChipIfPresent() {
    try {
      const candidates = Array.from(
        document.querySelectorAll(
          "ytd-engagement-panel-section-list-renderer chip-shape, ytd-engagement-panel-section-list-renderer yt-chip-cloud-chip-renderer, ytd-engagement-panel-section-list-renderer button, ytd-engagement-panel-section-list-renderer [role='tab'], ytd-engagement-panel-section-list-renderer span"
        )
      );
      for (const el of candidates) {
        if (el.children.length > 2) continue;
        const label = (el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
        if (label === "bản chép lời" || label === "transcript") {
          el.click();
          break;
        }
      }
    } catch (_) {}
  }

  function findTranscriptOpenCommandInInitialData() {
    try {
      const data = window.ytInitialData;
      if (!data) return null;

      let foundCommand = null;
      const walk = (obj) => {
        if (!obj || typeof obj !== "object" || foundCommand) return;
        if (obj.videoDescriptionTranscriptSectionRenderer) {
          const cmd = obj.videoDescriptionTranscriptSectionRenderer?.primaryButton?.buttonRenderer?.command;
          if (cmd) {
            foundCommand = cmd;
            return;
          }
        }
        if (obj.chipViewModel) {
          const txt = (obj.chipViewModel.text || "").toLowerCase();
          if (txt.includes("bản chép lời") || txt.includes("transcript")) {
            const cmd = obj.chipViewModel?.tapCommand?.innertubeCommand;
            if (cmd) {
              foundCommand = cmd;
              return;
            }
          }
        }
        if (Array.isArray(obj)) {
          for (const item of obj) walk(item);
        } else {
          for (const k of Object.keys(obj)) walk(obj[k]);
        }
      };

      walk(data.engagementPanels || data);
      return foundCommand;
    } catch (_) {
      return null;
    }
  }

  async function triggerPlayerSubtitleFetch(videoId) {
    try {
      const ccBtn = document.querySelector(".ytp-subtitles-button");
      const wasOff = ccBtn && ccBtn.getAttribute("aria-pressed") === "false";

      if (wasOff) {
        ccBtn.click();
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 200));
          if (interceptedTimedTextByVideo.has(videoId)) {
            const cues = interceptedTimedTextByVideo.get(videoId);
            if (isLikelyRealTranscript(cues)) {
              if (ccBtn.getAttribute("aria-pressed") === "true") ccBtn.click();
              return cues;
            }
          }
        }
        if (ccBtn.getAttribute("aria-pressed") === "true") ccBtn.click();
      }
    } catch (_) {}
    return [];
  }

  // --------------------------------------------------------------------------
  // 5. Tự động phát hiện và đẩy dữ liệu ngay khi bảng "Bản chép lời" có trên DOM
  // --------------------------------------------------------------------------
  setInterval(() => {
    const vid = getCurrentVideoId();
    if (!vid) return;
    const currentCues = interceptedTimedTextByVideo.get(vid) || [];
    const domCues = readTranscriptDomSegments();
    if (isLikelyRealTranscript(domCues) && domCues.length > currentCues.length) {
      notifyTranscriptCaptured(vid, domCues, "auto-dom-observer");
    }
  }, 1200);

  // --------------------------------------------------------------------------
  // 6. Giao tiếp với Content Script (ISOLATED World)
  // --------------------------------------------------------------------------
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "YT_AI_SUB_CONTENT") return;

    if (msg.type === "FETCH_TRANSCRIPT") {
      const videoId = msg.videoId || getCurrentVideoId();
      if (!videoId) {
        window.postMessage({
          source: "YT_AI_SUB_BRIDGE",
          type: "TRANSCRIPT_RESULT",
          requestId: msg.requestId,
          payload: { ok: false, error: "Không xác định được Video ID." }
        }, "*");
        return;
      }

      const result = await extractTranscriptForVideo(videoId);
      window.postMessage({
        source: "YT_AI_SUB_BRIDGE",
        type: "TRANSCRIPT_RESULT",
        requestId: msg.requestId,
        payload: result
      }, "*");
    }
  });
})();
