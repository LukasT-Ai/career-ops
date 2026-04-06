@echo off
REM Career-Ops Daily Scanner — Windows Task Scheduler
REM Runs API scanners + Claude for web search, evaluation, and email dispatch.
REM
REM To install as a scheduled task:
REM   schtasks /create /tn "Career-Ops Daily Scan" /tr "C:\Users\Lukas\career-ops\cron-scan.bat" /sc daily /st 07:43 /f
REM
REM To remove:
REM   schtasks /delete /tn "Career-Ops Daily Scan" /f

cd /d C:\Users\Lukas\career-ops

echo ============================================
echo Career-Ops Daily Scan — %date% %time%
echo ============================================

REM Step 1: Run API scanners for all 3 profiles (Node.js, no AI needed)
REM This covers: Bundesagentur fuer Arbeit API (Germany) + USAJobs API (USA)
node scan-all.mjs --limit=50

REM Step 2: Claude runs ALL remaining sources + evaluates + sends emails
REM Claude uses WebSearch for site: queries (LinkedIn, Indeed, Monster, StepStone,
REM all German boards, all specialty boards — 126 queries across 3 profiles)
REM Then evaluates new jobs, generates cover letters/resumes, and dispatches emails
claude -p "You are running Career-Ops daily automated scan. Read C:/Users/Lukas/career-ops/CLAUDE.md and C:/Users/Lukas/career-ops/modes/scan.md for full instructions. Execute this sequence for EACH profile (paulina, lamin, josephina): PHASE 1 - WEB SEARCH SCAN: (a) Switch to the profile by writing profiles/active.yml and syncing files to root. (b) Read that profile's portals.yml. (c) Execute EVERY search_queries entry with enabled:true using WebSearch. This includes all site:linkedin.com, site:indeed.com, site:monster.com, site:stepstone.de, site:kimeta.de, and all other site: queries (Board and Board DE entries). (d) For each search result, extract title+company+URL, filter by title_filter from portals.yml, dedup against data/pipeline.md + data/scan-history.tsv + data/applications.md. (e) Add new jobs to data/pipeline.md and log to data/scan-history.tsv. PHASE 2 - EVALUATE NEW JOBS: (f) For each unchecked entry (- [ ]) in data/pipeline.md (up to 10 per profile): navigate to the URL with browser_navigate+browser_snapshot or WebFetch to read the full JD. Run full evaluation per modes/oferta.md (blocks A-F). Run localization: import analyzeJob from localize-detect.mjs. If score >= 3.5: generate cover letter per modes/cover-letter.md respecting localization language/format. If German job and needs Lebenslauf: generate from cv.md if cv-de.md missing. Generate CV PDF per modes/pdf.md. Save report to profiles/{name}/reports/. Mark pipeline entry as - [x]. PHASE 3 - DISPATCH EMAILS: (g) For each evaluated job with score >= 2.0, call dispatch() from job-dispatcher.mjs with all document paths (coverLetterPath, cvPdfPath, cvDePdfPath, cvEnPdfPath). All generated documents must be attached to notification emails. PHASE 4 - SYNC BACK: (h) Copy data/pipeline.md, data/scan-history.tsv, data/applications.md back to profiles/{name}/data/. Copy new reports and PDFs to profiles/{name}/reports/ and profiles/{name}/output/. After all 3 profiles: restore original active profile. Output summary: per profile — new jobs found, evaluated, emails sent."

echo ============================================
echo Scan complete.
echo ============================================
