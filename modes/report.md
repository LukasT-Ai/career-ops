# Mode: report -- Application Status Summary

## Overview

Generates a comprehensive application status report by reading the tracker, apply log, and pipeline data. Provides counts, breakdowns, and actionable next steps.

## When to Use

- User asks "how are my applications going?"
- User says "report", "status", "summary", or "dashboard"
- After a batch of evaluations or applications
- Weekly check-in on job search progress

## Workflow

### Step 1: Load Data

```
1. Read profiles/active.yml to get active profile name
2. Read data/applications.md (the main tracker)
3. Read data/apply-log.md (detailed submission log)
4. Read data/pipeline.md (pending URLs)
5. Read profiles/{name}/approval-config.yml (approval settings)
6. Count files in reports/ for the active profile
```

### Step 2: Parse Tracker

Parse the applications.md table. For each row extract:
- Number, Date, Company, Role, Score, Status, PDF, Report link, Notes

### Step 3: Generate Counts

#### By Status
Count entries for each canonical state (from templates/states.yml):
- Evaluated -- report done, pending decision
- Queued -- application prepared, awaiting approval
- CL Generated -- cover letter ready, not yet applied
- Applied -- application submitted
- Responded -- company responded
- Interview -- in interview process
- Offer -- offer received
- Rejected -- rejected by company
- Discarded -- discarded by candidate or closed
- SKIP -- doesn't fit

#### By ATS Platform
Read apply-log.md and count by ATS column:
- Greenhouse, Lever, Ashby, Workday, iCIMS, Other/Unknown

#### By Score Band
Group evaluation scores:
- 4.5-5.0 (Excellent fit)
- 4.0-4.4 (Strong fit)
- 3.5-3.9 (Moderate fit)
- 3.0-3.4 (Weak fit)
- Below 3.0 (Poor fit)

### Step 4: Recent Activity (Last 7 Days)

Filter tracker entries with dates in the last 7 days. Show:
- New evaluations
- Applications submitted
- Status changes
- New pipeline additions

### Step 5: Pending Actions

Identify items that need attention:
1. **High-score unapplied** -- Score >= 4.0 with status "Evaluated" (should apply soon)
2. **Queued for approval** -- Status "Queued" (ready to submit, needs OK)
3. **Cover letter needed** -- Status "CL Generated" is missing or "Evaluated" roles where approval-config requires CL
4. **Unprocessed pipeline** -- URLs in pipeline.md not yet evaluated
5. **Stale applications** -- Applied 14+ days ago with no status update
6. **Interview prep needed** -- Status "Interview" without prep notes

### Step 6: Output Format

Present the report as a formatted markdown summary:

```markdown
# Application Report: {Profile Name}
Generated: {YYYY-MM-DD HH:MM}

## Summary

| Metric | Count |
|--------|-------|
| Total tracked | {n} |
| Evaluated | {n} |
| Queued | {n} |
| Applied | {n} |
| Interview | {n} |
| Offer | {n} |
| Rejected | {n} |
| Discarded/SKIP | {n} |
| Pipeline (unprocessed) | {n} |

## Score Distribution

| Band | Count | Pct |
|------|-------|-----|
| 4.5-5.0 (Excellent) | {n} | {%} |
| 4.0-4.4 (Strong) | {n} | {%} |
| 3.5-3.9 (Moderate) | {n} | {%} |
| 3.0-3.4 (Weak) | {n} | {%} |
| < 3.0 (Poor) | {n} | {%} |

## ATS Breakdown

| Platform | Applications |
|----------|-------------|
| Greenhouse | {n} |
| Lever | {n} |
| Ashby | {n} |
| Workday | {n} |
| Other | {n} |

## Recent Activity (Last 7 Days)

| Date | Company | Role | Action |
|------|---------|------|--------|
| {date} | {company} | {role} | {what happened} |

## Pending Actions

### High-Score Unapplied (Score >= 4.0)
- [ ] {Company} - {Role} ({Score}/5) -- evaluated {date}

### Queued for Approval
- [ ] {Company} - {Role} -- ready to submit

### Needs Cover Letter
- [ ] {Company} - {Role} -- CL required by approval config

### Unprocessed Pipeline
- {n} URLs in pipeline.md awaiting evaluation

### Stale Applications (14+ days, no update)
- [ ] {Company} - {Role} -- applied {date}, no response

## Recommendations

{1-3 actionable suggestions based on the data, such as:}
- "You have 5 high-score roles unapplied. Consider running batch apply."
- "3 applications are 14+ days old with no response. Consider follow-up or LinkedIn outreach."
- "Pipeline has 12 unprocessed URLs. Run /career-ops pipeline to evaluate them."
```

## Notes

- This mode is READ-ONLY -- it does not modify any data files.
- If the tracker is empty, say so and suggest next steps (scan, paste a URL, etc.).
- Always use the active profile's data, never mix profiles.
- Score percentages should be rounded to nearest integer.
- The report can be saved to `reports/status-{date}.md` if the user requests it.
