# Modo: auto-pipeline — Pipeline Completo Automático

Cuando el usuario pega un JD (texto o URL) sin sub-comando explícito, ejecutar TODO el pipeline en secuencia:

## Paso 0 — Extraer JD

Si el input es una **URL** (no texto de JD pegado), seguir esta estrategia para extraer el contenido:

**Orden de prioridad:**

1. **Playwright (preferido):** La mayoría de portales de empleo (Lever, Ashby, Greenhouse, Workday) son SPAs. Usar `browser_navigate` + `browser_snapshot` para renderizar y leer el JD.
2. **WebFetch (fallback):** Para páginas estáticas (ZipRecruiter, WeLoveProduct, company career pages).
3. **WebSearch (último recurso):** Buscar título del rol + empresa en portales secundarios que indexan el JD en HTML estático.

**Si ningún método funciona:** Pedir al candidato que pegue el JD manualmente o comparta un screenshot.

**Si el input es texto de JD** (no URL): usar directamente, sin necesidad de fetch.

## Paso 1 — Evaluación A-F
Ejecutar exactamente igual que el modo `oferta` (leer `modes/oferta.md` para todos los bloques A-F).

## Paso 2 — Guardar Report .md
Guardar la evaluación completa en `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (ver formato en `modes/oferta.md`).

## Paso 3 — Generar PDF
Ejecutar el pipeline completo de `pdf` (leer `modes/pdf.md`).

## Paso 4 — Draft Application Answers (solo si score >= 4.5)

Si el score final es >= 4.5, generar borrador de respuestas para el formulario de aplicación:

1. **Extraer preguntas del formulario**: Usar Playwright para navegar al formulario y hacer snapshot. Si no se pueden extraer, usar las preguntas genéricas.
2. **Generar respuestas** siguiendo el tono (ver abajo).
3. **Guardar en el report** como sección `## G) Draft Application Answers`.

### Preguntas genéricas (usar si no se pueden extraer del formulario)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tono para Form Answers

**Posición: "I'm choosing you."** el candidato tiene opciones y está eligiendo esta empresa por razones concretas.

**Reglas de tono:**
- **Confiado sin arrogancia**: "I've spent the past year building production AI agent systems — your role is where I want to apply that experience next"
- **Selectivo sin soberbia**: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- **Específico y concreto**: Siempre referenciar algo REAL del JD o de la empresa, y algo REAL de la experiencia del candidato
- **Directo, sin fluff**: 2-4 frases por respuesta. Sin "I'm passionate about..." ni "I would love the opportunity to..."
- **El hook es la prueba, no la afirmación**: En vez de "I'm great at X", decir "I built X that does Y"

**Framework por pregunta:**
- **Why this role?** → "Your [specific thing] maps directly to [specific thing I built]."
- **Why this company?** → Mencionar algo concreto sobre la empresa. "I've been using [product] for [time/purpose]."
- **Relevant experience?** → Un proof point cuantificado. "Built [X] that [metric]. Sold the company in 2025."
- **Good fit?** → "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- **How did you hear?** → Honesto: "Found through [portal/scan], evaluated against my criteria, and it scored highest."

**Idioma**: Siempre en el idioma del JD (EN default). Aplicar `/tech-translate`.

## Paso 4.5 — Document Localization (MANDATORY before cover letter)

Run localization analysis to determine document formats, languages, and attachments:

```javascript
import { analyzeJob } from './localize-detect.mjs';
const localization = analyzeJob(jobTitle, jobDescription, company, postingUrl, activeProfileName);
```

**Based on the result:**

1. If `needs_lebenslauf_generation` is true → generate Lebenslauf from cv.md (see `modes/localize.md` Step 2)
2. Use `cover_letter_language` and `format` to configure the cover letter step below
3. Use `page_format` ('a4' or 'letter') for PDF generation
4. If `attach_english_cv` is true → generate English CV PDF alongside German docs
5. Store the localization result — it feeds into Paso 5, 7 (dispatcher attachments), and the evaluation report

**Lebenslauf priority:** Use existing `profiles/{name}/cv-de.md` if it exists. Only auto-generate if missing. Always attach the English CV as secondary for German jobs where the application allows.

## Paso 5 — Cover Letter Generation
- If evaluation score >= 3.5, generate a tailored cover letter
- **Language and format from Paso 4.5 localization result** (German Bewerbungsschreiben or English business letter)
- **Page format from localization** (A4 for German, Letter for US)
- Use modes/cover-letter.md workflow (with language/format overrides from localization)
- Save to output/cl-{name}-{company}-{date}.pdf
- Copy to profiles/{name}/cover-letters/

## Paso 6 — Auto-Apply Gate
- Read profiles/{name}/approval-config.yml
- Detect ATS platform from URL
- If supported ATS + approval allows:
  - Prepare application using modes/auto-apply.md
  - Fill form fields, upload resume + cover letter
  - STOP at approval gate (manual mode) or submit (auto/threshold)
- If unsupported ATS:
  - Show manual apply instructions
- Log to data/apply-log.md

## Paso 7 — Job Dispatcher Notification

After evaluation, route the job through the notification dispatcher based on fit score:

```javascript
import { dispatch } from './job-dispatcher.mjs';

await dispatch(
  { title, company, url, location, salary, platform, matchReasons, draftCoverLetter,
    coverLetterPath, cvPdfPath, cvDePdfPath, cvEnPdfPath },
  evaluationScore, // 0-5 from oferta mode
  { dryRun: false }
);
```

**Document attachment fields (from Paso 4.5 localization):**
- `coverLetterPath`: Cover letter PDF (German Bewerbungsschreiben or English business letter)
- `cvPdfPath`: Primary CV PDF (Lebenslauf for German jobs, Resume for US jobs)
- `cvDePdfPath`: German Lebenslauf PDF (if auto-generated or exists)
- `cvEnPdfPath`: English Resume PDF (secondary attachment for German jobs)

**All auto-generated documents are attached to the notification email** regardless of mode.

**Score-to-mode mapping:**
- 4.0+ (fit 80-100): **Auto-Apply** → submit + send confirmation email to candidate
- 3.0-3.9 (fit 60-79): **Manual Review** → send email with cover letter PDF attached, candidate applies manually
- 2.0-2.9 (fit 40-59): **Approval** → send email with draft cover letter inline, wait for YES/NO reply
- Below 2.0 (fit <40): **Skip** → log only, no notification

**The dispatcher:**
1. Maps the 0-5 career-ops score to 0-100 fit score
2. Selects the email template (auto-applied / manual-review / approval-request)
3. Sends via Gmail SMTP (Lukas.T@withlukas.com)
4. Attaches cover letter PDF in Manual Review mode
5. Logs to `data/apply-log.md`

**Email is sent to the candidate's email from `profile.yml`** (candidate.email field).

## Paso 8 — Actualizar Tracker
Registrar en `data/applications.md` con todas las columnas incluyendo Report y PDF en ✅.

**Si algún paso falla**, continuar con los siguientes y marcar el paso fallido como pendiente en el tracker.
