# Kiến trúc Hệ thống & Thuật toán: Internal CSV Comparator

Hệ thống được thiết kế để xử lý các file CSV dung lượng cực lớn (hàng trăm MB đến GB) mà không gây tràn bộ nhớ (OOM) cho cả Server lẫn Client.

## 1. Thuật toán Cốt lõi: Row-level Hashing Diff
Thay vì so sánh từng ký tự (như Git Diff), hệ thống sử dụng Hash (Mã băm) kết hợp xử lý Stream để tối ưu tốc độ và RAM.

* **Bước 1: Xác định Định danh (Primary Key)**
  Xác định một cột làm khóa chính duy nhất cho mỗi dòng (ví dụ: `id`, `sku`, `email`).
* **Bước 2: Xử lý Tệp Gốc (Base File)**
  - Đọc file dưới dạng Stream.
  - Mỗi dòng (Row Object) đi qua, gộp nội dung lại và băm (MD5/SHA-1) để tạo ra một mã Hash ngắn.
  - Lưu vào bộ nhớ tạm thời cấu trúc Map: `{ [PrimaryKey]: HashString }`.
* **Bước 3: Xử lý Tệp Đích (Target File) & Phân loại**
  - Đọc file đích dưới dạng Stream, tạo mã Hash cho dòng hiện tại.
  - Tra cứu Primary Key của dòng này trong Map đã tạo ở Bước 2:
    - Nếu KHÔNG tồn tại: Phân loại là `ADDED`.
    - Nếu CÓ tồn tại: So sánh 2 mã Hash. Khác nhau là `MODIFIED`, giống nhau là `UNCHANGED`.
    - Sau khi kiểm tra, XÓA khóa đó khỏi Map.
  - Khi quét xong file đích, các khóa CÒN SÓT LẠI trong Map chính là `DELETED`.

## 2. Luồng Xử lý Dữ liệu (Data Flow)
1. **Upload:** Client gửi 2 file CSV lên Server qua Multipart Form-data.
2. **Stream & Process:** Server KHÔNG load toàn bộ file vào RAM. Sử dụng `fs.createReadStream` kết hợp `csv-parser` để bóc tách luồng thành từng dòng (chunk).
3. **Write Temp Output:** Kết quả của thuật toán Diff được ghi nối tiếp ngay lập tức dưới dạng luồng (`fs.createWriteStream`) ra một file tạm định dạng JSON Lines (`.jsonl`).
4. **Pagination:** Frontend gọi API lấy kết quả theo trang (ví dụ: `page=1&limit=100`). Server chỉ đọc file `.jsonl` đúng số dòng được yêu cầu và trả về.
5. **Render:** Frontend dùng `Virtual Scrolling` để hiển thị hàng trăm ngàn dòng mượt mà.