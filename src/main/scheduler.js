// Simple scheduler: jobs run either every N minutes or daily at HH:MM.
// On fire, the callback creates a fresh session and sends the prompt.
const store = require('./store');

let timer = null;
let onFire = null; // (job) => void

function computeNextRun(job, now) {
  if (job.everyMinutes && job.everyMinutes > 0) {
    const base = job.lastRunAt || now;
    return base + job.everyMinutes * 60 * 1000;
  }
  if (job.hour != null && job.minute != null) {
    const d = new Date(now);
    d.setHours(job.hour, job.minute, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return Infinity;
}

function tick() {
  const now = Date.now();
  const jobs = store.listCronJobs();
  let changed = false;
  for (const job of jobs) {
    if (!job.enabled) continue;
    const next = computeNextRun(job, now);
    // daily jobs: fire when within the past minute and not already run today
    if (job.everyMinutes && job.everyMinutes > 0) {
      if (!job.lastRunAt || now - job.lastRunAt >= job.everyMinutes * 60 * 1000) {
        job.lastRunAt = now; changed = true;
        if (onFire) onFire(job);
      }
    } else if (next !== Infinity) {
      const scheduledToday = new Date(now); scheduledToday.setHours(job.hour, job.minute, 0, 0);
      const t = scheduledToday.getTime();
      if (now >= t && now - t < 90 * 1000 && (!job.lastRunAt || job.lastRunAt < t)) {
        job.lastRunAt = now; changed = true;
        if (onFire) onFire(job);
      }
    }
  }
  if (changed) store.saveCronJobs(jobs);
}

function start(fireCallback) {
  onFire = fireCallback;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 30 * 1000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function listJobs() { return store.listCronJobs(); }

function saveJob(job) {
  const jobs = store.listCronJobs();
  if (!job.id) job.id = 'job_' + Date.now().toString(36);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = { ...jobs[i], ...job };
  else jobs.push(job);
  store.saveCronJobs(jobs);
  return job.id;
}

function deleteJob(id) {
  store.saveCronJobs(store.listCronJobs().filter((j) => j.id !== id));
}

module.exports = { start, stop, listJobs, saveJob, deleteJob };
