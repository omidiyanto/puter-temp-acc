# Puter Temp Account Creator

Skrip otomatis untuk membuat **akun temporary (guest)** di [puter.com](https://puter.com) memakai **patchright** (undetected Playwright). Browser asli dibuka, Cloudflare Turnstile di-bypass (managed atau interactive dengan auto-click checkbox), lalu request `POST /signup` di-intercept untuk ambil JWT token + kredensial.

## Kenapa Patchright?

Playwright biasa akan ketahuan Cloudflare Turnstile — widget muncul sebagai "Verify you are human" dan tidak bisa lewat. [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) adalah drop-in replacement yang mem-patch CDP `Runtime.enable`/`Console.enable` leaks, command flags, dll — sehingga Turnstile tetap di mode invisible dan ngasih token tanpa challenge.

## Hasil yang Diambil

Per akun (disimpan ke `accounts.json`):

- `cf-turnstile-response` token (dari request body ke `/signup`)
- Body + headers request `/signup` lengkap
- Response `/signup` — JWT `token`, `user.username`, `user.uuid`, dll
- Semua cookies context

## Setup

Butuh **Node.js 18+**.

```powershell
npm install
```

`postinstall` otomatis menjalankan `patchright install chromium`. Kalau gagal:

```powershell
npx patchright install chromium
```

**Sangat disarankan** pakai Google Chrome asli (bukan Chromium bundled), karena patchright bilang itu paling undetectable:

```powershell
npx patchright install chrome
```

Lalu jalankan dengan `--channel=chrome`.

## Pakai

### Mode Visible (default)

Browser window terlihat — useful buat debug / lihat apa yang terjadi.

```powershell
# 1 akun, Chromium bundled
npm run create

# 1 akun pakai real Chrome (paling reliable)
npm run create:chrome
# atau: node create_temp_account.js --channel=chrome
```

### Mode Hidden (window tidak terlihat)

Browser jalan penuh tapi user tidak melihatnya. Cara kerja otomatis menyesuaikan OS:

- **Windows / macOS / Linux desktop**: window di-spawn lalu diposisikan jauh off-screen (`--window-position=-32000,-32000`). Renderer, GPU, fingerprint tetap normal.
- **Linux server tanpa X (headless box)**: script otomatis spawn **Xvfb** (virtual framebuffer X server), browser dipasang ke situ. Cloudflare tidak bisa membedakan dari user biasa.

```powershell
npm run create:hidden
npm run create:hidden:chrome                     # pakai Chrome asli
node create_temp_account_hidden.js --count=3     # 3 akun hidden
node create_temp_account_hidden.js --show        # debug: tampilkan window
```

**Paling direkomendasikan untuk production/automation.**

#### Linux headless server (Ubuntu / Debian / RHEL)

Install Xvfb sekali (script akan auto-spawn):

```bash
# Debian / Ubuntu
sudo apt-get install -y xvfb

# Fedora / RHEL / Rocky
sudo dnf install -y xorg-x11-server-Xvfb

# Arch
sudo pacman -S xorg-server-xvfb
```

Lalu jalankan seperti biasa:

```bash
node create_temp_account_hidden.js
```

Script otomatis mendeteksi tidak ada `$DISPLAY`, spawn Xvfb di display random (`:99`–`:998`), dan cleanup waktu exit. **Tidak perlu** `xvfb-run` manual.

Kalau tidak mau pakai auto-spawn, bisa tetap manual:

```bash
xvfb-run -a --server-args="-screen 0 1280x800x24" \
  node create_temp_account_hidden.js
```

> ⚠️ **True headless (`--true-headless` flag)**: Cloudflare Turnstile hampir pasti deteksi headless dan menolak token. Jangan pakai kecuali mau eksperimen.

### Opsi

| Flag                   | Default          | Keterangan                                                 |
| ---------------------- | ---------------- | ---------------------------------------------------------- |
| `--channel=chrome`     | `(bundled)`      | Pakai real Google Chrome. Bisa juga `msedge`.              |
| `--headless`           | off              | Headless. TIDAK disarankan, Turnstile akan nangkep.        |
| `--count=N`            | `1`              | Bikin N akun berturut-turut.                               |
| `--output=file.json`   | `accounts.json`  | File hasil. Di-append kalau sudah ada.                     |
| `--timeout=ms`         | `90000`          | Batas tunggu `/signup` per akun.                           |
| `--delay=ms`           | `3000`           | Jeda antar akun (bulk mode).                               |
| `--keep-profile`       | off              | Jangan hapus user-data-dir setelah run (debugging).        |

### Contoh

```powershell
# 5 akun pakai Chrome asli, simpan ke batch1.json
node create_temp_account.js --channel=chrome --count=5 --output=batch1.json

# Single run, timeout panjang, simpan profile buat inspeksi
node create_temp_account.js --channel=chrome --timeout=180000 --keep-profile
```

## Output

Contoh `accounts.json`:

```json
[
  {
    "timestamp": "2026-05-05T07:00:00.000Z",
    "cf_turnstile_response": "0.-NWgtRypGd...",
    "signup_request_body": {
      "referrer": "/dashboard",
      "is_temp": true,
      "cf-turnstile-response": "0.-NWgtRypGd..."
    },
    "signup_response": {
      "proceed": true,
      "next_step": "complete",
      "token": "eyJhbGciOiJIUzI1NiJ9...",
      "user": {
        "username": "polite_idea_2726",
        "uuid": "dc5c37bc-8dc3-4cd0-b5cd-62589f8320b3",
        "is_temp": true,
        ...
      }
    },
    "cookies": [...]
  }
]
```

## Catatan

- Token `cf-turnstile-response` itu **sekali pakai** dan **terikat sesi browser saat itu**. Tidak bisa dipakai ulang dari akun lain.
- Kalau headless gagal terus, pakai `headless: false` (default). Cloudflare Turnstile cenderung lebih ketat di lingkungan headless.
- Setelah dapat JWT `token`, kamu bisa pakai langsung untuk panggil API Puter, contoh:

  ```powershell
  curl https://api.puter.com/whoami -H "Authorization: Bearer <token>"
  ```

- Akun temp di Puter ada quotanya. Jangan dispam.

## Troubleshooting

**`TimeoutError` / "no /signup response captured"**

- Naikkan `--timeout=120000`.
- Hapus flag `--headless` (jalankan headed).
- Periksa koneksi internet (Turnstile butuh akses ke `challenges.cloudflare.com`).

**`captcha verification failed` di response**

- Browser dianggap bot. Coba:
  - Pastikan flag `--disable-blink-features=AutomationControlled` aktif (sudah default di script).
  - Tambah `--slowmo=200` agar interaksi lebih natural.
  - Jalankan tanpa headless.

**Browser tidak ketemu**

```powershell
npx playwright install chromium
```
