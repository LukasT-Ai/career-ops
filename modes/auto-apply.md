# Mode: auto-apply -- Automated Job Application

## Overview

Automates form filling on supported ATS platforms using Playwright browser tools. This mode reads the active profile, loads evaluation context, detects the ATS platform, fills all form fields, handles custom questions, and pauses before submission for human approval.

**This mode NEVER submits without explicit user approval.** It fills forms and stops.

## Supported Platforms

| Platform | Mode | Notes |
|----------|------|-------|
| Greenhouse | Fully automated | Most standardized, single-page form |
| Lever | Fully automated | Single-page, full-name field (not split) |
| Ashby | Fully automated | React SPA, may lazy-load |
| Workday | Assisted-manual | Multi-step wizard, account creation required |
| iCIMS | Assisted-manual | Account creation, iframes, multi-page |
| BambooHR | Assisted-manual | Iframe-heavy |
| SmartRecruiters | Assisted-manual | Multi-step with optional account |

## Prerequisites

Before starting auto-apply, verify ALL of the following:

1. **Evaluation report exists** -- search `reports/` for the company/role. If missing, run auto-pipeline first.
2. **CV PDF exists** in `output/` (or `profiles/{name}/output/`). If missing, run `modes/pdf.md` first.
3. **Cover letter PDF exists** in `output/` or `cover-letters/` (or generate one). If `approval-config.yml` has `require_cover_letter: true` and none exists, STOP and tell the user.
4. **approval-config.yml** has been reviewed -- read `profiles/{name}/approval-config.yml` to determine approval mode.
5. **Profile is synced** -- active profile must be current (check `profiles/active.yml`).

If any prerequisite is missing, tell the user what is needed and offer to generate it.

## Workflow

### Step 1: Load Context

```
1. Read profiles/active.yml to get active profile name
2. Read profiles/{name}/profile.yml for candidate data
3. Read profiles/{name}/approval-config.yml for approval settings
4. Identify the target job URL (user provides it or read from pipeline.md)
5. Find the evaluation report in reports/ (grep company name)
6. Read the full report, especially Section G (draft application answers)
```

### Step 2: Detect ATS Platform

```
1. Import detectATS() from ats-adapters.mjs (conceptually -- read the file)
2. Match the job URL against platform detection patterns
3. If match found → log platform name, proceed with appropriate adapter
4. If no match → fall back to assisted-manual mode (screenshot + paste)
5. Check if platform is fully-automated or assisted-manual
```

### Step 3: Check Approval Gate

Read `profiles/{name}/approval-config.yml`:

- **mode: manual** -- Always pause before filling. Show the user what will be filled and ask for confirmation to proceed with form filling.
- **mode: threshold** -- Check the evaluation score. If score >= threshold, proceed to fill. If below, pause and ask.
- **mode: auto** -- Proceed to fill without pausing (but STILL stop before submit).

Also check per-platform overrides in `approval.platforms`:
```yaml
platforms:
  greenhouse: auto      # override for this platform
  workday: manual       # always manual for workday
```

### Step 4: Navigate to Application Page

**For fully automated platforms:**

```
1. browser_navigate to the job URL
2. browser_snapshot to verify the page loaded and job is still active
3. If the job is closed/expired → STOP, update tracker to "Discarded", notify user
4. Transform URL to apply URL using the platform's applyUrl function
5. browser_navigate to the apply URL (if different)
6. browser_snapshot to verify the application form is visible
7. Wait for form container selector to appear
```

**For assisted-manual platforms:**
```
1. browser_navigate to the job URL
2. browser_snapshot to read the page
3. Tell the user: "This is a [Platform] application. I'll read each step and provide answers for you to paste."
4. Continue with screenshot-based assistance (Step 10)
```

### Step 5: Fill Standard Fields

For each standard field defined in the platform adapter:

```
1. Read field name and selector from ats-adapters.mjs
2. Get the value from profile.yml using getFieldValue mapping:
   - firstName → candidate.full_name (first part)
   - lastName → candidate.full_name (remaining parts)
   - fullName → candidate.full_name (for Lever)
   - email → candidate.email
   - phone → candidate.phone
   - linkedin → candidate.linkedin (add https:// prefix if needed)
   - website → candidate.portfolio_url
   - github → candidate.github
   - location → candidate.location
3. browser_click on the field selector
4. browser_type the value
5. Verify with browser_snapshot that the field was filled correctly
```

**Special handling:**
- If a selector doesn't match, try alternative selectors from the adapter
- If a field is not found, skip it and log a warning
- For phone fields, format as the profile has it (no reformatting)

### Step 6: Upload Resume

```
1. Find the most recent CV PDF in output/ matching the profile name
2. Use the resume file input selector from the adapter
3. browser_click on the file input or its label/button
4. Use browser_file_upload with the PDF path
5. browser_snapshot to verify the upload succeeded (look for filename display)
6. If upload fails, try clicking the dropzone area first, then retry
```

### Step 7: Upload or Paste Cover Letter

```
1. Find the cover letter PDF in output/ or cover-letters/
2. If the platform uses file upload (Greenhouse, Ashby):
   - Use the coverLetter file input selector
   - browser_file_upload with the PDF path
3. If the platform uses textarea (Lever):
   - Read the cover letter text from the markdown source
   - browser_click on the textarea
   - browser_type the cover letter content
4. If no cover letter field exists, skip
5. If cover letter is required by approval-config but missing → STOP and notify
```

### Step 8: Fill Custom Questions

Custom questions are the hardest part. Use the evaluation report Section G as the primary source.

```
For each custom question found on the form:
1. browser_snapshot to read the question text
2. Classify the question type:
   a. WORK_AUTHORIZATION → Use profile.yml visa_status
   b. SALARY_EXPECTATION → Use profile.yml compensation.target_range
   c. START_DATE → Default "2 weeks" or "Immediately" unless report says otherwise
   d. RELOCATION → Use profile.yml location_flexibility
   e. HOW_DID_YOU_HEAR → "Job board" or "Company careers page"
   f. YEARS_EXPERIENCE → Calculate from cv.md experience section
   g. SPONSORSHIP → Use profile.yml visa_status (US+German citizen = No sponsorship needed)
   h. FREE_TEXT → Use Section G draft answers, or generate from report
   i. DROPDOWN → Read all options, select the best match
   j. CHECKBOX → Check boxes that apply based on profile
   k. RADIO → Select the best match based on profile
3. For free-text questions not in Section G:
   - Read the question carefully
   - Generate a response using: report proof points + cv.md achievements + _profile.md framing
   - Keep responses concise (2-4 sentences for short fields, 1-2 paragraphs for long)
   - Use "I'm choosing you" tone from the evaluation framework
4. browser_click on the field
5. browser_type or browser_select the answer
```

**Question-to-Profile Mapping (common patterns):**

| Question Pattern | Source | Example Answer |
|-----------------|--------|----------------|
| "Are you authorized to work in..." | profile.yml visa_status | "Yes" |
| "Will you require sponsorship..." | profile.yml visa_status | "No" (dual citizen) |
| "Salary expectations" | profile.yml compensation | "$135K-180K base" |
| "How did you hear about..." | Default | "Company careers page" |
| "Are you willing to relocate..." | profile.yml location_flexibility | Based on job location |
| "Years of experience in..." | cv.md | Count from experience dates |
| "Why are you interested..." | Report Section B/G | Tailored from evaluation |
| "Describe your experience with..." | Report Section B + cv.md | Specific proof points |

### Step 9: Pre-Submit Review

**This step is MANDATORY regardless of approval mode.**

```
1. browser_snapshot the completed form
2. Present a summary to the user:

   === APPLICATION REVIEW ===
   Profile:  {name}
   Company:  {company}
   Role:     {role}
   Platform: {ATS name}
   Score:    {X.X}/5

   FIELDS FILLED:
   - First Name: {value}
   - Last Name: {value}
   - Email: {value}
   - Phone: {value}
   - Resume: {filename}
   - Cover Letter: {filename or "pasted"}
   - LinkedIn: {url}
   - [Custom Q1]: {answer preview}
   - [Custom Q2]: {answer preview}

   WARNINGS:
   - {any fields that couldn't be filled}
   - {any questions that need human review}

   Ready to submit? (yes/no/edit)

3. Wait for user response:
   - "yes" → proceed to Step 10
   - "no" → stop, log as "Queued" in tracker
   - "edit" → ask which field to change, make the edit, re-snapshot
```

### Step 10: Submit (Only on Explicit Approval)

```
1. browser_click on the submit button using the platform's submitSelector
2. Wait 3 seconds
3. browser_snapshot to check for:
   a. Success message (check platform's successIndicators)
   b. Error messages (validation failures)
   c. CAPTCHA (see Error Handling)
4. If success:
   - Log to data/apply-log.md
   - Update applications.md status to "Applied"
   - Copy updates back to profiles/{name}/data/
   - Tell user: "Application submitted successfully for {role} at {company}"
5. If error:
   - Screenshot the error
   - Tell user what went wrong
   - Offer to fix and retry
```

### Step 11: Assisted-Manual Mode (Workday, iCIMS, etc.)

For platforms that don't support full automation:

```
1. browser_navigate to the URL
2. browser_snapshot each page/step of the application
3. Read all visible fields and questions
4. Generate answers for each field using the same logic as Steps 5-8
5. Present answers in a formatted block for the user to copy-paste:

   === ASSISTED APPLICATION: {Company} - {Role} ===
   Platform: {Workday/iCIMS}

   PAGE 1: Personal Information
   - Full Name: {value}
   - Email: {value}
   - Phone: {value}
   ...

   PAGE 2: Experience
   [Answers for each field]

   PAGE 3: Questions
   Q: "Why are you interested in this role?"
   A: "{generated answer}"

   When you've filled everything, tell me and I'll check the next page.

6. When user confirms each page is done, snapshot the next page
7. Repeat until all pages are complete
8. At the final submit page, remind user to review before clicking Submit
9. After user confirms submission, log to apply-log.md and update tracker
```

### Step 12: Update Tracker

After every application attempt (success or failure):

```
1. Update data/applications.md:
   - If entry exists → update status to "Applied" (or "Queued" if not submitted)
   - If no entry → create TSV in batch/tracker-additions/ and run merge-tracker.mjs
2. Append to data/apply-log.md with full details
3. Copy updated files back to profiles/{name}/data/
```

### Step 13: Post-Apply Actions

After successful submission:
```
1. Suggest: "Want me to draft a LinkedIn connection request for the hiring manager? (modes/contacto)"
2. If there are more queued applications, ask: "You have N more applications queued. Continue with the next one?"
3. Update the report's Section G with final answers used
```

### Step 14: Batch Apply

When the user wants to apply to multiple roles:
```
1. Read data/applications.md for all "Evaluated" entries with score >= threshold
2. Filter to roles with completed reports and CV PDFs
3. Present the list and ask for approval
4. Process each one sequentially using Steps 1-13
5. After all are done, present a summary table
```

## ATS-Specific Instructions

### Greenhouse

```
NAVIGATE:
  1. Go to job URL
  2. If form not visible, append #app to URL and navigate again
  3. Wait for #application or .application-form container

FILL STANDARD:
  4. #first_name ← profile firstName
  5. #last_name ← profile lastName
  6. #email ← profile email
  7. #phone ← profile phone
  8. Upload resume via input[type="file"][name*="resume"]
  9. Upload cover letter via input[type="file"][name*="cover_letter"] (if present)
  10. Fill LinkedIn field if present (input with name containing "linkedin")
  11. Fill website field if present

FILL CUSTOM:
  12. Scan all .field elements below standard fields
  13. For each: read label text, determine answer from report/profile
  14. Handle: text, textarea, select, checkbox, radio

SUBMIT:
  15. Click #submit_app or input[type="submit"]
  16. Check for success: "Thank you for applying" text on page
```

### Lever

```
NAVIGATE:
  1. Go to job URL
  2. Append /apply if not already present
  3. Wait for .application-form container

FILL STANDARD:
  4. input[name="name"] ← profile fullName (SINGLE field, not split)
  5. input[name="email"] ← profile email
  6. input[name="phone"] ← profile phone
  7. Upload resume via .resume-upload input[type="file"]
  8. textarea[name="comments"] ← cover letter TEXT (not PDF)
  9. input[name="urls[LinkedIn]"] ← profile linkedin
  10. input[name="urls[Portfolio]"] ← profile website (if present)
  11. input[name="urls[GitHub]"] ← profile github (if present)
  12. input[name="org"] ← current company (if known)

FILL CUSTOM:
  13. Scan .application-additional for custom fields
  14. For each: read label, determine answer

SUBMIT:
  15. Click button.postings-btn[type="submit"]
  16. Check for success: "Your application has been submitted" text
```

### Ashby

```
NAVIGATE:
  1. Go to job URL
  2. Append /application if not already present
  3. Wait for .ashby-application-form or [data-testid="application-form"]
  4. NOTE: React app -- may need extra wait time for lazy loading

FILL STANDARD:
  5. input[name="_systemfield_first_name"] or [name="firstName"] ← profile firstName
  6. input[name="_systemfield_last_name"] or [name="lastName"] ← profile lastName
  7. input[name="_systemfield_email"] or [type="email"] ← profile email
  8. input[name="_systemfield_phone"] or [type="tel"] ← profile phone
  9. Upload resume via file input
  10. Upload/paste cover letter (check if file or textarea)
  11. Fill LinkedIn, website if fields present

FILL CUSTOM:
  12. Scan .ashby-application-form-field elements for custom questions
  13. System fields use _systemfield_ prefix -- skip those (already filled)
  14. For each custom field: read label, determine answer

SUBMIT:
  15. Click button[type="submit"] or [data-testid="submit-application"]
  16. Check for success indicators
```

## Custom Question Strategies

### Free Text (Short -- under 200 chars)
- Keep it direct and factual
- Example: "10+ years of enterprise sales experience in telecom and UC"

### Free Text (Long -- 200+ chars)
- Use Section G draft if available
- Structure: Hook + Proof Point + Connection to Role
- 2-3 paragraphs max
- Reference specific JD requirements matched to candidate experience

### Dropdowns
- Read ALL options first with browser_snapshot
- Select the closest match
- Common: work authorization, education level, years of experience, referral source

### Checkboxes
- Read labels carefully
- Check all that truthfully apply based on profile
- Never check "agree to relocate" unless profile confirms it

### Radio Buttons
- Similar to dropdowns -- read all options, select best match
- Common: yes/no questions about authorization, sponsorship, disability

### Salary Fields
- Use the profile's compensation.target_range
- If field asks for a single number, use the midpoint
- If dropdown with ranges, select the range containing the target

## Error Handling

### Form Not Found
```
If the application form doesn't appear within 10 seconds:
1. browser_snapshot to see what loaded
2. Check if job is closed (look for "no longer accepting applications")
3. Check if redirected to login page
4. Try refreshing the page
5. If still no form → switch to assisted-manual mode
```

### CAPTCHA Detected
```
If a CAPTCHA appears (reCAPTCHA, hCaptcha, etc.):
1. STOP automation immediately
2. Tell the user: "CAPTCHA detected. Please solve it manually, then tell me to continue."
3. Wait for user confirmation
4. browser_snapshot to verify CAPTCHA is solved
5. Continue from where we left off
```

### Validation Errors
```
If the form shows validation errors after attempted submit:
1. browser_snapshot to read all error messages
2. For each error:
   - Identify which field failed
   - Determine the correct format/value
   - Re-fill the field
3. Re-attempt submit
4. If errors persist after 2 retries → switch to assisted-manual
```

### File Upload Failure
```
If resume/cover letter upload fails:
1. Try clicking the upload area/button first, then use file input
2. Try alternative selectors from the adapter
3. If still fails → tell user to upload manually, continue with other fields
```

### Session Timeout
```
If the page shows a session timeout or redirect:
1. browser_navigate back to the apply URL
2. Check if form data was preserved
3. If lost → re-fill all fields from scratch
4. If preserved → continue from where we left off
```

### Unknown ATS / No Adapter
```
If the URL doesn't match any known ATS:
1. Navigate to the URL
2. browser_snapshot to read the page
3. Look for common form patterns (input fields, file uploads, submit buttons)
4. Attempt to fill using generic selectors
5. If form is too complex → switch to assisted-manual mode
6. Log the ATS URL pattern for future adapter creation
```

## Logging Format

Every application attempt is logged in `data/apply-log.md`:

```
| Date | Time | Profile | Company | Role | ATS | Action | Score | CL | CV | Status | Notes |
```

- **Date**: YYYY-MM-DD
- **Time**: HH:MM (24h, local time)
- **Profile**: Active profile name
- **Company**: Company name
- **Role**: Job title
- **ATS**: Platform name (Greenhouse, Lever, etc.)
- **Action**: fill-only, submitted, assisted, skipped
- **Score**: X.X/5 from evaluation
- **CL**: yes/no (cover letter included)
- **CV**: yes/no (CV uploaded)
- **Status**: success, error, captcha, timeout, manual
- **Notes**: Brief note about outcome

## Safety Rules

1. **NEVER submit without explicit user approval** -- even in auto mode, the submit click requires confirmation.
2. **NEVER apply to a role scored below 3.5/5** without the user explicitly overriding.
3. **NEVER fabricate information** -- all answers must come from profile.yml, cv.md, or the evaluation report.
4. **NEVER check a checkbox claiming something untrue** (disability, veteran status, etc.) -- leave unknown demographics blank or select "prefer not to answer".
5. **ALWAYS verify the job is still open** before starting the form fill.
6. **ALWAYS log the attempt** in apply-log.md, even if it fails.
7. **ALWAYS save back** to the profile directory after any data changes.
8. **Respect rate limits** -- if applying to multiple roles, wait at least 30 seconds between applications.
