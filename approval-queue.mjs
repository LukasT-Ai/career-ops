#!/usr/bin/env node

/**
 * approval-queue.mjs — Application Approval Queue
 *
 * Manages the approve/skip workflow for auto-apply:
 * 1. add()     — adds evaluated job to queue after score >= 4.0
 * 2. list()    — shows pending approvals
 * 3. approve() — marks job as approved for submission
 * 4. skip()    — marks job as skipped
 * 5. notify()  — sends email digest of pending approvals
 *
 * Queue stored in: profiles/{name}/data/approval-queue.json
 *
 * Usage:
 *   node approval-queue.mjs list [--profile=name]
 *   node approval-queue.mjs approve <id> [--profile=name]
 *   node approval-queue.mjs approve-all [--profile=name]
 *   node approval-queue.mjs skip <id> [--profile=name]
 *   node approval-queue.mjs notify [--profile=name]
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Queue Operations ─────────────────────────────────────────

async function loadQueue(profileName) {
  const queuePath = resolve(__dirname, 'profiles', profileName, 'data', 'approval-queue.json');
  try {
    const raw = await readFile(queuePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { items: [], lastNotified: null };
  }
}

async function saveQueue(profileName, queue) {
  const dir = resolve(__dirname, 'profiles', profileName, 'data');
  await mkdir(dir, { recursive: true });
  const queuePath = resolve(dir, 'approval-queue.json');
  await writeFile(queuePath, JSON.stringify(queue, null, 2), 'utf8');
}

export async function addToQueue(profileName, job) {
  const queue = await loadQueue(profileName);

  // Dedup by URL
  if (queue.items.some(i => i.url === job.url)) {
    return { added: false, reason: 'already_in_queue' };
  }

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    addedAt: new Date().toISOString(),
    status: 'pending', // pending | approved | skipped | submitted | failed
    url: job.url,
    company: job.company,
    title: job.title,
    location: job.location || '',
    score: job.score || 0,
    ats: detectATS(job.url),
    resumePath: job.resumePath || null,
    coverLetterPath: job.coverLetterPath || null,
    reportPath: job.reportPath || null,
    submittedAt: null,
    error: null,
  };

  queue.items.push(item);
  await saveQueue(profileName, queue);
  return { added: true, id: item.id };
}

export async function listQueue(profileName, statusFilter = null) {
  const queue = await loadQueue(profileName);
  if (statusFilter) {
    return queue.items.filter(i => i.status === statusFilter);
  }
  return queue.items;
}

export async function approveItem(profileName, itemId) {
  const queue = await loadQueue(profileName);
  const item = queue.items.find(i => i.id === itemId);
  if (!item) return { success: false, reason: 'not_found' };
  item.status = 'approved';
  await saveQueue(profileName, queue);
  return { success: true };
}

export async function approveAll(profileName) {
  const queue = await loadQueue(profileName);
  let count = 0;
  for (const item of queue.items) {
    if (item.status === 'pending') {
      item.status = 'approved';
      count++;
    }
  }
  await saveQueue(profileName, queue);
  return { count };
}

export async function skipItem(profileName, itemId) {
  const queue = await loadQueue(profileName);
  const item = queue.items.find(i => i.id === itemId);
  if (!item) return { success: false, reason: 'not_found' };
  item.status = 'skipped';
  await saveQueue(profileName, queue);
  return { success: true };
}

export async function markSubmitted(profileName, itemId, success, error = null) {
  const queue = await loadQueue(profileName);
  const item = queue.items.find(i => i.id === itemId);
  if (!item) return;
  item.status = success ? 'submitted' : 'failed';
  item.submittedAt = new Date().toISOString();
  item.error = error;
  await saveQueue(profileName, queue);
}

function detectATS(url) {
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/lever\.co/i.test(url)) return 'lever';
  return 'unknown';
}

// ── Email Notification ───────────────────────────────────────

export async function notifyPending(profileName) {
  const queue = await loadQueue(profileName);
  const pending = queue.items.filter(i => i.status === 'pending');
  if (pending.length === 0) {
    console.log('  No pending approvals to notify about.');
    return;
  }

  // Load candidate email
  const ymlPath = resolve(__dirname, 'profiles', profileName, 'profile.yml');
  const yml = await readFile(ymlPath, 'utf8');
  const emailMatch = yml.match(/email:\s*"?([^"\n]+)"?/);
  const toEmail = emailMatch ? emailMatch[1].trim() : null;

  if (!toEmail) {
    console.log('  No candidate email found in profile.yml');
    return;
  }

  // Build email body
  const lines = pending.map((item, i) => {
    const ats = item.ats === 'greenhouse' ? '[GH]' : item.ats === 'lever' ? '[LV]' : '[??]';
    return `${i + 1}. ${ats} ${item.company} — ${item.title}\n   Score: ${item.score}/5 | ${item.location}\n   ${item.url}`;
  }).join('\n\n');

  const body = `Career-Ops: ${pending.length} application(s) ready for your approval.\n\n${lines}\n\nTo approve all, reply APPROVE ALL.\nTo approve specific ones, reply with the numbers (e.g., "1, 3, 5").\nTo skip, reply SKIP ALL or specific numbers.\n\nOr use the dashboard: https://lukast-ai.github.io/career-ops/`;

  console.log(`  Would notify ${toEmail} about ${pending.length} pending application(s)`);
  console.log(`  Subject: Career-Ops: ${pending.length} applications ready for approval`);
  console.log(`  Body preview:\n${body.slice(0, 500)}...`);

  // TODO: integrate with job-dispatcher.mjs email sending
  // For now, just update lastNotified
  queue.lastNotified = new Date().toISOString();
  await saveQueue(profileName, queue);
}

// ── CLI ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const profileArg = args.find(a => a.startsWith('--profile='));

  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
  }

  switch (command) {
    case 'list': {
      const items = await listQueue(profileName);
      console.log(`\n  Approval Queue — ${profileName} (${items.length} items)`);
      console.log(`  ${'━'.repeat(50)}`);
      const groups = { pending: [], approved: [], submitted: [], skipped: [], failed: [] };
      for (const item of items) {
        (groups[item.status] || groups.pending).push(item);
      }
      for (const [status, group] of Object.entries(groups)) {
        if (group.length === 0) continue;
        console.log(`\n  ${status.toUpperCase()} (${group.length}):`);
        for (const item of group) {
          const ats = item.ats === 'greenhouse' ? '[GH]' : item.ats === 'lever' ? '[LV]' : '[??]';
          console.log(`    ${item.id} ${ats} ${item.company} — ${item.title} (${item.score}/5)`);
        }
      }
      console.log('');
      break;
    }

    case 'approve': {
      const id = args[1];
      if (!id) { console.log('Usage: node approval-queue.mjs approve <id>'); break; }
      const result = await approveItem(profileName, id);
      console.log(result.success ? `  Approved: ${id}` : `  Not found: ${id}`);
      break;
    }

    case 'approve-all': {
      const result = await approveAll(profileName);
      console.log(`  Approved ${result.count} pending item(s)`);
      break;
    }

    case 'skip': {
      const id = args[1];
      if (!id) { console.log('Usage: node approval-queue.mjs skip <id>'); break; }
      const result = await skipItem(profileName, id);
      console.log(result.success ? `  Skipped: ${id}` : `  Not found: ${id}`);
      break;
    }

    case 'notify': {
      await notifyPending(profileName);
      break;
    }

    default:
      console.log('Usage: node approval-queue.mjs <list|approve|approve-all|skip|notify> [--profile=name]');
  }
}

if (process.argv[1] && process.argv[1].includes('approval-queue')) {
  main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
}
