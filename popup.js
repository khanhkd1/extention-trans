// ============================================================================
// YouTube AI Subtitle Translator - Popup Logic (popup.js)
// Quản lý giao diện Popup, kiểm tra sức khỏe Gemini Keys & đồng bộ với Tab
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  const displayModeEl = document.getElementById("displayMode");
  const modelSelectEl = document.getElementById("modelSelect");
  const fontSizeEl = document.getElementById("fontSize");
  const apiKeysInputEl = document.getElementById("apiKeysInput");
  const keyStatsListEl = document.getElementById("keyStatsList");
  const videoStatusTextEl = document.getElementById("videoStatusText");
  const videoTopicLineEl = document.getElementById("videoTopicLine");
  const cueCounterEl = document.getElementById("cueCounter");
  const progressFillEl = document.getElementById("progressFill");
  const toastMsgEl = document.getElementById("toastMsg");

  const btnSaveSettings = document.getElementById("btnSaveSettings");
  const btnTestKeys = document.getElementById("btnTestKeys");
  const btnRetranslate = document.getElementById("btnRetranslate");
  const btnClearAllCache = document.getElementById("btnClearAllCache");

  function showToast(text, isError = false) {
    toastMsgEl.textContent = text;
    toastMsgEl.style.color = isError ? "#f87171" : "#4ade80";
    setTimeout(() => {
      if (toastMsgEl.textContent === text) toastMsgEl.textContent = "";
    }, 3200);
  }

  function renderKeyStats(keyStats) {
    keyStatsListEl.innerHTML = "";
    if (!Array.isArray(keyStats) || keyStats.length === 0) {
      keyStatsListEl.innerHTML = `<div class="key-empty">Chưa có API Key nào được cấu hình. Hãy lấy key miễn phí bên dưới và bấm Lưu.</div>`;
      return;
    }

    for (const k of keyStats) {
      const item = document.createElement("div");
      item.className = "key-item";

      let dotClass = "dot";
      let statusLabel = `OK (${k.successes}/${k.requests})`;

      if (k.status === "cooldown" || k.remainingCooldownSec > 0) {
        dotClass = "dot cooldown";
        statusLabel = `Nghỉ ${k.remainingCooldownSec}s (429: ${k.rateLimits})`;
      } else if (k.status === "error") {
        dotClass = "dot error";
        statusLabel = k.lastError || `Lỗi (${k.errors})`;
      }

      item.innerHTML = `
        <div class="key-left">
          <span class="${dotClass}"></span>
          <strong>Key #${k.index}</strong>
          <span class="key-code">${k.maskedKey}</span>
        </div>
        <div class="key-stats">${statusLabel}</div>
      `;
      keyStatsListEl.appendChild(item);
    }
  }

  async function refreshPopupData() {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS_AND_STATS" }, (res) => {
      if (!res || !res.ok) return;
      const s = res.settings || {};
      displayModeEl.value = s.displayMode || "bilingual";
      modelSelectEl.value = s.model || "gemini-3.5-flash-lite";
      fontSizeEl.value = s.fontSize || 20;
      apiKeysInputEl.value = Array.isArray(s.apiKeys) ? s.apiKeys.join("\n") : "";
      renderKeyStats(res.keyStats || []);
      if (res.cacheStats) {
        const count = res.cacheStats.cachedVideosCount || 0;
        btnClearAllCache.textContent = count > 0 ? `🗑 Xoá Cache (${count} video)` : `🗑 Xoá Cache`;
      }
    });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && tab.url.includes("youtube.com/watch")) {
      chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_STATUS" }, (pageRes) => {
        if (chrome.runtime.lastError || !pageRes || !pageRes.ok) {
          videoStatusTextEl.textContent = "Hãy tải lại trang YouTube (F5) để kích hoạt.";
          return;
        }
        videoStatusTextEl.textContent = pageRes.statusText || "Đang hoạt động";
        if (pageRes.topicProfile && pageRes.topicProfile.shortLabel) {
          videoTopicLineEl.textContent = `🏷 Chủ đề AI nhận diện: ${pageRes.topicProfile.shortLabel}`;
          videoTopicLineEl.style.display = "block";
        } else {
          videoTopicLineEl.style.display = "none";
        }
        const total = pageRes.totalCues || 0;
        const done = pageRes.translatedCues || 0;
        cueCounterEl.textContent = `${done}/${total} câu`;
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        progressFillEl.style.width = `${pct}%`;
      });
    } else {
      videoStatusTextEl.textContent = "Hãy mở một video trên YouTube.com để bắt đầu.";
      cueCounterEl.textContent = "0/0 câu";
      progressFillEl.style.width = "0%";
    }
  }

  btnSaveSettings.addEventListener("click", async () => {
    const keys = apiKeysInputEl.value
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    const newSettings = {
      displayMode: displayModeEl.value,
      model: modelSelectEl.value,
      fontSize: Math.max(14, Math.min(36, Number(fontSizeEl.value) || 20)),
      apiKeys: keys
    };

    chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: newSettings }, async (res) => {
      if (res && res.ok) {
        renderKeyStats(res.keyStats || []);
        if (keys.length === 0) {
          showToast("Đã xoá danh sách API Key. Hãy nhập key mới để dịch.", true);
        } else {
          showToast(`✅ Đã lưu cấu hình (${keys.length} API Key)!`);
        }

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings: newSettings }, () => {
            void chrome.runtime.lastError;
          });
        }
      }
    });
  });

  btnTestKeys.addEventListener("click", () => {
    btnTestKeys.disabled = true;
    btnTestKeys.textContent = "Đang thử...";
    chrome.runtime.sendMessage({ type: "TEST_ALL_KEYS" }, (res) => {
      btnTestKeys.disabled = false;
      btnTestKeys.textContent = "Kiểm tra Keys";
      if (res && res.ok) {
        renderKeyStats(res.keyStats || []);
        const okCount = (res.results || []).filter(r => r.ok).length;
        const total = (res.results || []).length;
        showToast(`✅ ${okCount}/${total} Gemini Keys hoạt động tốt!`, okCount === 0);
      } else {
        showToast(`⚠️ ${res?.error || "Lỗi khi kiểm tra Keys"}`, true);
      }
    });
  });

  btnRetranslate.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && tab.url.includes("youtube.com/watch")) {
      chrome.tabs.sendMessage(tab.id, { type: "FORCE_RETRANSLATE" }, () => {
        void chrome.runtime.lastError;
        showToast("🔄 Đang tải và dịch lại video...");
        setTimeout(refreshPopupData, 800);
      });
    } else {
      showToast("Hãy mở trang xem video YouTube trước!", true);
    }
  });

  btnClearAllCache.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CLEAR_VIDEO_CACHE" }, () => {
      btnClearAllCache.textContent = "🗑 Xoá Cache";
      showToast("🗑 Đã xoá toàn bộ bộ nhớ đệm bản dịch!");
    });
  });

  refreshPopupData();
});
