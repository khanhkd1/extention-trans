# 🎬 YouTube AI Subtitle Translator (Gemini Key Rotator)

Chrome Extension (Manifest V3) dùng nội bộ giúp **tự động trích xuất transcript (script) từ video YouTube**, **nhận diện chuyên ngành/chủ đề video**, dịch sang **Tiếng Việt bằng Gemini AI** thông qua cơ chế **xoay vòng nhiều API Key miễn phí (Round-Robin + Smart Failover)**, **lưu trữ bộ nhớ đệm thông minh (Smart Cache)** giúp tiết kiệm tối đa quota/chi phí, và **hiển thị phụ đề song ngữ chuẩn xác theo từng mốc thời gian (timestamp)** ngay trên màn hình video.

---

## ✨ Tính năng nổi bật

1. **Trích xuất Transcript 4 Tầng Đa Dự Phòng (4-Tier Extractor)**:
   - **Tier 1**: Bắt trực tiếp gói tin `/api/timedtext` (kèm `pot` token) từ trình phát `#movie_player` của YouTube.
   - **Tier 2**: Đọc dữ liệu từ bảng *"Hiện bản chép lời"* (Engagement Panel API & DOM) — hỗ trợ hoàn hảo cả giao diện YouTube mới ("Trong video này" ➔ "Bản chép lời") và vượt qua hoàn toàn lỗi giới hạn `HTTP 429`.
   - **Tier 3**: Kích hoạt trình phát nạp phụ đề gốc và bắt gói tin mạng.
   - **Tier 4**: Tải trực tiếp từ `captionTracks` (`json3` / `srv3` / `xml`).
   - Tuân thủ 100% chuẩn bảo mật **TrustedHTML** của YouTube.

2. **Gom Cụm Câu & Chuẩn Hóa Thời Gian (Sentence Normalization)**:
   - Phụ đề tự động (ASR) của YouTube thường bị cắt vụn (2–3 giây) và chồng lấn thời gian. Extension tự động khử trùng lặp, nối mốc kết thúc câu trước chạm mốc bắt đầu câu sau và gom thành câu hoàn chỉnh (3–6.5 giây) giúp câu văn mạch lạc, dễ đọc.

3. **Phân Tích Chủ Đề Video & Tối Ưu Prompt Chuyên Ngành (Domain/Topic Detection)**:
   - Tự động phân tích Tiêu đề, Kênh phát hành, Danh mục và Nội dung video để nhận diện chủ đề:
     - **AI & Prompt Engineering**: Nhận diện thuật ngữ *Prompt, Context, Few-shot, Output Constraints, Persona/Role, Iterative prompting, Claude, LLM, Token, Hallucination...*
     - **Lập trình & Công nghệ phần mềm**: *API, SDK, Framework, Backend, Frontend, Database, Deploy, Component, State, Hook...*
     - **Tài chính, Đầu tư & Kinh doanh**: *Bull/Bear market, Liquidity, Yield, Portfolio, Valuation, ROI, Cash flow...*
     - **Khoa học, Y sinh & Sức khỏe**
     - **Gaming & Esports**
     - **Giáo dục & Chia sẻ kiến thức tổng hợp**
   - Đưa trực tiếp ngữ cảnh chuyên môn và quy tắc từ điển vào `promptText` giúp Gemini dịch chuẩn xác, không bị gượng gạo.

4. **Xoay Vòng Nhiều Gemini API Key Miễn Phí (`GeminiKeyRotator`)**:
   - Tự động chia tải tuần tự: `Key #1 ➔ Key #2 ➔ Key #3 ➔ Key #1...`
   - Nếu 1 Key chạm giới hạn Rate Limit (`HTTP 429`), hệ thống tự động đưa Key đó vào chế độ nghỉ (`Cooldown 45s`) và **chuyển ngay lập tức** sang Key tiếp theo mà không làm gián đoạn phụ đề.

5. **Bộ Nhớ Đệm Thông Minh (Smart Cache - Tiết Kiệm 100% Chi Phí Khi Xem Lại)**:
   - **Snapshot Caching**: Lưu toàn bộ câu thoại gốc (`cues`) và bản dịch (`translations`) của video vào bộ nhớ nội bộ trình duyệt.
   - **Tái sử dụng tức thì (`<10ms`)**: Khi bạn nhấn `F5` hoặc mở lại video đã từng xem, phụ đề hiển thị ngay lập tức mà **không cần mở bảng chép lời và không tốn bất kỳ lượt gọi API nào**.
   - **Translation Memory (Kép theo `ID` & Nội dung câu `byText`)**: Nếu lần trước mới xem nửa video, lần sau mở lại hệ thống tự động nhận diện các câu đã dịch và chỉ gửi những câu còn thiếu lên AI.
   - Quản lý bộ nhớ theo cơ chế **LRU Cache** (tối đa 100 video gần nhất), có nút xoá cache tiện lợi.

6. **Dịch Cuốn Chiếu Ưu Tiên Vị Trí Đang Xem (Seek-Aware Progressive Translation)**:
   - Mở video ở bất kỳ mốc thời gian nào (ví dụ `&t=42s`), batch câu tại giây 42 sẽ được ưu tiên dịch trước và hiển thị chỉ sau **~1.3 – 2 giây**.
   - Khi tua video (seek) đến phút bất kỳ, extension tự động đẩy đoạn đó lên đầu hàng đợi dịch.

7. **Đồng Bộ Timestamp Bằng Binary Search & Giao Diện Linh Hoạt**:
   - Thuật toán **Binary Search (`O(log N)`)** chu kỳ quét `90ms` bám sát `video.currentTime` (hỗ trợ cả khi tua, đổi tốc độ `1.25x`, `1.5x`, `2x` và chế độ Toàn màn hình `Fullscreen`).
   - Cho phép chuột **kéo thả (drag)** khung phụ đề lên/xuống vị trí mong muốn.
   - Nút đổi chế độ hiển thị nhanh: `Song ngữ (Việt + Anh)` / `Chỉ Tiếng Việt` / `Tắt`.

---

## 📁 Cấu trúc thư mục

```text
extention-trans/
├── manifest.json       # Cấu hình Chrome Extension Manifest V3
├── background.js       # Service Worker: Xoay vòng Key, phân tích Topic, gọi Gemini API & Smart Cache
├── page-bridge.js      # Script chạy ở MAIN world: Trích xuất transcript 4 tầng tuân thủ TrustedHTML
├── content.js          # Script chạy ở ISOLATED world: Điều phối batch dịch, đồng bộ timestamp & UI
├── styles.css          # Giao diện khung phụ đề song ngữ và thanh trạng thái trên trình phát
├── popup.html          # Giao diện điều khiển khi bấm vào icon Extension
├── popup.js            # Logic kiểm tra sức khỏe Keys, quản lý Cache và tuỳ chỉnh cấu hình
├── icons/              # Bộ icon 16x16, 48x48, 128x128
└── README.md           # Tài liệu hướng dẫn cài đặt và sử dụng
```

---

## 🚀 Hướng dẫn Cài đặt Nội bộ (Load Unpacked)

Bạn không cần đưa lên Chrome Web Store, chỉ mất **30 giây** để cài đặt trực tiếp vào trình duyệt **Google Chrome** (hoặc **Brave**, **Microsoft Edge**, **Arc**, **Cốc Cốc**):

### Bước 1: Mở trang Quản lý Tiện ích
* Mở trình duyệt Chrome, nhập vào thanh địa chỉ:
  ```text
  chrome://extensions/
  ```

### Bước 2: Bật Chế độ dành cho nhà phát triển
* Ở góc trên cùng bên phải, gạt công tắc bật **Chế độ dành cho nhà phát triển** (**Developer mode**).

### Bước 3: Tải thư mục Extension lên trình duyệt
1. Bấm vào nút **Tải tiện ích đã giải nén** (**Load unpacked**) ở góc trên bên trái.
2. Trỏ đường dẫn tới đúng thư mục dự án này:
   ```text
   extention-trans
   ```
3. Bấm **Select** (Chọn).
4. Bấm vào biểu tượng mảnh ghép 🧩 trên thanh công cụ Chrome và bấm nút **Ghim (Pin 📌)** tiện ích **YouTube AI Subtitle Translator** ra ngoài.

---

## 🔑 Hướng dẫn Lấy Gemini API Key Miễn Phí & Cấu hình

1. Truy cập trang quản lý API Key chính thức của Google AI Studio:
   👉 **https://aistudio.google.com/api-keys**
2. Đăng nhập tài khoản Google và bấm nút **"Create API key"**.
3. Copy API Key vừa tạo (khuyên dùng tạo từ **2 – 3 API Keys** từ các tài khoản/project khác nhau để tiện ích tự động xoay vòng phân tải).
4. Bấm vào biểu tượng **🎬 YouTube AI Subtitle Translator** trên thanh công cụ Chrome ➔ Dán các key vào ô **"Danh sách Gemini API Keys"** (mỗi dòng 1 key) ➔ Bấm **"💾 Lưu Cấu hình"**.
5. Bấm nút **"Kiểm tra Keys"** để kiểm tra kết nối tới máy chủ Google AI.
* **Model khuyến nghị**: `gemini-3.5-flash-lite` (tốc độ dịch siêu tốc ~1.3s/batch) hoặc `gemini-flash-lite-latest` / `gemini-3.8-flash`.

---

## 🎯 Hướng dẫn Sử dụng

1. Mở bất kỳ video YouTube nào có phụ đề / transcript (ví dụ: `https://www.youtube.com/watch?v=2YCaBqP8muw`).
2. Thanh trạng thái ở góc trên bên phải khung video sẽ tự động chạy:
   - `⏳ Đang kiểm tra Cache & Transcript...` ➔ `🔄 Đang dịch 10/134 câu • Key #1 [AI & Prompt Engineering]` ➔ `✅ Đã dịch 134/134 câu`.
   - Nếu video đã từng xem trước đó: `⚡ Đã tải 134/134 câu từ Cache [AI & Prompt Engineering]` (tức thì 0 giây).
3. **Tuỳ chỉnh nhanh trên video**:
   - Bấm nút `Việt + Anh` / `Chỉ Việt` / `Đang Tắt` để đổi chế độ hiển thị.
   - Giữ chuột vào khung phụ đề để kéo lên/xuống.
   - Bấm `↻` để xoá cache của riêng video đó và dịch lại từ đầu.

---

## 🛠 Xử lý sự cố thường gặp (Troubleshooting)

1. **Vừa cài đặt nhưng tab video đang mở chưa hiện phụ đề?**
   - Nhấn `F5` (Reload) lại tab YouTube đó để Chrome nạp Content Script vào trang.
2. **Sau khi chỉnh sửa code, làm sao để cập nhật?**
   - Vào `chrome://extensions/`, bấm nút xoay tròn **Reload (🔄)** ở thẻ tiện ích, sau đó `F5` lại trang YouTube.
