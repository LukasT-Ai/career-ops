# Mode: cover-letter — Generate a Tailored Cover Letter

## When to Use

User asks to write a cover letter, or says "cover letter for [company/role]".

## Pipeline

### Step 1: Gather Context

1. Read `cv.md` — source of truth for experience, achievements, metrics
2. Read `modes/_profile.md` — archetype table, adaptive framing, narrative
3. Read `config/profile.yml` — name, email, phone, linkedin, location
4. If `article-digest.md` exists, read it for detailed proof points

### Step 2: Get the Job Description

Source the JD in priority order:
1. **From an evaluation report** — if the user references a report number (e.g., "cover letter for #042"), read `reports/{num}-*.md` and extract the JD, company, role, and Section B (Strategic Fit) + Section G (Application Strategy) for tailored content
2. **From a URL** — use Playwright to navigate and extract the JD text
3. **From pasted text** — use what the user provides directly
4. **From a local file** — `local:jds/{file}` path

### Step 3: Analyze the JD

1. **Detect language** — EN or DE. Generate the letter in the JD's language.
2. **Detect location** — US/Canada → letter format (8.5in). Else → A4 (210mm).
3. **Detect archetype** — match the role to the archetype table in `_profile.md`. This determines framing.
4. **Extract top 3-5 requirements** — the skills/experiences the JD emphasizes most.
5. **Read the adaptive framing table** in `_profile.md` to know WHAT to emphasize for this archetype.

### Step 4: Select Proof Points

From `cv.md` (and `article-digest.md` if available), select:
- **1 strong opener proof point** — a quantified achievement that directly matches the JD's #1 requirement
- **3-4 body proof points** — achievements with metrics that map to the JD's top requirements
- **1 forward-looking element** — how the candidate's trajectory aligns with this specific role

If an evaluation report exists (Step 2, option 1), use:
- **Section B (Strategic Fit)** — which strengths to highlight
- **Section G (Application Strategy)** — specific angles and talking points

### Step 5: Write the Cover Letter

Follow this structure strictly. Target ~300-350 words total.

#### Opening (2-3 sentences)
- Lead with a specific, quantified proof point that matches the JD's top requirement
- Name the company and role explicitly
- Show you understand what the company does (from JD context)
- NO generic "I am writing to express my interest" openings

#### Body (2-3 short paragraphs)
- Each paragraph maps 1-2 JD requirements to a specific CV achievement
- Use metrics: percentages, dollar amounts, team sizes, timelines
- Connect achievements to the company's needs (not just listing accomplishments)
- Use the framing from the archetype table — emphasize what matters for this role type
- Keep paragraphs to 3-4 sentences max

#### Close (2 sentences)
- Forward-looking: what you will bring to THIS specific role
- Clear call to action (interview request)
- NO "Thank you for your time and consideration" cliches

### Step 6: Determine Salutation

- If `{{HIRING_MANAGER}}` is known (from JD, report, or user input): "Dear [Name],"
- If unknown but team is known: "Dear [Team] Hiring Team,"
- Fallback EN: "Dear Hiring Manager,"
- Fallback DE: "Sehr geehrte Damen und Herren,"

### Step 7: Determine Closing Phrase

- EN: "Sincerely," or "Best regards,"
- DE: "Mit freundlichen Gruessen,"

### Step 8: Fill the HTML Template

Read `templates/cover-letter-template.html` and replace all placeholders:

| Placeholder | Source |
|-------------|--------|
| `{{LANG}}` | `en` or `de` (from JD language detection) |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) or `210mm` (A4) |
| `{{NAME}}` | `config/profile.yml` → name |
| `{{EMAIL}}` | `config/profile.yml` → email |
| `{{PHONE}}` | `config/profile.yml` → phone |
| `{{LINKEDIN}}` | `config/profile.yml` → linkedin |
| `{{LOCATION}}` | `config/profile.yml` → location |
| `{{DATE}}` | Today's date, formatted per locale (e.g., "April 6, 2026" or "6. April 2026") |
| `{{COMPANY}}` | Company name from JD |
| `{{ROLE}}` | Role title from JD |
| `{{HIRING_MANAGER}}` | Hiring manager name if known, or "Dear Hiring Manager," |
| `{{BODY}}` | The generated letter content as `<p>` tags |

### Step 9: Generate PDF

1. Write the filled HTML to `/tmp/cl-{name}-{company}.html`
2. Run: `node generate-cover-letter.mjs /tmp/cl-{name}-{company}.html output/cl-{name}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`
3. Verify output is 1 page. If >1 page, trim content and regenerate.

### Step 10: Save and Copy

1. PDF lands in `output/cl-{name}-{company}-{YYYY-MM-DD}.pdf`
2. Copy to `profiles/{active-profile}/cover-letters/cl-{name}-{company}-{YYYY-MM-DD}.pdf`
3. Report to user: file path, page count, word count

## Quality Rules

- **NEVER fabricate achievements.** Every claim must trace back to `cv.md` or `article-digest.md`.
- **NEVER use generic filler.** Every sentence must be specific to the company + role.
- **Metrics are mandatory.** At least 3 quantified results in the letter.
- **No dashes/hyphens in the letter body** — they can trigger AI detection filters.
- **Match the JD's tone.** Startup JD → slightly more energetic. Enterprise JD → more structured.
- **1 page max.** If the PDF exceeds 1 page, cut content. Never shrink font size.
- **ATS-friendly.** Plain text content, no images, no tables in the letter body.

## German (DE) Adjustments

When generating a German cover letter:
- Use formal register (Sie-Form)
- Date format: "6. April 2026"
- Closing: "Mit freundlichen Gruessen,"
- Section the letter as: Einleitung, Hauptteil, Schluss
- Reference German-specific terms if relevant (e.g., Berufserfahrung, Festanstellung)
- Use `cv-de.md` if it exists, otherwise translate proof points from `cv.md`
