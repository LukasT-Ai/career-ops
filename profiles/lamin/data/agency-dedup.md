# Agency Dedup Analysis — Paulina Kaiser Pipeline

**Generated:** 2026-04-07
**Source:** `profiles/paulina/data/pipeline.md`
**Status:** Analysis only — pipeline.md NOT modified

---

## Summary

| Metric | Count |
|--------|-------|
| Total German (Arbeitsagentur) listings | 172 |
| Staffing agency listings | 111 (65%) |
| Direct employer listings | 61 (35%) |
| Active (non-SKIP) listings | 130 |
| Exact duplicates (same agency + city + level) | 10 |
| Cross-agency duplicates (same city + level) | 6 |
| Estimated unique positions after dedup | ~114 active |

---

## Agency Ranking (by listing count)

| # | Agency | Type | Total | SKIP | Active | Unique Cities | Role Levels |
|---|--------|------|-------|------|--------|---------------|-------------|
| 1 | EMA Vermittlung | Agency | 27 | 0 | 27 | 20 | Facharzt, Oberarzt, Chefarzt |
| 2 | Sanovetis GmbH | Agency | 19 | 0 | 19 | 18 | Facharzt |
| 3 | tw.con. GmbH | Agency | 12 | 6 | 6 | 11 | Facharzt, Oberarzt |
| 4 | HB-Pro | Agency | 10 | 1 | 9 | 9 | Oberarzt, Ltd. OA, Chefarzt |
| 5 | FFD | Agency | 8 | 8 | 0 | 8 | Assistenzarzt (all SKIP) |
| 6 | Doc-Spezialisten | Agency | 7 | 0 | 7 | 7 | Facharzt |
| 7 | Tina Przybylski | Agency | 6 | 3 | 3 | 1 | Chefarzt, Ltd. OA, Oberarzt |
| 8 | Healthbridge | Agency | 5 | 0 | 5 | 5 | Chefarzt |
| 9 | BS Menzel GmbH | Agency | 4 | 0 | 4 | 3 | Facharzt, Oberarzt, Chefarzt |
| 10 | PremiumJob AG | Agency | 4 | 1 | 3 | 4 | Oberarzt (incl. CH) |
| 11 | LOCUMWORK GmbH | Agency | 3 | 0 | 3 | 3 | Ltd. OA, Chefarzt |

**FFD** has 8 listings but ALL are Assistenzarzt (already SKIP). No action needed.

---

## Exact Duplicates (SAME agency, SAME city, SAME level)

These are clear duplicates — likely re-postings or stale listings. **Remove all but one.**

### 1. EMA Vermittlung — Facharzt Psychiatrie — Mosbach (2x)
- **KEEP:** L82 (earlier listing, from Pendientes batch)
- REMOVE: L165 (later DISPATCHED duplicate)

### 2. EMA Vermittlung — Facharzt Psychiatrie — Gotha (2x)
- **KEEP:** L161
- REMOVE: L167

### 3. EMA Vermittlung — Facharzt Psychiatrie — Darmstadt (2x)
- **KEEP:** L166
- REMOVE: L169

### 4. EMA Vermittlung — Chefarzt Psychiatrie — Jever (2x)
- **KEEP:** L200
- REMOVE: L204

### 5. Sanovetis GmbH — Psychiater — Kassel (2x)
- **KEEP:** L73
- REMOVE: L74

### 6. ZfP Suedwuerttemberg — Oberarzt Psychiatrie — Ravensburg (2x)
- **KEEP:** L101
- REMOVE: L102

### 7. Vincera Klinik Spreewald — Chefarzt Psychiatrie — Bersteland (2x)
- **KEEP:** L117
- REMOVE: L124

### 8. KH Schloss Werneck — Oberarzt Psychiatrie — Werneck (2x)
- **KEEP:** L188
- REMOVE: L189

**Total exact dupes to remove: 8 listings**

---

## Cross-Agency Duplicates (SAME city + level, DIFFERENT agencies)

These are likely the same underlying hospital job posted by multiple staffing agencies. **Keep the direct employer listing if one exists; otherwise keep whichever is closest to priority cities or higher-rated.**

### 1. Stuttgart — Oberarzt Psychiatrie (3 listings, 3 agencies)
- L87: tw.con. GmbH (agency)
- L94: HB-Pro (agency)
- L99: Klinikum Stuttgart (direct employer)
- **KEEP:** L99 (Klinikum Stuttgart — direct employer)
- REMOVE: L87, L94

### 2. Heilbronn — Chefarzt Psychiatrie (2 listings, 2 agencies)
- L121: Healthbridge GmbH (agency)
- L209: HB-Pro (agency)
- **KEEP:** L121 (Healthbridge — often has more detail)
- REMOVE: L209

### 3. Bad Hersfeld — Chefarzt Psychiatrie (2 listings, 2 agencies)
- L122: HB-Pro — "Chefarzt Psychiatrie Akutklinik"
- L125: Healthbridge GmbH — "Chefarzt Psychiatrie + Ambulanz"
- **NOTE:** Slightly different role descriptions — could be 2 distinct positions or same job described differently
- **KEEP:** L125 (Healthbridge, more descriptive)
- FLAG: L122 — may be distinct, verify before removing

### 4. Kaiserslautern — Chefarzt Psychiatrie (2 listings, 2 agencies)
- L207: Healthbridge GmbH (agency)
- L208: HB-Pro (agency)
- **KEEP:** L207 (Healthbridge)
- REMOVE: L208

### 5. Darmstadt — Multiple levels, overlapping agencies
- L166: EMA — Facharzt (dupe of L169, already flagged above)
- L183: Agaplesion Elisabethenstift — Ltd. Oberarzt
- L229: Agaplesion — Oberarzt Psychiatrie/Psychosomatik
- **NOTE:** L183 and L229 are different levels (Ltd. OA vs OA) at the same employer — likely distinct positions. Keep both.

### 6. Siegen — Different levels, overlapping agencies
- L85: EMA Vermittlung — Facharzt
- L139: LOCUMWORK GmbH — Ärztl. Direktor
- **NOTE:** Very different levels — distinct positions. Keep both.

**Total cross-agency dupes to remove: 4 listings**

---

## Same-Agency, Same-City, Different Levels (NOT duplicates)

These are the same agency posting Facharzt AND Oberarzt in the same city. These are likely genuinely different positions at the same hospital. **Keep both.**

| Agency | City | Levels | Lines |
|--------|------|--------|-------|
| tw.con. GmbH | Soltau | Facharzt + Oberarzt | L77, L176 |
| EMA Vermittlung | Plettenberg | Facharzt + Oberarzt | L163, L179 |
| EMA Vermittlung | Olpe | Facharzt + Oberarzt | L168, L174 |
| EMA Vermittlung | Gotha | Facharzt + Oberarzt | L161, L171 |
| BS Menzel GmbH | Bremen | Facharzt + Oberarzt | L86, L91 |

---

## Sanovetis GmbH Deep Dive (19 listings, all Facharzt)

Sanovetis is the second-largest agency, posting the same generic "Psychiater" role across 18 cities. These are almost certainly template postings — the same job ad copy pasted for every city they have a contract in. Most are in Brandenburg/Berlin region (far from priority cities).

| City | Line | Priority? |
|------|------|-----------|
| Passau | L151 | Bayern (nearest to priority) |
| Potsdam | L70 | No |
| Brandenburg a.d. Havel | L69 | No |
| Eberswalde | L68 | No |
| Frankfurt (Oder) | L67 | No |
| Villingen-Schwenningen | L71 | No |
| Kassel | L73 (keep), ~~L74~~ | No |
| Essen | L74 | No |
| Lunen | L75 | No |
| Beelitz | L152 | No |
| Bad Freienwalde | L153 | No |
| Fürstenwalde | L154 | No |
| Luckenwalde | L155 | No |
| Templin | L156 | No |
| Neuruppin | L157 | No |
| Senftenberg | L158 | No |
| Rüdersdorf | L159 | No |
| Oranienburg | L160 | No |

**Recommendation:** Keep Passau (closest to Bayern priority area). Consider bulk-skipping the Brandenburg cluster (Beelitz through Oranienburg) unless relocation to Berlin area is viable.

---

## EMA Vermittlung Deep Dive (27 listings, most prolific)

EMA is by far the largest agency, posting across 3 levels. After removing 4 exact dupes, 23 active listings remain.

**Facharzt (12 active after dedup → 9):**
- Mosbach (keep L82), Gundelsheim, Siegen, Gotha (keep L161), Püttlingen, Plettenberg, **München** (L164 — PRIORITY), Mosbach (dupe), Darmstadt (keep L166), Darmstadt (dupe), Olpe, Gotha (dupe)

**Oberarzt (9):**
- Bad Salzungen, Gotha, Gummersbach, Dortmund, Olpe, Hagen, Plettenberg, Lüdenscheid, Herford

**Chefarzt (5 after dedup → 4):**
- Jever (keep L200), Kleve bei Itzehoe, Auerbach/Vogtland, Oldenburg, Jever (dupe)

**Other (1):** Stralsund (Forensik)

**Priority city hit:** München (L164) — Facharzt level. This is a strong candidate.

---

## Priority City Proximity Summary

Priority cities: Bamberg, Bayreuth, München, Heidelberg, Mannheim

| City | Agency | Level | Line | Distance to Priority |
|------|--------|-------|------|---------------------|
| **München** | EMA Vermittlung | Facharzt | L164 | 0 km (exact match) |
| **Mannheim** | HB-Pro | Chefarzt | L120 | 0 km (exact match) |
| Mosbach | EMA Vermittlung | Facharzt | L82 | ~65 km from Heidelberg |
| Gundelsheim | EMA Vermittlung | Facharzt | L83 | ~30 km from Heidelberg |
| Heilbronn | Healthbridge | Chefarzt | L121 | ~50 km from Heidelberg |
| Augsburg | Augsburger Lehmbaugruppe | Facharzt | L127 | ~65 km from München |
| Passau | Sanovetis GmbH | Facharzt | L151 | ~200 km from München |
| Neuburg | DANUVIUS Klinik | Facharzt | L130 | ~90 km from München |
| Pfaffenhofen | DANUVIUS Klinik | Facharzt | L219 | ~50 km from München |
| Schwangau | BS Menzel GmbH | Facharzt | L84 | ~120 km from München |
| Cham | BS Menzel GmbH | Chefarzt | L119 | ~100 km from Bayreuth |
| Deggendorf | Siiri Schuetz | FA/OA | L106 | ~180 km from München |

---

## Action Summary

| Action | Count | Details |
|--------|-------|---------|
| Exact duplicates to remove | 8 | Same agency + city + level posted twice |
| Cross-agency dupes to remove | 4 | Same hospital job from multiple agencies |
| **Total removable** | **12** | Mark as SKIP in pipeline.md |
| Verify before removing | 1 | Bad Hersfeld (L122 vs L125 — may be distinct) |
| Priority city keepers | 2 | München (L164), Mannheim (L120) |
| Near-priority keepers | 4 | Gundelsheim, Mosbach, Heilbronn, Augsburg |
| Consider bulk-skip | ~10 | Sanovetis Brandenburg cluster (far from priorities) |

---

## Top Recommendations

1. **Immediately remove 12 exact/cross-agency duplicates** — these add noise without value
2. **Prioritize München (L164) and Mannheim (L120)** — exact priority city matches
3. **Prioritize Heidelberg-adjacent cluster** — Gundelsheim (30km), Mosbach (65km), Heilbronn (50km)
4. **Prioritize München-adjacent cluster** — Pfaffenhofen (50km), Augsburg (65km), Neuburg (90km)
5. **Consider skipping Sanovetis Brandenburg cluster** (8-10 listings) unless Berlin-area relocation is viable
6. **EMA Vermittlung NRW cluster** (Plettenberg, Olpe, Dortmund, Hagen, Lüdenscheid, Gummersbach, Herford) — 7 listings all in the same region, far from priorities. Keep 1-2 best if NRW is of interest, otherwise deprioritize.
