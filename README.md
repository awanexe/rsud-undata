# Rumah Sakit Undata — Queue Management Dashboard

Dashboard monitoring dan pengelolaan antrean Rumah Sakit Undata. Aplikasi terdiri dari frontend statis, API proxy Vercel, dan backend Google Apps Script yang menggunakan Google Spreadsheet sebagai database.

## 1. Struktur proyek

```text
rumah-sakit-undata/
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   └── main.js
│   └── vercel.json
├── backend/
│   ├── Code.gs
│   └── appsscript.json
├── api/
│   └── proxy.js
├── .gitignore
└── README.md
```

`frontend/vercel.json` adalah file konfigurasi yang disediakan sesuai struktur proyek. **Vercel hanya membaca `vercel.json` pada Root Directory deployment.** Karena itu, jika Root Directory Vercel adalah root repository, salin file tersebut ke root repository dengan nama `vercel.json` sebelum deployment. Jangan mengatur Root Directory ke `frontend`, karena folder `api/` berada di luar folder tersebut.

## 2. Arsitektur dan alur request

```text
Browser
  |
  | GET halaman, CSS, dan JavaScript
  v
Vercel Static Hosting
  |
  | POST /api/proxy
  v
Vercel Function: api/proxy.js
  |
  | POST JSON
  v
Google Apps Script Web App: doPost()
  |
  | baca/tulis data
  v
Google Spreadsheet
```

Frontend memanggil endpoint relatif `/api/proxy`. Proxy meneruskan `action`, `payload`, dan `token` ke URL Google Apps Script yang disimpan sebagai environment variable `GAS_WEB_APP_URL`. URL backend dan kredensial tidak ditanam di file frontend.

Pembaruan dashboard menggunakan polling berkala dari browser. Ini bukan WebSocket dan bukan pembaruan instan.

## 3. Persiapan Google Spreadsheet

1. Buat Google Spreadsheet baru untuk database antrean.
2. Salin ID spreadsheet dari URL. ID adalah bagian di antara `/d/` dan `/edit`.
3. Buka **Extensions → Apps Script** dari spreadsheet tersebut.
4. Ganti isi `Code.gs` dengan file `backend/Code.gs`.
5. Buka Project Settings pada Apps Script.
6. Tambahkan Script Property berikut:

   | Property | Value |
   |---|---|
   | `SPREADSHEET_ID` | ID Google Spreadsheet |

7. Simpan proyek.
8. Pilih fungsi `setupDatabase` pada editor Apps Script, lalu klik **Run** dan berikan izin yang diminta.

Fungsi tersebut membuat sheet berikut jika belum tersedia:

- `Queues`
- `Poli`
- `Staff`
- `ServiceHistory`
- `Settings`

Sheet `Poli` akan diisi data awal hanya jika masih kosong. Fungsi setup tidak menghapus data yang sudah ada. Jika header sheet yang sudah ada tidak cocok, fungsi akan berhenti agar data lama tidak tertimpa.

### Skema data antrean

Sheet `Queues` menggunakan kolom:

`queue_id`, `queue_number`, `poli_id`, `patient_code`, `status`, `created_at`, `called_at`, `completed_at`, `updated_at`.

Status antrean yang digunakan:

- `WAITING` — menunggu.
- `CALLED` / `SERVING` — dipanggil atau sedang dilayani.
- `SKIPPED` — dilewati.
- `COMPLETED` — selesai.

**Penting:** Pada versi ini belum ada form/API pendaftaran antrean pasien. Data antrean harus dimasukkan melalui proses pendaftaran terpisah atau integrasi yang mengisi sheet `Queues` dengan skema di atas. Jangan memasukkan nama lengkap, diagnosis, resep, atau rekam medis ke dashboard ini.

## 4. Membuat akun administrator dan petugas

Setelah `setupDatabase` berhasil:

1. Di editor Apps Script, pilih fungsi `createInitialAdmin`.
2. Isi argumen pemanggilan dengan username, password kuat minimal 12 karakter, dan nama administrator.
3. Jalankan fungsi satu kali. Contoh format pemanggilan manual:

   ```javascript
   createInitialAdmin('adminundata', 'GantiDenganPasswordKuat123!', 'Administrator Undata');
   ```

4. Untuk membuat akun petugas tambahan, jalankan:

   ```javascript
   createStaffAccount('petugas01', 'GantiDenganPasswordKuat123!', 'Petugas Poli Umum', 'STAFF');
   ```

5. Untuk administrator tambahan, argumen terakhir dapat diisi `'ADMIN'`.

Jangan menggunakan contoh password di atas untuk sistem yang sebenarnya. Gunakan password unik dan simpan di password manager. Jangan menaruh password akun di repository atau membagikannya melalui chat.

## 5. Deploy Google Apps Script sebagai Web App

1. Pada Apps Script, pilih **Deploy → New deployment**.
2. Pilih tipe **Web app**.
3. Atur **Execute as: Me**.
4. Atur akses sesuai kebijakan organisasi dan kebutuhan integrasi. Proxy membutuhkan akses untuk mengirim request ke Web App; endpoint login tetap melakukan autentikasi aplikasi. Jangan menganggap URL Web App sebagai mekanisme autentikasi.
5. Klik **Deploy**, selesaikan otorisasi, lalu salin URL Web App yang berakhiran `/exec`.
6. Simpan URL tersebut untuk konfigurasi Vercel.

Uji endpoint health dengan membuka URL Web App di browser dan menambahkan parameter `?action=health`. Respons yang diharapkan memiliki `success: true`.

Jika kode Apps Script diubah setelah deployment, buat versi deployment baru atau perbarui deployment yang sudah ada agar URL Web App menjalankan versi terbaru.

## 6. Konfigurasi dan deploy Vercel

### Persyaratan

- Akun Git yang terhubung ke Vercel.
- Repository berisi seluruh struktur proyek.
- Node.js 18 atau lebih baru untuk runtime function Vercel.
- URL Web App Google Apps Script.

### Langkah deployment

1. Push folder proyek ke repository Git.
2. Impor repository tersebut ke Vercel.
3. Atur **Root Directory** ke root repository `rumah-sakit-undata`, bukan `frontend`.
4. Pastikan file konfigurasi Vercel berada di root deployment. Untuk mengikuti struktur sembilan file yang disepakati, salin konfigurasi:

   ```bash
   cp frontend/vercel.json vercel.json
   ```

   Di Windows PowerShell:

   ```powershell
   Copy-Item frontend/vercel.json vercel.json
   ```

   File root `vercel.json` ini merupakan salinan deployment dari file konfigurasi yang disediakan di `frontend/vercel.json`.

5. Tambahkan Environment Variable di Vercel:

   | Name | Value |
   |---|---|
   | `GAS_WEB_APP_URL` | URL Web App Apps Script berakhiran `/exec` |

6. Pilih environment yang diperlukan, minimal Production. Tambahkan Preview jika ingin menguji deployment preview.
7. Tidak diperlukan build command untuk frontend statis ini.
8. Deploy.
9. Setelah deployment selesai, buka domain Vercel dan periksa halaman, CSS, JavaScript, serta endpoint `/api/proxy`.

Jangan menambahkan `GAS_WEB_APP_URL` sebagai variabel `NEXT_PUBLIC_*` atau menaruhnya di `main.js`, karena URL backend sebaiknya hanya berada pada konfigurasi server.

## 7. Kontrak API frontend dan backend

Frontend menggunakan `POST /api/proxy` dengan format:

```json
{
  "action": "getDashboard",
  "payload": {},
  "token": "SESSION_TOKEN"
}
```

`token` tidak diperlukan untuk `login` dan `getPublicQueue`. Action yang didukung proxy dan backend:

| Action | Keterangan |
|---|---|
| `login` | Autentikasi admin/petugas |
| `logout` | Mengakhiri sesi |
| `validateSession` | Memvalidasi sesi |
| `getDashboard` | Statistik dan ringkasan antrean |
| `getQueues` | Daftar antrean hari ini |
| `getPoli` | Daftar poli |
| `getPublicQueue` | Informasi antrean untuk layar publik |
| `searchQueue` | Pencarian nomor/kode antrean |
| `callNext` | Memanggil antrean berikutnya |
| `callQueue` | Memanggil antrean tertentu |
| `skipQueue` | Melewati antrean |
| `completeQueue` | Menyelesaikan pelayanan |
| `getServiceHistory` | Riwayat pelayanan |
| `createPoli` | Menambahkan poli (admin) |
| `updatePoliDurations` | Mengubah durasi rata-rata poli (admin) |

Bentuk respons standar:

```json
{
  "success": true,
  "message": "Request berhasil.",
  "data": {}
}
```

Jika gagal, respons berisi `success: false`, `code`, `message`, dan `data: null`.

## 8. Peran pengguna

- **Admin:** mengakses dashboard, pengelolaan antrean, poli, riwayat, dan pengaturan durasi.
- **Petugas:** mengakses monitoring serta tindakan antrean sesuai fungsi yang tersedia.
- **Publik:** melihat nomor yang sedang dilayani, antrean berikutnya, dan informasi poli tanpa login.

Versi ini membatasi data publik pada nomor antrean dan informasi poli. Data identitas yang disimpan pada `patient_code` hanya ditujukan untuk kebutuhan internal petugas.

## 9. Estimasi waktu dan pembaruan

Estimasi tunggu merupakan perkiraan sederhana berdasarkan jumlah antrean di depan dan rata-rata durasi pelayanan poli. Perhitungan belum memperhitungkan waktu tersisa aktual, prioritas klinis, jeda dokter, perubahan jumlah dokter, atau kondisi operasional lainnya.

Frontend melakukan polling berkala (sekitar 5 detik untuk data dashboard). Perubahan yang terlihat mengikuti interval polling dan waktu respons backend.

## 10. Keamanan dan batas penggunaan

- Jangan menyimpan rekam medis, diagnosis, resep, NIK, atau data sensitif lain dalam aplikasi antrean ini.
- Gunakan kode antrean yang tidak mengungkap identitas pasien.
- Batasi akses Spreadsheet dan Apps Script hanya kepada pengelola yang berwenang.
- Gunakan password unik dan kuat untuk setiap akun.
- Jangan commit file `.env`, token sesi, password, atau kredensial.
- Periksa kebijakan akses Web App Apps Script dan konfigurasi organisasi sebelum dipakai.
- Spreadsheet dan Apps Script bukan pengganti sistem antrean rumah sakit dengan kontrol akses, audit, ketersediaan, dan perlindungan data tingkat produksi.
- Lakukan pengujian keamanan, beban, pemulihan data, dan kepatuhan perlindungan data sebelum digunakan untuk operasional nyata.

## 11. Checklist pengujian setelah deploy

- [ ] Halaman utama dapat dibuka.
- [ ] File CSS dan JavaScript berhasil dimuat.
- [ ] Endpoint `/api/proxy` menerima POST.
- [ ] `GAS_WEB_APP_URL` sudah terpasang di Vercel.
- [ ] Endpoint health Apps Script mengembalikan respons sukses.
- [ ] Sheet database sudah terbentuk.
- [ ] Admin dapat login.
- [ ] Petugas dapat login.
- [ ] Dashboard menampilkan statistik antrean.
- [ ] Pemanggilan, melewati, dan penyelesaian antrean berjalan.
- [ ] Layar publik menampilkan antrean tanpa data identitas pasien.
- [ ] Riwayat pelayanan tersimpan.

---

**Status proyek:** Sembilan file utama sesuai struktur telah disiapkan dalam tiga tahap. Tahap ini menyediakan konfigurasi dan dokumentasi; deployment, integrasi akun, dan uji operasional tetap perlu dilakukan pada akun Vercel, Google Apps Script, dan Spreadsheet milik pengelola.
