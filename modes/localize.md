# Mode: localize — Document Localization & Sponsorship Detection

Run this mode **before** generating any cover letter or CV PDF. It determines which document formats, languages, and page sizes to use based on the job posting.

## When to Run

- Automatically during `auto-pipeline` (before Paso 5 — Cover Letter Generation)
- Manually when evaluating a single job with `/localize`
- During batch processing before PDF generation

## Steps

### Step 1 — Run Localization Analysis

```javascript
import { analyzeJob } from './localize-detect.mjs';

const analysis = analyzeJob(jobTitle, jobDescription, company, postingUrl, activeProfileName);
```

The analysis returns:
- `location_detected`: 'germany' | 'usa' | 'unclear'
- `resume_format`: 'lebenslauf' | 'resume' | 'both'
- `cv_file`: which CV source to use ('cv-de.md' or 'cv.md')
- `cv_de_exists`: whether the profile has an existing Lebenslauf
- `needs_lebenslauf_generation`: if true, generate cv-de.md from cv.md
- `attach_english_cv`: if true, attach cv.md PDF alongside German docs
- `cover_letter_language`: 'german' | 'english'
- `format`: 'bewerbungsschreiben' | 'business_letter'
- `page_format`: 'a4' | 'letter'
- `sponsorship`: object with status, confidence, reason, flag
- `military`: object with military_detected, type, base, language requirement
- `special_instructions`: array of action items for downstream

### Step 2 — Handle Lebenslauf Generation

If `needs_lebenslauf_generation` is true:

1. Read `profiles/{name}/cv.md` (English resume)
2. Generate a German Lebenslauf following these rules:
   - **Format:** Tabellarischer Lebenslauf (tabular CV)
   - **Sections:** Persönliche Daten, Berufserfahrung, Ausbildung, Sprachkenntnisse, Zusätzliche Qualifikationen
   - **Dates:** DD.MM.YYYY format
   - **Tone:** Formal, factual, no first-person pronouns
   - **Length:** 1-2 pages
   - **Photo placeholder:** Include "Foto" section header (candidate adds later)
   - **Language tags:** Deutsch (Muttersprache), Englisch (verhandlungssicher)
3. Save to `profiles/{name}/cv-de.md`
4. Generate PDF using `modes/pdf.md` with A4 page format
5. Save PDF to `profiles/{name}/output/`

### Step 3 — Route Cover Letter

Based on `cover_letter_language` and `format`:

**If German (Bewerbungsschreiben):**
- Salutation: "Sehr geehrte Damen und Herren," (or named contact if known)
- Closing: "Mit freundlichen Grüßen"
- Use Sie (formal), never du
- No exclamation marks
- Dates: DD. Monat YYYY
- A4 page format
- Max 250 words

**If English (Business Letter):**
- Standard US cover letter format
- Letter page format
- 200-300 words
- See `modes/cover-letter.md` for full rules

### Step 4 — Attach Documents to Notification Email

When calling `dispatch()` from `job-dispatcher.mjs`, pass ALL generated document paths:

```javascript
await dispatch(job, evaluationScore, {
  coverLetterPath: 'profiles/{name}/cover-letters/cl-{company}-{date}.pdf',
  cvPdfPath: 'profiles/{name}/output/cv-{name}.pdf',        // primary CV
  cvDePdfPath: 'profiles/{name}/output/cv-de-{name}.pdf',   // German Lebenslauf (if generated)
  cvEnPdfPath: 'profiles/{name}/output/cv-{name}.pdf',      // English CV (for German jobs as secondary)
});
```

**Rule:** If Resume and/or Lebenslauf were auto-generated for this job posting, they MUST be attached to the notification email regardless of mode (Auto-Apply, Manual Review, or Approval).

### Step 5 — Sponsorship Notes (Informational)

All candidates are dual US/German citizens. Sponsorship detection is **informational only**, never blocking.

- If `sponsorship_status === 'NO'`: Note in evaluation that candidate is US citizen, apply anyway
- If `sponsorship_status === 'CONFIRMED'`: Positive signal, note in evaluation
- The visa dimension in fit scoring always scores 5/5 (max) for all candidates

### Step 6 — Military Base Handling

If `military.military_detected === true`:

- **US_MILITARY_BASE:** Resume in English, note SOFA agreement eligibility
- **BUNDESWEHR_CIVILIAN:** Lebenslauf in German, note German citizenship
- **NATO_CIVILIAN:** Both documents, note NATO civilian status

## Integration with Pipeline

This mode is called automatically by `auto-pipeline.md` between evaluation (Paso 1) and cover letter generation (Paso 5). The localization result feeds into:

1. **Cover letter generation** — language, format, page size
2. **CV/PDF generation** — which template, which source file
3. **Job dispatcher** — document attachments in notification emails
4. **Fit score** — visa dimension (always 5/5 for dual citizens)
