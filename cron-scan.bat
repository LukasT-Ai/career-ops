@echo off
REM Career-Ops Every-2-Day Scanner — Windows Task Scheduler
REM Runs all scanners for Paulina + Lamin (Josephina paused).
REM
REM Sources (in order):
REM   1. Bundesagentur fuer Arbeit API  (FREE, unlimited — Germany jobs)
REM   2. USAJobs.gov API               (FREE, unlimited — US federal jobs)
REM   3. Board Scanner: Brave API       (PAID, $5/1000, budget-capped $25/profile/month)
REM      + Bing Playwright fallback     (FREE, slower)
REM      + Greenhouse/Lever ATS APIs    (FREE, direct company job boards)
REM   4. Claude WebSearch               (site: queries for LinkedIn, Indeed, StepStone, etc.)
REM      + Job evaluation + cover letter generation + email dispatch
REM
REM Budget: $50/month total, $25/profile (5,000 Brave queries each)
REM
REM To install (every 2 days at 7:43 AM):
REM   schtasks /create /tn "Career-Ops Scan" /tr "C:\Users\Lukas\career-ops\cron-scan.bat" /sc daily /mo 2 /st 07:43 /f
REM
REM To remove:
REM   schtasks /delete /tn "Career-Ops Scan" /f

cd /d C:\Users\Lukas\career-ops

echo ============================================
echo Career-Ops Scan — %date% %time%
echo Profiles: Paulina + Lamin (Josephina paused)
echo ============================================

REM Step 1: Run API scanners + Board Scanner for Paulina and Lamin
REM Free sources (BA + USAJobs) run first, then Brave (budget-capped)
node scan-all.mjs --limit=25

REM Step 2: Claude runs web search evaluation + email dispatch
REM Claude uses WebSearch for site: queries across all job boards
REM Then evaluates new jobs, generates cover letters/CVs, dispatches emails
claude -p "You are running Career-Ops automated scan. Read C:/Users/Lukas/career-ops/CLAUDE.md and C:/Users/Lukas/career-ops/modes/scan.md for full instructions. Execute for EACH active profile (paulina, lamin — josephina is PAUSED, skip her): PHASE 1 - WEB SEARCH SCAN: (a) Switch to the profile by writing profiles/active.yml and syncing files to root. (b) Read that profile's portals.yml. (c) Execute EVERY search_queries entry with enabled:true using WebSearch. Include all site: queries (LinkedIn, Indeed, Monster, StepStone, Kimeta, and all Board/Board DE entries). Ensure 50/50 balance between US and German job markets. (d) For each result, extract title+company+URL, filter by title_filter, dedup against pipeline+scan-history+applications. (e) Add new jobs to data/pipeline.md and log to data/scan-history.tsv. PHASE 2 - EVALUATE NEW JOBS: (f) For each unchecked entry (- [ ]) in data/pipeline.md (up to 10 per profile): navigate to URL with browser_navigate+browser_snapshot or WebFetch. Run full evaluation per modes/oferta.md. Run localization via localize-detect.mjs. If score >= 3.5: generate cover letter (language per localization). Generate CV/Lebenslauf PDF. Save report. Mark as - [x]. PHASE 3 - DISPATCH EMAILS: (g) For each evaluated job with score >= 2.0, call dispatch() from job-dispatcher.mjs with all document paths. All docs must be attached to notification emails. PHASE 4 - SYNC BACK: (h) Sync data/ reports/ output/ back to profiles/{name}/. After both profiles: restore original active profile. Output summary: per profile — new jobs found, evaluated, emails sent."

echo ============================================
echo Scan complete — %date% %time%
echo ============================================
