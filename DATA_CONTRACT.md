# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `article-digest.md` | Your proof points from portfolio |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `data/applications.md` | Your application tracker |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `jds/*` | Your saved job descriptions |
| `data/apply-log.md` | Application submission log |
| `profiles/{name}/cover-letters/*` | Generated cover letter PDFs |
| `profiles/{name}/approval-config.yml` | Auto-apply approval settings |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/oferta.md` | Evaluation mode instructions |
| `modes/pdf.md` | PDF generation instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contacto.md` | LinkedIn outreach instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/ofertas.md` | Comparison instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `modes/de/*` | German language modes |
| `CLAUDE.md` | Agent instructions |
| `*.mjs` | Utility scripts |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `modes/cover-letter.md` | Cover letter generation mode |
| `modes/auto-apply.md` | Auto-apply orchestrator mode |
| `modes/report.md` | Application reporting mode |
| `templates/cover-letter-template.html` | Cover letter HTML template |
| `templates/approval-config.example.yml` | Approval config example |
| `ats-adapters.mjs` | ATS platform adapters |
| `generate-cover-letter.mjs` | Cover letter PDF generator |
| `templates/job-boards.yml` | Job boards registry (130+ boards, automation tiers) |
| `arbeitsagentur-api.mjs` | Bundesagentur für Arbeit API scanner |
| `usajobs-api.mjs` | USAJobs.gov federal job scanner |
| `job-dispatcher.mjs` | 3-mode notification dispatcher |
| `templates/email-auto-applied.html` | Auto-apply confirmation email |
| `templates/email-manual-review.html` | Manual review email with CL attachment |
| `templates/email-approval-request.html` | Approval request email with draft CL |
| `localize-detect.mjs` | Document localization & sponsorship detection |
| `modes/localize.md` | Localization mode instructions |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
