# Kế hoạch Triển khai & Tech Stack

## 1. Công nghệ Sử dụng
* **Package Manager:** `pnpm` (Bắt buộc để tối ưu tốc độ cài đặt và dung lượng).
* **Frontend:** React, TypeScript, Tailwind CSS.
* **UI Performance Core:** `@tanstack/react-virtual` (Xử lý Virtual Scrolling cho bảng so sánh).
* **Backend:** Node.js, Express (hoặc Next.js Route Handlers).
* **Backend Utilities:** 
  - `csv-parser`: Bóc tách file CSV tối ưu cho luồng Stream.
  - `crypto`: Module nội tại của Node.js để thực thi thuật toán Hashing.
  - `fs` (File System): Xử lý Read/Write Stream.

## 2. Các Giai đoạn Triển khai (Phases)

### Phase 1: Core Diff Engine (Backend)
- Thiết lập endpoint nhận 2 file CSV upload.
- Cài đặt thuật toán Row-level Hashing Diff kết hợp Node.js Stream.
- Ghi kết quả so sánh ra ổ đĩa dưới dạng `diff-result.jsonl`.

### Phase 2: API Phân trang (Backend)
- Thiết lập endpoint GET đọc kết quả từ file `diff-result.jsonl`.
- Hỗ trợ tham số `page` và `limit` để đọc theo dạng chunk, không load toàn bộ file JSONL vào bộ nhớ.

### Phase 3: Giao diện Trực quan (Frontend)
- Khởi tạo UI bảng so sánh 2 cột (Side-by-side) với React & Tailwind.
- Tích hợp `@tanstack/react-virtual` để giữ vững 60FPS khi cuộn bảng.
- Hiển thị màu sắc theo trạng thái: Thêm mới (Xanh), Xóa (Đỏ), Chỉnh sửa (Vàng).