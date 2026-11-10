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

Laporan menjawab tiga hal yang tidak bisa dijawab versi lama: **(1)** apakah kandidat pernah mencapai 2x/5x/10x — kolom `peak` memakai harga tertinggi yang tercatat di dalam jendela, bukan hanya return di titik horizon; **(2)** apakah token **hampir lolos** (digugurkan gate) justru yang multi-bag — baris dipisah per cohort `accepted` vs `near-miss`; **(3)** gate mana yang paling sering membuang multi-bagger — tabel **atribusi gate** mengurutkan kode gate berdasarkan persentase near-miss yang mencapai kelipatan. Default horizon kini `1, 6, 24, 72, 168, 720` jam (7 hari dan 30 hari) karena multi-bagger baru terlihat di horizon panjang.

Diagnosa koneksi ke penyedia data (berguna saat Discover kosong karena jaringan):

```bash
npm run diagnose
```

Perintah ini hanya membaca: ia mengecek tiap penyedia, membedakan "reset koneksi" (blokir IP/SNI, jaringan, proxy, atau VPN) dari "HTTP 429" (kuota laju habis), dan membandingkan jawaban DNS sistem dengan IP asli dari DoH. Kalau berbeda, DNS sistem diteruskan ke proxy atau lapisan SSL-inspection/VPN yang mengembalikan alamat sendiri — penyebab paling umum tabel kosong. Tidak mengubah file atau database.

## Deploy ke Vercel (personal)

Scanner ini dirancang local-first; deployment ke Vercel hanya karena kebutuhan akses pribadi dari mana pun. Arsitekturnya berubah sedikit, bukan dirombak: **satu** fungsi serverless memakai handler yang sama persis dengan `npm start` (`server.mjs` → `lib/handler.mjs`). Yang berubah di produksi:

- **Penyimpanan jadi Turso (libSQL).** Buat akun gratis di [turso.dev](https://turso.dev), buat database, lalu set `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` di Vercel → Environment Variables. Skema diterapkan dengan `npm run migrate` (idempoten; aman dijalankan berkali-kali). SQL yang dipakai sama untuk lokal dan Turso; lokal tetap `node:sqlite` tanpa konfigurasi apa pun.
- **Deep scan diproses satu token per poll.** Fungsi serverless (batas 60 detik, lihat `vercel.json`) tidak bisa menjalankan satu run 15 token penuh seperti lokal, jadi antrean deep scan tersimpan di tabel `jobs`/`job_meta`; setiap poll `/api/jobs/:id` memproses satu token secara penuh (claim atomik, tidak mungkin diproses dua kali) dan hasilnya persisten. UI berjalan seperti biasa — yang berubah hanya tempo deep scan. **Penting: di Vercel, deep scan hanya maju selama ada yang memanggil `/api/jobs/:id`.** Tab browser yang terbuka sudah cukup (UI memanggil setiap 2 detik sampai selesai). Jika tab ditutup di tengah run, sisa antrean berhenti sampai run berikutnya atau sampai pemanggil lain (mis. cron eksternal seperti cron-job.org, setiap menit, dengan header `Authorization: Basic <base64("scanner:"+APP_PASSWORD)>`) meneruskan poll. Item yang macet di status `processing` (fungsi berakhir di tengah deep scan) ditandai `failed` setelah 75 detik pada poll berikutnya, sehingga tidak menggantung selamanya.
- **Basic auth di depan semua rute.** Set `APP_PASSWORD` (jangan pakai password layanan lain; HTTPS wajib dan Vercel selalu HTTPS). Browser menampilkan satu prompt login. Tanpa `APP_PASSWORD`, semua rute ditutup total (503) — fail closed, bukan terbuka.
- **Host check tetap ada, plus `APP_ORIGIN`.** Set `APP_ORIGIN=https://<nama-app>.vercel.app` di environment agar pemeriksaan Host mengizinkan domain tersebut (loopback tetap diizinkan untuk lokal).
- **Hobby plan = penggunaan non-komersial/personal**, sesuai batasan rencana personal Anda.
- **Data lokal tidak ikut.** `data/scanner.db` tidak pernah di-deploy; watchlist dan histori di Vercel mulai kosong kecuali Anda memigrasikan manual.

Langkah: `npm i -g vercel` → `vercel` → set tiga env var (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_PASSWORD`) + `APP_ORIGIN` → `npm run migrate` → `vercel --prod`. Deployment lama yang 500 dihapus atau di-overwrite oleh deployment ini.

## Discover: bagaimana skor dibentuk

1. **Universe yang berputar, bukan daftar yang sama.** Enam sumber digabung: Jupiter top organic (1 jam & 24 jam), Jupiter trending (1 jam), **Jupiter token terbaru**, **GeckoTerminal trending pools**, dan **GeckoTerminal pool baru** (hanya untuk preset yang menerima likuiditas tipis). Kandidat dari tiap sumber **diselingi**, bukan digabung berurutan: kalau digabung berurutan, daftar pertama memakai seluruh kuota dan sumber lain tidak pernah dievaluasi. Ringkasan run menampilkan kontribusi per sumber.
   - **Jupiter token terbaru** dan **GeckoTerminal pool baru** tidak beririsan sama sekali dengan daftar ranking (0% overlap pada pengukuran) — inilah sumber yang benar-benar memberi token baru.
   - **Rotasi:** daftar ranking Jupiter bergerak lambat (63% overlap antara daftar 1 jam dan 24 jam), jadi refresh berturut-turut menghasilkan token yang sama. Lima posisi teratas tiap daftar tetap dipakai supaya kandidat terbaik tidak hilang, sisanya **bergeser setiap jendela 10 menit**. Pergeseran deterministik: jendela yang sama selalu menghasilkan potongan yang sama.
2. **Pre-filter di memori.** Kandidat dengan likuiditas Jupiter di bawah ambang preset dibuang sebelum satu pun request tambahan. Maksimal 60 kandidat diteruskan.
3. **DEX Screener batch berchunk, dengan penjaga orientasi token.** Satu request per 30 mint. DEX Screener mengembalikan **satu** pool per token, dan pool itu belum tentu yang paling likuid; karena itu **harga, market cap, FDV, dan perubahan harga hanya dipakai bila mint adalah token BASE** pool tersebut. Kalau mint hanya muncul sebagai quote token, angka milik token base menjadi `unknown`, bukan ikut ter-atribusikan ke mint yang dicari. Pool dengan mint sebagai base selalu dipilih lebih dulu; likuiditas dan volume 24 jam jadi penentu berikutnya. Ringkasan run menampilkan `Dievaluasi` (jumlah kandidat yang benar-benar punya pool) di samping `checked`.
4. **Verifikasi keamanan dan jumlah holder sebelum gate.** GoPlus dipanggil untuk (a) **10 kandidat teratas berdasarkan skor awal** yang lolos gate lain bila preset mewajibkan keamanan (`allowUnknownSafety: false`, mis. Conservative) — tanpa langkah ini keamanan selalu `unknown` saat ranking sehingga preset ketat mustahil mengembalikan hasil — dan (b) **10 kandidat tanpa jumlah holder Jupiter** (mis. kandidat dari GeckoTerminal), karena tanpa jumlah holder gate akan menolaknya sebagai `unknown` dan sumber paling segar jadi tidak pernah muncul. Bila GoPlus tidak tersedia, kandidat ditolak `safety_unknown`, bukan dianggap aman. Bila tidak ada kandidat yang lolos gate awal, run tetap melaporkan alasannya lewat warning, bukan diam-diam mengembalikan nol hasil.
5. **Gate keras (fail-closed).** Kandidat yang gagal langsung digugurkan dengan kode gate dan nilainya, tidak dihapus diam-diam:
   - aset dasar (SOL/USDC/USDT) dan tag `stable`/`wrapped`/`lst`/`major`,
   - likuiditas, volume 24 jam, market cap, dan usia pool di bawah ambang preset,
   - turnover terlalu rendah (volume tipis) atau terlalu tinggi (curiga wash),
   - FDV/market cap terlalu jauh (suplai belum beredar),
   - perubahan harga 24 jam di luar rentang preset (menolak penurunan tajam maupun lonjakan yang berisiko dikejar),
   - jumlah holder terlalu sedikit atau konsentrasi top 10 terlalu tinggi,
   - mintable/freezable/transfer fee/transfer hook/non-transferable — hanya nilai eksplisit `true` yang menolak,
   - organic label di bawah ambang, atau token belum terverifikasi bila preset mewajibkannya.
   - **Market cap yang tidak dilaporkan** menghasilkan peringatan `mcap_unknown` pada preset longgar; pada preset yang mewajibkan valuasi terukur, nilai unknown menggugurkan kandidat dan tidak dianggap cukup.
   - **FDV yang tidak dilaporkan** (market cap ada, FDV tidak) menghasilkan peringatan `fdv_unknown`: gate FDV/market cap tidak dievaluasi.
   - **Perubahan harga 24 jam yang tidak dilaporkan** menghasilkan peringatan `price_change_unknown`: gate perubahan harga tidak dievaluasi.
   - **Label organic yang tidak dikenal** (bukan low/medium/high) tidak menggugurkan kandidat dengan alasan keliru; menghasilkan peringatan `organic_label_unknown` dan gate organic tidak dievaluasi.
6. **Skor 6 komponen berbobot.** Skor total = rata-rata berbobot komponen yang **benar-benar terukur**, dikurangi penalti. Komponen yang belum dianalisis **dikeluarkan** dari rata-rata, bukan diberi nilai netral:

   | Komponen                      | Bobot fallback | Isi utama                                                                |
   | ----------------------------- | ----- | ------------------------------------------------------------------------ |
   | Keamanan kontrak & distribusi | 22 | mint/freeze authority, transfer fee/hook, konsentrasi top 10, LP         |
   | Likuiditas & eksekusi         | 15 | likuiditas pool, turnover, estimasi slippage untuk notional tetap        |
   | Momentum & akselerasi volume  | 14 | konsistensi perubahan 1j/6j/24j, akselerasi volume, rasio buy, net buyer |
   | Struktur & kualitas entry     | 15 | tren EMA20/EMA50, jarak ke high 20 jam, ATR%, RSI14, HH/HL               |
   | Organic attention             | 9 | organic score Jupiter, porsi volume buy organik                          |
   | Ruang naik / undervalued      | 25 | market cap (skala log), likuiditas kecil, volume yang belum tercermin di harga, jarak ke high 20 jam |

   Bobot di atas adalah fallback global. Masing-masing preset memakai bobotnya sendiri agar makna skor sesuai profil risiko: Conservative memprioritaskan keamanan (34) dan hanya upside 3; Balanced tetap 22/15/14/15/9/25; Degen memberi upside 30; Gem hunter memberi upside 35 dan momentum 22. Akibatnya skor yang sama pada preset berbeda tidak setara dan UI harus menampilkan bobot preset aktif.

   **Ruang naik adalah dimensi baru dan sengaja berbobot besar pada preset non-Konservatif.** Lima komponen lain menjawab "seberapa sehat token ini"; tanpa komponen ini, token mapan yang sudah likuid selalu menang dan kandidat berpotensi kecil tidak pernah muncul di atas. Market cap dinilai pada skala log, dengan batas atas per preset; likuiditas besar menurunkan skor, turnover tinggi **tanpa** lonjakan harga menandakan akumulasi, dan jarak ke high 20 jam menandai apakah harga sudah extended. Preset Gem hunter juga mempunyai batas atas market cap $5 jt supaya token besar tidak memenuhi daftar hanya karena lolos ambang bawah.

   Skor tiap komponen disimpan sebagai desimal dan hanya total akhir yang dibulatkan, supaya perbedaan antar-preset tidak hilang. **Kurva likuiditas mengikuti preset**: token dianggap "likuid penuh" pada 20× ambang minimum preset (Conservative $5 jt, Balanced $3 jt, Degen $1 jt). Sebelumnya patokan atas dikunci di $5 jt untuk semua preset sehingga skor nyaris tidak berubah antar-preset.

   **Satu sumber per metrik.** Konsentrasi top 10 hanya boleh dibaca dari satu sumber dalam satu proses gate; kalau sumbernya berpindah di tengah proses, kandidat bisa gugur karena pergantian sumber, bukan karena temuan baru. Gate memakai **audit Jupiter** (tersedia untuk semua kandidat Discover). Pembaca kedua **GoPlus** menghitung wallet exchange/program sebagai holder sehingga definisinya berbeda; angka itu **ditampilkan** sebagai nilai tersendiri dan sebagai peringatan `concentration_goplus_high` bila melewati ambang — bukan dipakai sebagai sumber gate. Karena itu gate tidak lagi berganti status antara ranking awal dan gate ulang setelah deep scan. Semua angka lain juga mencantumkan sumber aslinya: perubahan harga yang diambil dari statistik Jupiter tidak lagi diberi label "DEX Screener", dan likuiditas dari pool GeckoTerminal tidak lagi diberi label "DEX Screener".
7. **Grade.** A ≥ 75, B ≥ 60, C ≥ 45, sisanya D. **Keamanan yang unknown membatasi grade maksimum ke C.** Nilai `unknown` bukan risiko rendah. Karena hanya preset ketat yang memverifikasi GoPlus lebih awal, token yang sama bisa bergrade lebih tinggi di Conservative (keamanan terverifikasi) daripada di Balanced/Degen (keamanan unknown → grade dibatasi C). Ini mengukur kelengkapan bukti, bukan berkurangnya risiko.
8. **Deep scan untuk semua baris, di latar.** Setiap kandidat yang lolos gate diproses lebih lanjut: **pool utama dicek ulang** satu kali per token (satu request `token-pairs/v1`, yang mengembalikan seluruh pool), lalu candle 1 jam dari GeckoTerminal (200 candle) → struktur → rencana entry, plus GoPlus untuk memverifikasi perilaku kontrak. Candle, data pasar, dan gate memakai **pool yang sama**, sehingga tidak ada lagi selisih harga antara tab Discover dan Inspect untuk mint yang sama. Job berjalan asinkron dengan tempo (±13 detik per token, dibatasi laju GeckoTerminal), jadi respons discover tidak menunggu: baris yang belum selesai bertanda **antri**, baris yang gagal bertanda **tidak dianalisis** beserta alasannya, dan baris yang digugurkan deep scan bertanda **gugur** dengan kode gate-nya.
9. **Diskualifikasi setelah deep scan.** Deep scan bisa menemukan pelanggaran gate yang tidak terlihat saat ranking awal (misalnya mint authority masih aktif). Baris seperti itu ditandai **gugur** beserta kode gate-nya, tidak tetap tampil seolah lolos.

`confidence` menunjukkan porsi bobot yang terukur. Skor dari 75% bobot tidak diperlakukan sama dengan skor dari 100% bobot.

UI menvisualkan itu sebagai **rentang**, bukan catatan kecil: gauge skor menggambar bagian pekat sebesar `skor × bobot terukur` (nilai yang pasti bisa dipertanggungjawabkan) dan pita bergaris sampai `skor × bobot terukur + (100 − bobot terukur) × 100` (rentang yang masih mungkin bila komponen yang belum dianalisis bernilai 0 sampai 100). Garis tegak menandai perkiraan titik skornya, dan tick di 45/60/75 menunjukkan ambang grade A/B/C/D. Jadi skor dari 75% bobot terlihat berbeda dari skor dari 100% bobot, bukan hanya berbeda di teks.

**Kandidat hampir lolos (near-miss).** Gate tetap keras, tetapi kandidat yang gagal gate **tidak lagi dibuang tanpa angka**: semuanya diberi skor penuh dan yang teratas disimpan sebagai `nearMissRows` (maksimum `DISCOVERY.nearMissLimit`, default 20) beserta daftar gate yang gagal. Ini penting untuk tujuan scanner ini: token yang paling berpotensi sering gugur karena satu ambang (market cap kecil, pool baru, holder sedikit). Near-miss juga dicatat sebagai snapshot (`nearMiss: true`) sehingga backtest dapat mengukur gate mana yang sebenarnya membuang kandidat terbaik. Di UI, near-miss berada di panel terpisah di bawah kandidat yang lolos dan tidak pernah dicampur dengan baris yang lolos gate.

**Token baru di scanner.** Tabel `tokens` menyimpan `first_seen`; sekarang nilai itu dibaca **sebelum** snapshot run ini ditulis, sehingga `isNew` berarti "belum pernah terlihat sebelum run ini" (bukan "baru dibuat di chain", dan bukan sekadar sesi baru). Baris baru diberi chip **baru**, dan `firstSeen` dikembalikan di payload. Ini murah dan tidak menambah request ke provider.

### Preset

| Preset             | Likuiditas | Usia pool | Holder  | Top 10 | Market cap | FDV/MC | Turnover | Perubahan 24j   | Verifikasi                  |
| ------------------ | ---------- | --------- | ------- | ------ | ---------- | ------ | -------- | --------------- | --------------------------- |
| Conservative       | ≥ $250k    | ≥ 7 hari  | ≥ 2.000 | ≤ 25%  | ≥ $2 jt | ≤ 1,5× | ≤ 8×     | -15% s.d. +150% | wajib; market cap wajib diketahui |
| Balanced (default) | ≥ $150k    | ≥ 48 jam  | ≥ 1.500 | ≤ 30%  | ≥ $1 jt | ≤ 1,5× | ≤ 10×    | -30% s.d. +100% | tidak wajib                 |
| Degen              | ≥ $60k     | ≥ 1 jam   | ≥ 200   | ≤ 60%  | ≥ $100k | ≤ 4×   | ≤ 40×    | -50% s.d. +500% | tidak wajib; pola rug top 10 > 40% tanpa info LP |
| Gem hunter         | ≥ $50k     | ≥ 1 jam   | ≥ 100   | ≤ 45%  | $50k–$5 jt | ≤ 5× | ≤ 80×    | -60% s.d. +2000% | tidak wajib; tanpa gate pola rug tambahan |

Preset mengubah angka gate, kurva likuiditas, kurva upside, dan bobot skor, jadi token yang sama bisa punya skor dan peringkat berbeda antar-preset. Minimum likuiditas Degen dinaikkan agar kandidat tepat di ambang mempunyai estimasi slippage sekitar 2% atau lebih rendah untuk notional default $500. Gate perubahan 24 jam menolak penurunan tajam; perubahan yang datanya tidak tersedia tetap tidak ditolak oleh gate tersebut. Praset mempertahankan makna profil risikonya: Balanced tetap preset kualitas/momentum default, sedangkan Gem hunter adalah preset terpisah untuk token mikro/baru dan tidak menggantikan Balanced.

Semua ambang adalah **heuristik yang belum dikalibrasi ulang oleh backtest**; versinya dicatat di setiap run (`configHash`) agar hasil lama tidak tercampur dengan aturan baru. Laporan backtest mengelompokkan hasil menurut grade, tahap skor, cohort, dan preset. UI menampilkan ambang serta bobot preset yang sedang aktif di bawah pemilih preset.

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

- Cache scan 30 detik; cache **single-flight + LRU + TTL** per origin. `refresh=1` pada `/api/discover` dan `/api/scan` melewati cache server **dan** cache sumber, jadi angka yang tampil benar-benar baru diambil.
- Batas lokal: Jupiter 30/menit, DEX Screener 30/menit, GeckoTerminal **6/menit dengan jarak minimum 10 detik antar request**, GoPlus 20/menit dengan jarak antar-panggilan 300 ms, dan **Discover 10/menit dengan single-flight** (dua permintaan identik menunggu hasil yang sama, bukan menggandakan sampling upstream maupun penulisan snapshot).
- **Batas GeckoTerminal terukur dari jaringan pengembangan:** ~4-5 request per menit aman; burst tiga request dalam hitungan detik sudah memicu 429, dan header `Retry-After` provider bernilai `"0"` sehingga tidak bisa dipakai sendiri. Karena itu aplikasi memakai batas lokal 6/menit, jarak minimum 10 detik, dan **cooldown minimum 30 detik** ketika 429 datang. Limiter bisa **menunggu** slot (`wait`) untuk pekerjaan latar, sehingga antrean deep scan tidak berubah menjadi `unknown` hanya karena kuota habis; 2-4 slot per menit dicadangkan untuk permintaan interaktif (tab Inspect).
- **Satu client per origin.** Discover, Inspect, dan deep scan memakai instance sumber yang sama, sehingga batas laju provider dihitung satu kali untuk seluruh aplikasi — bukan sekali per modul, yang sebelumnya membuat total request GeckoTerminal bisa mencapai 16/menit dan memicu 429.
- TTL cache sumber: Jupiter 60 detik, DEX Screener 30 detik, GeckoTerminal 60 detik, GoPlus 5 menit. **Hasil negatif GoPlus tidak pernah di-cache**: token yang baru diindeks GoPlus tidak terkunci "unknown" selama 10 menit.
- Fase discovery memakai **satu** request GeckoTerminal (dua untuk preset yang menerima likuiditas tipis). Sisanya untuk candle deep scan, karena di sinilah kuota GeckoTerminal paling terasa.
- Deep scan memakai satu candle Gecko + satu pengecekan pool DEX Screener + satu record GoPlus per token, dengan tempo ±13 detik per token. Di lokal, job berjalan di latar; di Vercel (tanpa proses latar), **satu token diproses per poll** `/api/jobs/:id` — satu deep scan utuh tetap muat di dalam batas waktu fungsi serverless, dan hasilnya tercatat di database sehingga progres bertahan antar-request. Satu run 15 baris selesai sekitar 3 menit; baris pertama selesai dalam ~25 detik dan seterusnya berurutan sesuai peringkat.
- HTTP 429 menghormati header `Retry-After` (dengan batas minimum) dan memberi cooldown per origin; slot yang gagal dikembalikan.
- **Ketahanan terhadap penyedia yang diblokir.** Gangguan jaringan (koneksi diputus, DNS, proxy yang menahan domain) diulang satu kali; jawaban 4xx tidak diulang. Kalau sebuah penyedia gagal berulang, **pemutus arus** menjeda penyedia itu 5 menit dan pesannya menyebut penyebabnya ("Jupiter sedang tidak dihubungi (gagal berulang); jeda 300 detik") alih-alih "fetch failed". Kode penyebab jaringan (ECONNRESET, ENOTFOUND) ikut ditampilkan. Run dengan semua sumber gagal tidak pernah disamarkan sebagai "tidak ada kandidat": tabel kosong karena sumber data mati diberi pesan dan peringatan yang berbeda dari "semua kandidat gugur gate".
- Timeout 10 detik per provider; batas UI 30 detik untuk inspect dan 90 detik untuk discover.
- **Waktu pengambilan ditampilkan.** Ringkasan run menampilkan waktu run; tiap baris menyimpan `market.fetchedAt` (waktu data pasar diambil), `structure.lastClosedAt` (waktu penutupan candle 1 jam yang dipakai struktur dan entry plan), dan `safety.fetchedAt` (waktu data keamanan diambil). Rincian kandidat menampilkan umur masing-masing angka dan alasan kalau candle gagal. Angka tanpa waktu tidak boleh dibaca sebagai harga terkini.
- Tidak ada polling harga atau discovery otomatis. Hanya progres job deep scan yang dipoll setiap 2 detik (maksimal 12 menit, tanpa request bertumpuk); tampilan menghitung umur lokal setiap 15 detik tanpa mengambil harga baru.
- Struktur candle 1 jam memerlukan sedikitnya **50 candle tertutup berurutan** agar EMA50 benar-benar terukur. Data yang lebih pendek tetap `unknown`; hasil job selalu menyertakan mint agar UI dapat memasangkan pembaruan dengan token yang benar. ATR14 dihitung dengan pelicinan Wilder (definisi yang sama dengan RSI14), dan struktur melaporkan jumlah **gap** interval yang hilang — indikator melintasi celah, dan jumlah gap ikut ditampilkan agar terbaca.

## Keamanan kontrak: GoPlus + Jupiter, bukan RugCheck

`risk.mjs` memakai **GoPlus** (`/api/v1/solana/token_security`) untuk mint/freeze authority, transfer fee/hook, non-transferable, metadata mutable, jumlah holder, konsentrasi top 10, dan holder LP, ditambah **audit bawaan Jupiter** (`mintAuthorityDisabled`, `freezeAuthorityDisabled`, `topHoldersPercentage`) sebagai pembanding.

RugCheck tidak dipakai: hostname `api.rugcheck.xyz` **tidak resolve** dari jaringan pengembangan (NXDOMAIN, diverifikasi lewat resolver sistem dan DoH), sehingga endpoint dan skemanya tidak dapat diverifikasi. Endpoint dan persyaratan akses tidak ditebak.

Skala persen dari kedua sumber berbeda dan **tidak dicampur**: GoPlus mengembalikan `percent` sebagai fraksi 0–1 (dikonversi ke persen), Jupiter memakai poin persentase. Selain skala, **definisinya juga berbeda**: GoPlus menghitung wallet exchange/program sebagai holder, Jupiter tidak. Satu token bisa terbaca 65% di satu sumber dan 15% di sumber lain pada menit yang sama. Karena itu gate hanya memakai satu sumber (audit Jupiter) sementara pembaca kedua ditampilkan sebagai peringatan tersendiri, dan status kandidat tidak pernah berubah hanya karena sumber berpindah. Bila sumber tidak tersedia, semua status keamanan `unknown` — **bukan risiko rendah**. Likuiditas tidak membuktikan LP terkunci.

Record GoPlus yang menghilangkan kontrol mint/freeze atau transfer berstatus `partial`, bukan otomatis bersih. Bahaya eksplisit tetap menggugurkan kandidat; kontrol yang belum diketahui menggugurkan preset ketat dan membatasi grade preset lain ke C. `transfer_fee`/`transfer_hook` yang dikirim GoPlus sebagai boolean `false` dibaca sebagai "tidak ada", bukan unknown. Konsentrasi top 10 memakai sepuluh persentase holder terbesar, tidak bergantung urutan respons provider.

## Snapshots, watchlist, dan SQLite

Persistensi memakai **SQLite** — `node:sqlite` bawaan Node secara lokal (tanpa dependensi), atau **Turso/libSQL** di produksi Vercel bila `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` diset. Kedua backend mengekspos fasad yang sama; SQL yang dipakai keduanya kompatibel. Bila runtime tidak menyediakan `node:sqlite`, scanner berjalan **stateless** dan melaporkan alasannya di `/api/config` dan `/api/health`, bukan crash.

Tabel: `tokens`, `snapshots`, `discover_runs`, `watchlist`, `plans`, `jobs`, `job_meta`. Setiap run discover menyimpan snapshot harga/likuiditas/skor per kandidat, sehingga `npm run backtest` dapat menghitung return forward per grade dan horizon dari data yang Anda rekam sendiri. **Snapshot diperbarui setelah deep scan**: skor dan grade yang tersimpan adalah skor final (struktur 1 jam + GoPlus) yang benar-benar ditampilkan ke pengguna, bukan skor ranking awal. Tahap skor ditandai `scoreStage` (`initial` atau `deep`) supaya laporan backtest menunjukkan bahwa keduanya tidak sebanding. Kandidat **near-miss** juga dicatat dengan penanda `nearMiss: true` dan daftar `gates` yang gagal, supaya backtest bisa membandingkan kohort dan mengatribusikan gate mana yang membuang kandidat terbaik. Database lokal ada di `data/scanner.db` dan tidak pernah dibagikan. Tabel dipangkas otomatis pada saat dibuka: yang disimpan adalah 5.000 `snapshots`, 2.000 `plans`, dan 500 `discover_runs` terbaru (berbasis jumlah, bukan usia — data lama tetap dipakai backtest). Penulisan snapshot per run dibungkus satu transaksi, sehingga kegagalan di tengah tidak meninggalkan setengah data. Kegagalan pencatatan tidak menggagalkan respons discover.

## API

Semua endpoint hanya loopback. Selain `POST`/`DELETE /api/watchlist`, hanya `GET` yang diterima (selain itu `405`).
Host asing ditolak untuk mengurangi risiko DNS rebinding. Mutasi Watchlist dari browser harus berasal dari origin loopback yang sama; origin asing dan request cross-site ditolak. Klien lokal non-browser tanpa header Origin tetap dapat memakai CRUD.

```text
GET    /api/config
GET    /api/health
GET    /api/discover?preset=balanced|conservative|degen&limit=1..20&refresh=1
GET    /api/jobs/{jobId}
GET    /api/scan?mint={mint}&refresh=1
GET    /api/history?mint={mint}
GET    /api/watchlist
POST   /api/watchlist           { "mint": "...", "note": "..." }
DELETE /api/watchlist/{mint}
```

## Privasi

Mint yang dipindai dikirim ke DEX Screener, GeckoTerminal, GoPlus, dan Jupiter. Backend hanya memakai origin API resmi dan tidak mengikuti redirect. Tidak ada wallet, private key, transaksi, database akun, cookies, login, localStorage, atau kredensial. Respons pihak ketiga ditampilkan sebagai teks, bukan HTML. Format base58 32-byte tidak membuktikan alamat adalah akun mint on-chain.

## File proyek

- `config.mjs`: preset, bobot skor, ambang gate, batas laju, config hash.
- `server.mjs`: wrapper loopback (`npm start`) **dan** fungsi serverless Vercel (default export); routing, job deep scan, dan cache hidup di `lib/handler.mjs`.
- `lib/handler.mjs`: router, validasi, single-flight, job deep scan (satu token per poll di DB, atau in-memory sebagai fallback), cache discover.
- `middleware.js`: basic auth di depan semua rute (khusus Vercel; lokal tidak memakainya).
- `discover.mjs`: orkestrasi universe → pre-filter → batch → gate → skor → deep scan.
- `sources/`: adapter `jupiter`, `dexscreener`, `gecko`, `goplus` (normalisasi + provenance).
- `screen/`: `gates`, `score`, `rank`, `provenance` — fungsi murni tanpa I/O.
- `analysis/`: `candles` (EMA/ATR/RSI/struktur) dan `entryplan`.
- `lib/`: `http`, `cache`, `limiter`, `provenance`, `handler`.
- `db.mjs`: SQLite ganda — `node:sqlite` lokal (bawaan Node) dan Turso/libSQL di produksi; tabel `tokens`, `snapshots`, `discover_runs`, `watchlist`, `plans`, `jobs`, `job_meta`.
- `jobs.mjs`: antrean job in-memory (fallback ketika storage tidak tersedia atau job disuntikkan secara eksplisit, mis. tes).
- `backtest.mjs`: forward-test offline.
- `signals.mjs`, `history.mjs`, `risk.mjs`: jalur Inspect (15 menit, GeckoTerminal, GoPlus).
- `public/`: antarmuka tanpa dependensi eksternal. Font **Archivo** (variable) dan **IBM Plex Mono** disimpan sendiri di `public/fonts/` (lisensi OFL) dan disajikan dari origin yang sama, jadi aplikasi tidak pernah meminta font ke pihak ketiga — CSP `default-src 'self'` sudah melarang itu.
- `test/`: regresi murni dan integrasi HTTP; fixture sintetis hanya untuk tes.

## Batas yang harus dibaca bersama hasil

- Ambang dan bobot belum dikalibrasi ulang oleh backtest. `configHash` mencatat versinya.
- Snapshot pihak ketiga bisa terlambat, keliru, atau tidak lengkap; bukan feed real-time. Tidak ada feed real-time di aplikasi ini: setiap angka berasal dari polling API pihak ketiga dengan batas laju dan cache seperti tertulis di bagian Freshness.
- Cakupan Jupiter/GeckoTerminal/DEX Screener untuk token baru tidak dijamin.
- Endpoint batch DEX Screener hanya mengembalikan satu pool per token; pool yang dipakai sudah dicek ulang untuk shortlist, tetapi untuk kandidat di luar shortlist pool itu tetap pilihan provider, bukan hasil pencarian "semua pool".
- Backtest adalah forward-test dari snapshot yang Anda rekam sendiri, bukan backtest historis penuh: jarak snapshot tidak seragam dan ada bias seleksi. Kandidat yang lolos gate maupun near-miss kini ikut dicatat, tetapi token yang tidak pernah muncul di sumber tidak pernah tercatat. Tahap skor (`initial`/`deep`) perlu dibaca bersama.
- Kolom `peak` (dan angka 2x/5x/10x) adalah puncak yang **tercatat** di antara snapshot, bukan puncak pasar sebenarnya. Bila tidak ada snapshot di dekat puncak, multi-bagger bisa terlewat — angka ini batas bawah, bukan atas.
- Tidak ada hasil yang menjamin token aman, dan tidak ada rekomendasi beli/jual.
