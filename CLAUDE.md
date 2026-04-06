# Career-Ops -- AI Job Search Pipeline

## Origin

This system was built and used by [santifer](https://santifer.io) to evaluate 740+ job offers, generate 100+ tailored CVs, and land a Head of Applied AI role. The archetypes, scoring logic, negotiation scripts, and proof point structure all reflect his specific career search in AI/automation roles.

The portfolio that goes with this system is also open source: [cv-santiago](https://github.com/santifer/cv-santiago).

**It will work out of the box, but it's designed to be made yours.** If the archetypes don't match your career, the modes are in the wrong language, or the scoring doesn't fit your priorities -- just ask. You (Claude) can edit the user's files. The user says "change the archetypes to data engineering roles" and you do it. That's the whole point.

## Data Contract (CRITICAL)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (auto-updatable, DON'T put user data here):**
- `modes/_shared.md`, `modes/oferta.md`, all other modes
- `CLAUDE.md`, `*.mjs` scripts, `dashboard/*`, `templates/*`, `batch/*`

**THE RULE: When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `modes/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content.** This ensures system updates don't overwrite their customizations.

## Update Check

On the first message of each session, run the update checker silently:

```bash
node update-system.mjs check
```

Parse the JSON output:
- `{"status": "update-available", "local": "1.0.0", "remote": "1.1.0", "changelog": "..."}` → tell the user:
  > "career-ops update available (v{local} → v{remote}). Your data (CV, profile, tracker, reports) will NOT be touched. Want me to update?"
  If yes → run `node update-system.mjs apply`. If no → run `node update-system.mjs dismiss`.
- `{"status": "up-to-date"}` → say nothing
- `{"status": "dismissed"}` → say nothing
- `{"status": "offline"}` → say nothing

The user can also say "check for updates" or "update career-ops" at any time to force a check.
To rollback: `node update-system.mjs rollback`

## What is career-ops

AI-powered job search automation built on Claude Code: pipeline tracking, offer evaluation, CV generation, portal scanning, batch processing.

### Main Files

| File | Function |
|------|----------|
| `data/applications.md` | Application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `portals.yml` | Query and company config |
| `templates/cv-template.html` | HTML template for CVs |
| `generate-pdf.mjs` | Puppeteer: HTML to PDF |
| `article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories across evaluations |
| `data/apply-log.md` | Application submission log |
| `ats-adapters.mjs` | ATS platform detection & field mapping |
| `generate-cover-letter.mjs` | Cover letter HTML to PDF |
| `templates/job-boards.yml` | Central registry of 130+ job boards with automation tiers |
| `arbeitsagentur-api.mjs` | Bundesagentur für Arbeit API scanner (free, no auth) |
| `job-dispatcher.mjs` | 3-mode job notification dispatcher with email |
| `localize-detect.mjs` | Document localization, sponsorship & military detection |
| `modes/localize.md` | Localization mode instructions (Lebenslauf routing, CL language) |
| `reports/` | Evaluation reports (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`) |

## Multi-Profile System

This fork supports multiple job-search profiles (different people). Each profile has its own CV, config, portals, archetypes, and data.

### Profile Structure

```
profiles/
  active.yml          ← which profile is active (edit this to switch)
  lamin/
    profile.yml       ← candidate config
    _profile.md       ← archetypes, framing, negotiation
    cv.md             ← English CV
    cv-de.md          ← German CV (if applicable)
    portals.yml       ← company list + search queries
    data/             ← applications.md, pipeline.md, scan-history.tsv
    reports/          ← evaluation reports
    output/           ← generated PDFs
    cover-letters/    ← generated cover letter PDFs
    approval-config.yml ← auto-apply approval settings
  paulina/
    (same structure)
  {new-profile}/
    (same structure)
```

### Session Startup — Profile Sync (MANDATORY)

**On EVERY session start, BEFORE any other checks, do this:**

1. Read `profiles/active.yml` to get the active profile name
2. Sync that profile's files to the root locations career-ops expects:
   - `profiles/{name}/cv.md` → `cv.md`
   - `profiles/{name}/profile.yml` → `config/profile.yml`
   - `profiles/{name}/_profile.md` → `modes/_profile.md`
   - `profiles/{name}/portals.yml` → `portals.yml`
   - `profiles/{name}/data/applications.md` → `data/applications.md`
   - `profiles/{name}/data/pipeline.md` → `data/pipeline.md` (if exists)
   - `profiles/{name}/data/scan-history.tsv` → `data/scan-history.tsv` (if exists)
3. Create symlink-like behavior for output: after evaluations/scans, copy new files in `data/`, `reports/`, and `output/` back to `profiles/{name}/`
4. Tell the user: "Active profile: **{name}**" (silently, no confirmation needed)

### Switching Profiles

When the user says "switch to {name}" or "use {name}'s profile":
1. **Save back** any new files from `data/`, `reports/`, `output/` to the current profile's directory
2. Update `profiles/active.yml` to the new name
3. Run the sync (step 2 above) for the new profile
4. Confirm: "Switched to **{name}**. CV, portals, and tracker loaded."

### Adding a New Profile

When the user says "add a new profile for {name}":
1. Create `profiles/{name}/` with subdirectories: `data/`, `reports/`, `output/`
2. Start onboarding (CV, profile.yml, _profile.md, portals.yml) — same flow as First Run
3. Set as active if the user wants

### Rules

- **NEVER mix profiles.** Always check active.yml before evaluating, scanning, or generating.
- **ALWAYS save back** to the profile directory after creating reports, PDFs, or tracker entries.
- Each profile's `data/applications.md` is SEPARATE. Never merge across profiles.
- The root-level files (`cv.md`, `config/profile.yml`, etc.) are just working copies — the source of truth is in `profiles/{name}/`.

### First Run — Onboarding (IMPORTANT)

**Before doing ANYTHING else, check if the system is set up.** Run these checks silently every time a session starts:

0. Read `profiles/active.yml` — if it exists, run Multi-Profile Sync (see above). If not, fall through to single-profile onboarding.
1. Does `cv.md` exist?
2. Does `config/profile.yml` exist (not just profile.example.yml)?
3. Does `modes/_profile.md` exist (not just _profile.template.md)?
4. Does `portals.yml` exist (not just templates/portals.example.yml)?

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently. This is the user's customization file — it will never be overwritten by updates.

**If ANY of these is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place. Guide the user step by step:

#### Step 1: CV (required)
If `cv.md` is missing, ask:
> "I don't have your CV yet. You can either:
> 1. Paste your CV here and I'll convert it to markdown
> 2. Paste your LinkedIn URL and I'll extract the key info
> 3. Tell me about your experience and I'll draft a CV for you
>
> Which do you prefer?"

Create `cv.md` from whatever they provide. Make it clean markdown with standard sections (Summary, Experience, Projects, Education, Skills).

#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and then ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
>
> I'll set everything up for you."

Fill in `config/profile.yml` with their answers. For archetypes, map their target roles to the closest matches and update `modes/_shared.md` if needed.

#### Step 3: Portals (recommended)
If `portals.yml` is missing:
> "I'll set up the job scanner with 45+ pre-configured companies. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `portals.yml`. If they gave target roles in Step 2, update `title_filter.positive` to match.

#### Step 4: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

#### Step 5: Get to know the user (important for quality)

After the basics are set up, proactively ask for more context. The more you know, the better your evaluations will be:

> "The basics are ready. But the system works much better when it knows you well. Can you tell me more about:
> - What makes you unique? What's your 'superpower' that other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people, no Java shops)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?
>
> The more context you give me, the better I filter. Think of it as onboarding a recruiter — the first week I need to learn about you, then I become invaluable."

Store any insights the user shares in `config/profile.yml` (under narrative) or in `article-digest.md` if they share proof points. Update `modes/_shared.md` archetypes and framing if what they describe doesn't match the defaults.

**After every evaluation, learn.** If the user says "this score is too high, I wouldn't apply here" or "you missed that I have experience in X", update your understanding. Adjust the framing in `_shared.md` or add notes to `profile.yml`. The system should get smarter with every interaction.

#### Step 6: Ready
Once all files exist, confirm:
> "You're all set! You can now:
> - Paste a job URL to evaluate it
> - Run `/career-ops scan` to search portals
> - Run `/career-ops` to see all commands
>
> Everything is customizable — just ask me to change anything.
>
> Tip: Having a personal portfolio dramatically improves your job search. If you don't have one yet, the author's portfolio is also open source: github.com/santifer/cv-santiago — feel free to fork it and make it yours."

Then suggest automation:
> "Want me to scan for new offers automatically? I can set up a recurring scan every few days so you don't miss anything. Just say 'scan every 3 days' and I'll configure it."

If the user accepts, use the `/loop` or `/schedule` skill (if available) to set up a recurring `/career-ops scan`. If those aren't available, suggest adding a cron job or remind them to run `/career-ops scan` periodically.

### Personalization

This system is designed to be customized by YOU (Claude). When the user asks you to change archetypes, translate modes, adjust scoring, add companies, or modify negotiation scripts -- do it directly. You read the same files you use, so you know exactly what to edit.

**Common customization requests:**
- "Change the archetypes to [backend/frontend/data/devops] roles" → edit `modes/_shared.md`
- "Translate the modes to English" → edit all files in `modes/`
- "Add these companies to my portals" → edit `portals.yml`
- "Update my profile" → edit `config/profile.yml`
- "Change the CV template design" → edit `templates/cv-template.html`
- "Adjust the scoring weights" → edit `modes/_shared.md` and `batch/batch-prompt.md`

### Language Modes

Default modes are in `modes/` (English). Additional language-specific modes are available:

- **German (DACH market):** `modes/de/` — native German translations with DACH-specific vocabulary (13. Monatsgehalt, Probezeit, Kündigungsfrist, AGG, Tarifvertrag, etc.). Includes `_shared.md`, `angebot.md` (evaluation), `bewerben.md` (apply), `pipeline.md`.

**When to use German modes:** If the user is targeting German-language job postings, lives in DACH, or asks for German output. Either:
1. User says "use German modes" → read from `modes/de/` instead of `modes/`
2. User sets `language.modes_dir: modes/de` in `config/profile.yml` → always use German modes
3. You detect a German JD → suggest switching to German modes

**When NOT to:** If the user applies to English-language roles, even at German companies, use the default English modes.

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + PDF + tracker) |
| Asks to evaluate offer | `oferta` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| Asks for company research | `deep` |
| Wants to generate CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Wants a cover letter | `cover-letter` |
| Wants to auto-apply | `auto-apply` |
| Asks for application report | `report` |
| Wants job notification sent | `dispatch` (via job-dispatcher.mjs) |
| Needs document localization | `localize` (via localize-detect.mjs) |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |

### CV Source of Truth

- `cv.md` in project root is the canonical CV
- `article-digest.md` has detailed proof points (optional)
- **NEVER hardcode metrics** -- read them from these files at evaluation time

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** The goal is to help the user find and apply to roles where there is a genuine match -- not to spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** If a score is below 4.0/5, explicitly recommend against applying. The user's time and the recruiter's time are both valuable. Only proceed if the user has a specific reason to override the score.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50. Guide the user toward fewer, better applications.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (`claude -p`):** Playwright is not available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`. The user can verify manually later.

---

## Stack and Conventions

- Node.js (mjs modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `reports/`
- JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md)
- Batch in `batch/` (gitignored except scripts and prompt)
- Report numbering: sequential 3-digit zero-padded, max existing + 1
- **RULE: After each batch of evaluations, run `node merge-tracker.mjs`** to merge tracker additions and avoid duplications.
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.

### Auto-Apply System

The auto-apply system chains: scan → evaluate → cover letter → apply → track.

**Supported ATS platforms:** Greenhouse (full), Lever (full), Ashby (full), Workday (assisted), iCIMS (assisted).

**Approval modes** (configured in `profiles/{name}/approval-config.yml`):
- `manual` (default): Prepare form, show summary, wait for user confirmation
- `threshold`: Auto-approve above configured score, manual below
- `auto`: Submit automatically (requires explicit user opt-in)

**RULE: Default approval mode is ALWAYS manual.** The ethical guidelines in this document require user review before submission. Auto/threshold modes are power-user opt-ins.

### Job Board Integration

`templates/job-boards.yml` catalogs 130+ job boards across 4 automation tiers:
- **api**: Public/authenticated API (LinkedIn, Indeed, Greenhouse, Lever, Dribbble, USAJobs, Bundesagentur)
- **scrape**: No API but scrape-friendly (specialty boards, StepStone, Kimeta, PraktischArzt)
- **assisted**: Heavy JS or bot detection (Workday, XING, Glassdoor). Playwright + human fallback.
- **manual**: No automation (FlexJobs, Psych Jobs Weekly). RSS/email only.

Each profile's `portals.yml` has `Board —` prefixed search queries for automated discovery via site: filters. German boards are prefixed `Board DE —`. The scanner (modes/scan.md Level 3) executes these queries automatically.

### Job Notification Dispatcher

`job-dispatcher.mjs` sends email notifications to candidates after job evaluation. Uses Gmail SMTP via `Lukas.T@withlukas.com` (nodemailer from Spectrum workspace).

**3-mode routing based on fit score (0-100, mapped from career-ops 0-5 evaluation):**

| career-ops Score | Fit Score | Mode | Action | Email Template |
|-----------------|-----------|------|--------|----------------|
| 4.0-5.0 | 80-100 | Auto-Apply | Submit + confirm | `email-auto-applied.html` |
| 3.0-3.9 | 60-79 | Manual Review | Email + CL PDF attached | `email-manual-review.html` |
| 2.0-2.9 | 40-59 | Approval | Email asking YES/NO + draft CL | `email-approval-request.html` |
| <2.0 | <40 | Skip | Log only | None |

**Fit score dimensions (when full data available):** Industry (20), Role (20), Location (15), Company (15), Compensation (15), Benefits (5), Remote (5), Visa (5) = 100 total.

**Reply handling:** Candidate replies APPLIED, SKIP, AUTO, YES, NO, MAYBE LATER. Claude parses replies during session and updates tracker.

**RULE: Auto-apply requires explicit opt-in consent.** By default, `auto_apply_consent: false` in every profile. Jobs scoring 80+ are downgraded to Manual Review (email with cover letter attached, candidate applies manually). To enable auto-apply:

```bash
node job-dispatcher.mjs --enable-auto-apply --profile={name}         # shows terms
node job-dispatcher.mjs --enable-auto-apply --profile={name} --confirm  # writes consent
node job-dispatcher.mjs --disable-auto-apply --profile={name}        # revokes consent
```

**RULE: Claude must NEVER enable auto-apply consent on behalf of the user.** The user must run the consent command themselves. Even when auto-apply consent is enabled, the `mode` setting in approval-config.yml still controls the form-filling behavior (manual/threshold/auto).

**Cover letters** are generated per-application using the adaptive framing from `_profile.md` and proof points from `cv.md`. Output to `profiles/{name}/cover-letters/`.

### Document Localization & Sponsorship Detection

`localize-detect.mjs` runs a 5-step analysis on every job posting before document generation:

1. **Location detection** — Germany vs USA vs unclear (domain, language, currency, city signals)
2. **Document format** — Lebenslauf (German) vs Resume (US) vs Both
3. **Cover letter language** — Bewerbungsschreiben (German) vs Business Letter (English)
4. **Sponsorship detection** — 4-tier keyword matching (informational only, all candidates are dual citizens)
5. **Military base detection** — Bundeswehr, NATO, US military civilian positions

**Lebenslauf rules:**
- Use existing `profiles/{name}/cv-de.md` if it exists (Lamin has one, Paulina does not)
- If cv-de.md is missing, auto-generate from cv.md
- **ALWAYS attach the English CV (cv.md) as secondary for German jobs** where the application allows

**Email attachment rule:** If Resume and/or Lebenslauf are auto-generated for a job posting, attach them to the notification email regardless of mode (Auto-Apply, Manual Review, or Approval). The dispatcher accepts `cvPdfPath`, `cvDePdfPath`, `cvEnPdfPath`, and `coverLetterPath`.

**RULE: Run localization BEFORE cover letter generation.** It determines language, format, and page size. See `modes/localize.md` and `auto-pipeline.md` Paso 4.5.

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 9 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

**Column order (IMPORTANT -- status BEFORE score):**
1. `num` -- sequential number (integer)
2. `date` -- YYYY-MM-DD
3. `company` -- short company name
4. `role` -- job title
5. `status` -- canonical status (e.g., `Evaluated`)
6. `score` -- format `X.X/5` (e.g., `4.2/5`)
7. `pdf` -- `✅` or `❌`
8. `report` -- markdown link `[num](reports/...)`
9. `notes` -- one-line summary

**Note:** In applications.md, score comes BEFORE status. The merge script handles this column swap automatically.

### Pipeline Integrity

1. **NEVER edit applications.md to ADD new entries** -- Write TSV in `batch/tracker-additions/` and `merge-tracker.mjs` handles the merge.
2. **YES you can edit applications.md to UPDATE status/notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node verify-pipeline.mjs`
6. Normalize statuses: `node normalize-statuses.mjs`
7. Dedup: `node dedup-tracker.mjs`

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)
