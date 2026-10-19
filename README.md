# Solana Token Scanner

Scanner lokal **read-only** untuk menemukan dan memeringkat kandidat token Solana, lalu memeriksa satu mint secara mendalam. **Tidak ada wallet, private key, transaksi, auto-buy, atau klaim profit.** Semua berjalan pada server loopback `127.0.0.1`; pengambilan data memerlukan internet.

Ada tiga tab:

- **Discover** — ambil kandidat dari Jupiter + GeckoTerminal, saring dengan gate keras, beri skor yang bisa direkonstruksi, lalu deep scan shortlist (candle 1 jam + GoPlus) untuk struktur dan rencana entry.
- **Inspect** — tempel satu mint untuk melihat snapshot pasar, tren candle 15 menit, volume relatif, temuan risiko kontrak, dan alasan watch.
- **Watchlist** — token yang Anda simpan beserta snapshot terakhir dan riwayat run discover, tersimpan lokal di SQLite.

Tidak ada label "aman" di mana pun. Setiap angka membawa sumber dan waktunya; nilai yang tidak diketahui ditampilkan sebagai `unknown`, tidak pernah sebagai nol atau "risiko rendah".

## Jalankan

```bash
npm start
```

Buka **http://127.0.0.1:3000**. Hentikan dengan Ctrl+C. Bila port terpakai, gunakan `PORT=3001 npm start` (bash) atau `$env:PORT=3001; npm start` (PowerShell). Server hanya bind ke loopback; tidak dideploy.

Menguji tanpa jaringan:

```bash
npm test
```

Forward-test dari snapshot yang sudah dicatat:

```bash
npm run backtest
```

## Discover: bagaimana skor dibentuk

1. **Universe murah.** Jupiter top organic (1 jam & 24 jam), Jupiter trending (1 jam), dan GeckoTerminal trending pools digabung dan dideduplikasi menurut mint. Hanya satu panggilan Gecko di fase ini karena batas publiknya paling ketat.
2. **Pre-filter di memori.** Kandidat dengan likuiditas Jupiter di bawah ambang preset dibuang sebelum satu pun request tambahan. Maksimal 60 kandidat diteruskan.
3. **DEX Screener batch berchunk.** Satu pool terbaik per mint (likuiditas tertinggi, lalu volume 24 jam). Daftar dipecah menjadi request 30 mint, jadi **semua** kandidat yang lolos pre-filter benar-benar punya data pasar — sebelumnya batch terpotong di 30 sehingga separuh kandidat "diperiksa" ditolak tanpa alasan nyata. Ringkasan run menampilkan `Dievaluasi` (jumlah kandidat yang benar-benar punya pool) di samping `checked`.
4. **Verifikasi keamanan sebelum gate (preset ketat).** Bila preset mewajibkan keamanan (`allowUnknownSafety: false`, mis. Conservative), GoPlus dipanggil untuk **10 kandidat teratas yang lolos gate lain**, lalu gate final dijalankan memakai hasil verifikasi. Tanpa langkah ini, keamanan selalu `unknown` saat ranking dan preset ketat mustahil mengembalikan hasil. Bila GoPlus tidak tersedia, kandidat ditolak `safety_unknown`, bukan dianggap aman.
5. **Gate keras (fail-closed).** Kandidat yang gagal langsung digugurkan dengan kode gate dan nilainya, tidak dihapus diam-diam:
   - aset dasar (SOL/USDC/USDT) dan tag `stable`/`wrapped`/`lst`/`major`,
   - likuiditas, volume 24 jam, market cap, dan usia pool di bawah ambang preset,
   - turnover terlalu rendah (volume tipis) atau terlalu tinggi (curiga wash),
   - FDV/market cap terlalu jauh (suplai belum beredar),
   - perubahan harga 24 jam di luar rentang preset (menolak penurunan tajam maupun lonjakan yang berisiko dikejar),
   - jumlah holder terlalu sedikit atau konsentrasi top 10 terlalu tinggi,
   - mintable/freezable/transfer fee/transfer hook/non-transferable — hanya nilai eksplisit `true` yang menolak,
   - organic label di bawah ambang, atau token belum terverifikasi bila preset mewajibkannya.
6. **Skor 5 komponen berbobot.** Skor total = rata-rata berbobot komponen yang **benar-benar terukur**, dikurangi penalti. Komponen yang belum dianalisis **dikeluarkan** dari rata-rata, bukan diberi nilai netral:

   | Komponen                      | Bobot | Isi utama                                                                |
   | ----------------------------- | ----- | ------------------------------------------------------------------------ |
   | Keamanan kontrak & distribusi | 25    | mint/freeze authority, transfer fee/hook, konsentrasi top 10, LP         |
   | Likuiditas & eksekusi         | 20    | likuiditas pool, turnover, estimasi slippage untuk notional tetap        |
   | Momentum & akselerasi volume  | 20    | konsistensi perubahan 1j/6j/24j, akselerasi volume, rasio buy, net buyer |
   | Struktur & kualitas entry     | 25    | tren EMA20/EMA50, jarak ke high 20 jam, ATR%, RSI14, HH/HL               |
   | Organic attention             | 10    | organic score Jupiter, porsi volume buy organik                          |

   Skor tiap komponen disimpan sebagai desimal dan hanya total akhir yang dibulatkan, supaya perbedaan antar-preset tidak hilang. **Kurva likuiditas mengikuti preset**: token dianggap "likuid penuh" pada 20× ambang minimum preset (Conservative $5 jt, Balanced $3 jt, Degen $1 jt). Sebelumnya patokan atas dikunci di $5 jt untuk semua preset sehingga skor nyaris tidak berubah antar-preset.

7. **Grade.** A ≥ 75, B ≥ 60, C ≥ 45, sisanya D. **Keamanan yang unknown membatasi grade maksimum ke C.** Nilai `unknown` bukan risiko rendah. Karena hanya preset ketat yang memverifikasi GoPlus lebih awal, token yang sama bisa bergrade lebih tinggi di Conservative (keamanan terverifikasi) daripada di Balanced/Degen (keamanan unknown → grade dibatasi C). Ini mengukur kelengkapan bukti, bukan berkurangnya risiko.
8. **Deep scan shortlist.** Beberapa kandidat teratas diproses lebih lanjut: candle 1 jam dari GeckoTerminal (200 candle) → struktur → rencana entry, plus GoPlus untuk memverifikasi perilaku kontrak. Hasilnya menggantikan skor awal dan menaikkan `confidence` ke 1. Job berjalan asinkron; UI menampilkan progres.
9. **Diskualifikasi setelah deep scan.** Deep scan bisa menemukan pelanggaran gate yang tidak terlihat saat ranking awal (misalnya mint authority masih aktif). Baris seperti itu ditandai **gugur** beserta kode gate-nya, tidak tetap tampil seolah lolos.

`confidence` menunjukkan porsi bobot yang terukur. Skor dari 75% bobot tidak diperlakukan sama dengan skor dari 100% bobot.

### Preset

| Preset             | Likuiditas | Usia pool | Holder  | Top 10 | FDV/MC | Turnover | Perubahan 24j   | Verifikasi                  |
| ------------------ | ---------- | --------- | ------- | ------ | ------ | -------- | --------------- | --------------------------- |
| Conservative       | ≥ $250k    | ≥ 7 hari  | ≥ 2.000 | ≤ 25%  | ≤ 1,5× | ≤ 8×     | -25% s.d. +150% | wajib (GoPlus sebelum gate) |
| Balanced (default) | ≥ $150k    | ≥ 48 jam  | ≥ 1.000 | ≤ 30%  | ≤ 1,5× | ≤ 10×    | -30% s.d. +150% | tidak wajib                 |
| Degen              | ≥ $60k     | ≥ 1 jam   | ≥ 200   | ≤ 60%  | ≤ 4×   | ≤ 40×    | -50% s.d. +500% | tidak wajib                 |

Preset mengubah angka gate **dan** kurva skor likuiditas, jadi token yang sama bisa punya skor dan peringkat berbeda antar-preset. Minimum likuiditas Degen dinaikkan agar kandidat tepat di ambang mempunyai estimasi slippage sekitar 2% atau lebih rendah untuk notional default $500. Gate perubahan 24 jam menolak penurunan tajam; perubahan yang datanya tidak tersedia tetap tidak ditolak oleh gate tersebut. Semua ambang adalah **heuristik yang belum dikalibrasi ulang oleh backtest**; versinya dicatat di setiap run (`configHash`) agar hasil lama tidak tercampur dengan aturan baru. UI menampilkan ambang preset yang sedang aktif di bawah pemilih preset.

## Rencana entry

Deep scan menurunkan rencana dari **candle 1 jam yang sudah tutup**:

- **Zona entry** ditentukan per setup (`trend_pullback` di sekitar EMA20, `breakout_retest`/`range_breakout` di sekitar high 20 jam).
- **Invalidasi** = satu ATR14 di bawah zona entry. Bukan level struktural yang bisa sangat dalam, sehingga risiko tetap terukur.
- **Target** memakai level nyata (high 20 jam) atau proyeksi measured-move yang dibatasi 1–6 ATR. Bukan kelipatan R yang memaksa R:R tetap.
- **R:R** dihitung ke target terdekat. Bila di bawah ambang (default 1.5) atau tren menurun, hasilnya `no_plan` beserta alasannya — tidak dipaksa tampil.
- **Ukuran posisi** adalah ukuran kertas berdasarkan bankroll dan risiko per transaksi di konfigurasi, bukan saran riil.

Rencana adalah skenario, bukan perintah. Invalidasi bukan stop-order otomatis. R:R tinggi tidak berarti peluang tinggi.

## Inspect: tren 15 menit

Sumber candle adalah **GeckoTerminal**, 15 menit, USD, untuk **mint dan alamat pool utama yang sama** dengan snapshot DEX Screener. Pool utama = pool base-token dengan likuiditas USD tertinggi yang dilaporkan DEX Screener. Pool tidak dijumlahkan; harga snapshot tidak dicampur dengan close candle untuk menghitung breakout.

| Kondisi                       | Arti aturan lokal                                                                              | Batas interpretasi                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Breakout terkonfirmasi volume | Close candle terakhir di atas high 20 candle sebelumnya, volume ≥ 1,5× rata-rata 20 sebelumnya | Bukan konfirmasi profit; gugur bila candle berikutnya tutup di bawah level acuan     |
| Breakout belum terkonfirmasi  | Close melewati high sebelumnya tetapi volume < 1,5× atau baseline nol                          | Tidak otomatis menjadi peluang buy                                                   |
| Dekat resistance              | Close 0–2% di bawah high 20 candle sebelumnya                                                  | Belum breakout; level bukan penghalang pasti                                         |
| Terlalu jauh dari SMA20       | Close > 8% di atas SMA20                                                                       | Peringatan jangan mengejar; muncul sebagai **flag**, tidak menghapus status breakout |
| Di bawah support              | Close di bawah low 20 candle sebelumnya                                                        | Observasi kelemahan, bukan perintah sell                                             |
| Dalam rentang                 | Tidak memenuhi kondisi di atas                                                                 | Tidak ada breakout menurut aturan ini                                                |
| unknown                       | Data kurang, tidak valid, bolong, stale, atau tidak tersedia                                   | Tidak dibuat kesimpulan                                                              |

`setup` (pola yang terlihat) dan `flags` (peringatan) sekarang terpisah: kenaikan > 8% di atas SMA20 menandai `extended_sma20` tanpa menyembunyikan bahwa breakout sudah terjadi.

Minimum **21 candle tertutup berurutan**; candle berjalan dikeluarkan. Celah interval **diisi** oleh GeckoTerminal sendiri lewat `include_empty_intervals=true` (candle volume nol dari provider, bukan buatan kita); tanpa itu, pool bervolume rendah akan selalu unknown karena celah. Baris OHLCV yang rusak **dibuang** dan dihitung di `droppedRows`, bukan membatalkan seluruh dataset. Skema salah, harga tidak positif, OHLC mustahil, volume negatif, timestamp duplikat/tidak selaras/masa depan, atau usia penutupan > 30 menit membuat hasil unknown.

## Freshness, rate limit, dan cache

- Cache scan 30 detik; cache **single-flight + LRU + TTL** per origin.
- Batas lokal: Jupiter 30/menit, DEX Screener 30/menit, GeckoTerminal **8/menit** (provider ~10/menit), GoPlus 20/menit dengan jarak antar-panggilan.
- Deep scan memakai sampai 4 candle Gecko + 1 trending; karena batas 8/menit, **dua discover dalam satu menit bisa menghabiskan kuota candle**, dan struktur yang gagal diberi label `unknown` (bukan dikarang). Tunggu satu menit sebelum menjalankan discover berikutnya.
- HTTP 429 menghormati header `Retry-After` dan memberi cooldown per origin; slot yang gagal dikembalikan.
- Timeout 10 detik per provider; batas UI 30 detik untuk inspect dan 90 detik untuk discover.
- **Tidak ada polling otomatis.** Tampilan menghitung umur lokal setiap 15 detik tanpa meminta jaringan.

## Keamanan kontrak: GoPlus + Jupiter, bukan RugCheck

`risk.mjs` memakai **GoPlus** (`/api/v1/solana/token_security`) untuk mint/freeze authority, transfer fee/hook, non-transferable, metadata mutable, jumlah holder, konsentrasi top 10, dan holder LP, ditambah **audit bawaan Jupiter** (`mintAuthorityDisabled`, `freezeAuthorityDisabled`, `topHoldersPercentage`) sebagai pembanding.

RugCheck tidak dipakai: hostname `api.rugcheck.xyz` **tidak resolve** dari jaringan pengembangan (NXDOMAIN, diverifikasi lewat resolver sistem dan DoH), sehingga endpoint dan skemanya tidak dapat diverifikasi. Endpoint dan persyaratan akses tidak ditebak.

Skala persen dari kedua sumber berbeda dan **tidak dicampur**: GoPlus mengembalikan `percent` sebagai fraksi 0–1 (dikonversi ke persen), Jupiter memakai poin persentase. Bila sumber tidak tersedia, semua status keamanan `unknown` — **bukan risiko rendah**. Likuiditas tidak membuktikan LP terkunci.

## Snapshots, watchlist, dan SQLite

Persistensi memakai **`node:sqlite`** bawaan Node (tanpa dependensi npm). Bila runtime tidak menyediakannya, scanner berjalan **stateless** dan melaporkan alasannya di `/api/config` dan `/api/health`, bukan crash.

Tabel: `tokens`, `snapshots`, `discover_runs`, `watchlist`, `plans`. Setiap run discover menyimpan snapshot harga/likuiditas/skor per kandidat, sehingga `npm run backtest` dapat menghitung return forward per grade dan horizon dari data yang Anda rekam sendiri. Database ada di `data/scanner.db` dan tidak pernah dibagikan.

## API

Semua endpoint hanya loopback. Selain `POST`/`DELETE /api/watchlist`, hanya `GET` yang diterima (selain itu `405`).

```text
GET    /api/config
GET    /api/health
GET    /api/discover?preset=balanced|conservative|degen&limit=1..20
GET    /api/jobs/{jobId}
GET    /api/scan?mint={mint}
GET    /api/history?mint={mint}
GET    /api/watchlist
POST   /api/watchlist           { "mint": "...", "note": "..." }
DELETE /api/watchlist/{mint}
```

## Privasi

Mint yang dipindai dikirim ke DEX Screener, GeckoTerminal, GoPlus, dan Jupiter. Backend hanya memakai origin API resmi dan tidak mengikuti redirect. Tidak ada wallet, private key, transaksi, database akun, cookies, login, localStorage, atau kredensial. Respons pihak ketiga ditampilkan sebagai teks, bukan HTML. Format base58 32-byte tidak membuktikan alamat adalah akun mint on-chain.

## File proyek

- `config.mjs`: preset, bobot skor, ambang gate, batas laju, config hash.
- `server.mjs`: server loopback, routing, validasi, job deep scan.
- `discover.mjs`: orkestrasi universe → pre-filter → batch → gate → skor → deep scan.
- `sources/`: adapter `jupiter`, `dexscreener`, `gecko`, `goplus` (normalisasi + provenance).
- `screen/`: `gates`, `score`, `rank` — fungsi murni tanpa I/O.
- `analysis/`: `candles` (EMA/ATR/RSI/struktur) dan `entryplan`.
- `lib/`: `http`, `cache`, `limiter`, `provenance`.
- `db.mjs`, `jobs.mjs`, `backtest.mjs`: SQLite, antrean job, forward-test.
- `signals.mjs`, `history.mjs`, `risk.mjs`: jalur Inspect (15 menit, GeckoTerminal, GoPlus).
- `public/`: antarmuka tanpa dependensi eksternal.
- `test/`: regresi murni dan integrasi HTTP; fixture sintetis hanya untuk tes.

## Batas yang harus dibaca bersama hasil

- Ambang dan bobot belum dikalibrasi ulang oleh backtest. `configHash` mencatat versinya.
- Snapshot pihak ketiga bisa terlambat, keliru, atau tidak lengkap; bukan feed real-time.
- Cakupan Jupiter/GeckoTerminal/DEX Screener untuk token baru tidak dijamin.
- Backtest adalah forward-test dari snapshot yang Anda rekam sendiri, bukan backtest historis penuh: jarak snapshot tidak seragam dan ada bias seleksi.
- Tidak ada hasil yang menjamin token aman, dan tidak ada rekomendasi beli/jual.
