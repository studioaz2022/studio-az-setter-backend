# Local Falcon "Before" Snapshot — GBP Services Fill, Sept 10 2026

**Context:** Same-day baseline taken immediately AFTER the GBP services fill was applied
(both profiles updated ~1 hour before these scans ran), so strictly this is the
"T-zero" snapshot — Sterling Sky's tested effect window is 24–72h, so any movement
should show against these numbers, not the May ones.

**What changed on the profiles today:**
- Tattoo: 6 → 18 services (added cover-ups & reworks, color, custom lettering,
  photo-realistic, traditional, Polynesian tribal, sleeves, memorial + free-form
  Floral/Geometric/Portrait/Religious, all with SEO descriptions). Profile
  description rewritten: 100% custom, appointment-only, "walk-in flash" removed.
- Barbershop: 21 → 16 services (6 duplicate free-form entries deleted, SEO
  descriptions written for all 13 structured services, Buzz cut added).
- Backup before overwrite: `src/seo/gbp-services-backup-2026-09-10.json`

**Scan settings** (mirror prior scans exactly → trend reports auto-generate):
- Tattoo: place `ChIJt_vZnAAzs1IR5e7h5BUE0O0`, 11×11 grid, 4.5 mi, center 44.9842902,-93.2738897, Google
- Barbershop: place `ChIJ598OaS4zs1IR4YfeL8TGg3g`, 15×15 grid, 5.0 mi, same center, Google

## Studio AZ Tattoo (11×11 = 121 points)

| Keyword | ARP | ATRP | SoLV | Found In | report_key |
|---|---|---|---|---|---|
| tattoo shop minneapolis | 17.29 | 20.48 | 0.83 | 17 | 0edbd5d8b30f684 |
| tattoo shop near me | 15.13 | 19.55 | 0.83 | 30 | 303829b652e47bb |
| tattoo artist minneapolis | 16.62 | 19.95 | 0.83 | 29 | c5ab350edfa778b |
| best tattoo shop minneapolis | 21.00 | 21.00 | 0.00 | 0 | f8a44b7cdee67e0 |
| custom tattoo minneapolis | 15.50 | 20.82 | 0.00 | 4 | ba872f565cf3682 |
| tattoo near me | 14.95 | 20.00 | 0.83 | 20 | 16c17cbf6834c31 |

### vs May 4 — visibility radius has expanded ~10-30×

May 4 the shop appeared in **1–2 cells** per keyword (center only). Today it appears
in **17–30 cells** for the four main keywords, and "custom tattoo minneapolis" went
from fully invisible to 4 cells. ATRP improved across the board (e.g. tattoo shop
near me 20.86 → 19.55). The higher ARP vs May is the same statistical artifact the
May doc explains: cells that were "20+" now carry real ranks, which raises the
average of *visible* cells while overall visibility improves. SoLV (top-3 share) is
still 0.83% — top-3 only at our own block; that's the metric the review-velocity
work needs to move. "best tattoo shop minneapolis" remains invisible.

## Studio AZ Barbershop (15×15 = 225 points)

| Keyword | ARP | ATRP | SoLV | Found In | report_key |
|---|---|---|---|---|---|
| barbershop near me | 12.79 | 18.52 | 0.00 | 68 | d80bf2a2ce741ef |
| mens haircut minneapolis | 7.03 | 9.27 | 25.33 | 189 | d66be83a1935d19 |
| best barbershop minneapolis | 6.72 | 8.50 | 33.78 | 197 | 5bdd55be7c66b49 |
| fade haircut minneapolis | 10.49 | 13.52 | 3.11 | 160 | 95bea4ab84ddc18 |

Barbershop is far stronger than tattoo: "mens haircut minneapolis" holds top-3 in a
quarter of the grid (SoLV 25.33, found in 189/225 cells).

**Next check:** re-scan same settings ~Sept 13–17 (72h+) to measure the services
effect; credits used today ≈ 1,626.
