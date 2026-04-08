@echo off
REM Career-Ops Every-2-Day Scanner — Windows Task Scheduler
REM Runs all scanners for Paulina + Lamin (Josephina paused).
REM
REM Sources (19 scanners via scan-all.mjs):
REM   FREE APIs: Bundesagentur, USAJobs, Adzuna, Jooble, RemoteOK, Remotive, Arbeitnow, The Muse
REM   FREE ATS: Greenhouse, Lever (public board APIs, no auth)
REM   FREE (budget-capped): JSearch (200 req/mo), JobSearch15 (50 req/mo)
REM   FREE scrapers: StepStone.de, XING, Dice, LinkedIn, Indeed
REM   NEW: Doximity (Paulina), PraktischArzt (Paulina), Aerztestellen (Paulina), Telecom Careers (Lamin)
REM   PAID: Board Scanner (Brave API $5/1000, budget-capped $25/profile/month)
REM   DISABLED: Monster (403 anti-scraping)
REM
REM Budget: $50/month Brave API, all other sources FREE
REM
REM Schedule: Every 2 days at 7:43 AM (runs with locked screen)
REM   Installed via: schtasks /create /tn "Career-Ops Scan" /tr "..." /sc daily /mo 2 /st 07:43 /f
REM   Remove via:    schtasks /delete /tn "Career-Ops Scan" /f
REM   Run now:       schtasks /run /tn "Career-Ops Scan"

cd /d C:\Users\Lukas\career-ops

REM Absolute paths for headless Task Scheduler execution
set NODE="C:\Program Files\nodejs\node.exe"
set CLAUDE="%APPDATA%\npm\claude.cmd"
set LOGFILE=C:\Users\Lukas\career-ops\data\scan-log.txt

echo ============================================ >> %LOGFILE%
echo Career-Ops Scan — %date% %time% >> %LOGFILE%
echo ============================================ >> %LOGFILE%

echo ============================================
echo Career-Ops Scan — %date% %time%
echo Profiles: Paulina + Lamin (Josephina paused)
echo ============================================

REM Step 1: Run API scanners + Board Scanner for Paulina and Lamin
echo [%time%] Starting scan-all.mjs... >> %LOGFILE%
%NODE% scan-all.mjs --limit=25 >> %LOGFILE% 2>&1
echo [%time%] scan-all.mjs complete (exit code: %ERRORLEVEL%) >> %LOGFILE%

REM Step 2: Claude runs evaluation + email dispatch headless
echo [%time%] Starting Claude evaluation... >> %LOGFILE%
%CLAUDE% -p "You are running Career-Ops automated scan. Read C:/Users/Lukas/career-ops/CLAUDE.md and C:/Users/Lukas/career-ops/modes/scan.md for full instructions. Execute for EACH active profile (paulina, lamin — josephina is PAUSED, skip her): PHASE 1 - WEB SEARCH SCAN: (a) Switch to the profile by writing profiles/active.yml and syncing files to root. (b) Read that profile's portals.yml. (c) Execute EVERY search_queries entry with enabled:true using WebSearch. Include all site: queries (LinkedIn, Indeed, Monster, StepStone, Kimeta, and all Board/Board DE entries). Ensure 50/50 balance between US and German job markets. (d) For each result, extract title+company+URL, filter by title_filter, dedup against pipeline+scan-history+applications. (e) Add new jobs to data/pipeline.md and log to data/scan-history.tsv. PHASE 2 - EVALUATE NEW JOBS: (f) For each unchecked entry (- [ ]) in data/pipeline.md (up to 10 per profile): navigate to URL with browser_navigate+browser_snapshot or WebFetch. Run full evaluation per modes/oferta.md. Run localization via localize-detect.mjs. If score >= 3.5: generate cover letter (language per localization). Generate CV/Lebenslauf PDF. Save report. Mark as - [x]. PHASE 3 - DISPATCH EMAILS: (g) For each evaluated job with score >= 3.0, call dispatch() from job-dispatcher.mjs with all document paths. All docs must be attached to notification emails. PHASE 4 - SYNC BACK: (h) Sync data/ reports/ output/ back to profiles/{name}/. After both profiles: restore original active profile. Output summary: per profile — new jobs found, evaluated, emails sent." >> %LOGFILE% 2>&1
echo [%time%] Claude evaluation complete (exit code: %ERRORLEVEL%) >> %LOGFILE%

REM Step 3: Generate pipeline dashboard
echo [%time%] Generating dashboard... >> %LOGFILE%
%NODE% generate-dashboard.mjs --no-open >> %LOGFILE% 2>&1
echo [%time%] Dashboard generated >> %LOGFILE%

REM Step 4: Commit results to git
echo [%time%] Committing results... >> %LOGFILE%
git add -A >> %LOGFILE% 2>&1
git commit -m "Automated scan — %date%" >> %LOGFILE% 2>&1
git push origin main >> %LOGFILE% 2>&1
echo [%time%] Git push complete >> %LOGFILE%

echo ============================================ >> %LOGFILE%
echo Scan complete — %date% %time% >> %LOGFILE%
echo ============================================ >> %LOGFILE%
echo. >> %LOGFILE%

echo ============================================
echo Scan complete — %date% %time%
echo ============================================
