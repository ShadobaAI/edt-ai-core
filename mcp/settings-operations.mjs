import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitize_setup_result, safe_error_message } from "../scripts/diagnostics.mjs";
import { inside } from "../scripts/common.mjs";
import { begin_foreground_readiness, activate_foreground_readiness, release_foreground_readiness, capture_readiness_priority } from "../scripts/setup_readiness.mjs";
import { path_identity } from "../scripts/project_paths.mjs";

// A transport deadline is not cancellation. Keep ownership and the eventual
// result of a running mutation; status polling never starts another backend.
export class SettingsOperations {
  constructor(run, observe = () => {}, { stateDirectory = null } = {}) {
    this.run = run;
    this.observe = observe;
    this.jobs = new Map();
    this.active = null;
    this.background = null;
    this.lastCompleted = null;
    this.stateDirectory = stateDirectory;
  }

  start(action, args, context) {
    const background = action === "refresh_readiness";
    const overlap = background && ["rebuild_index", "restart_index", "updates", "check"].includes(this.active?.action);
    if (this.active?.status === "running" && !overlap || (background && this.background?.status === "running")) {
      throw new Error(`Операция ${this.current().id} ещё выполняется. Проверьте settings.operation; повтор не запущен.`);
    }
    // Signal an older background process synchronously, before dispatching a
    // foreground job. It checks this marker while holding the state lock, so
    // process scheduling cannot let it steal the foreground's tickets.
    const sameBackgroundScope = !this.background?.projectRoot || !context.projectRoot || path_identity(this.background.projectRoot) === path_identity(context.projectRoot);
    const sameBackgroundInstance = !this.background?.instance || !context.instance || this.background.instance === context.instance;
    if (!background && this.stateDirectory && this.background?.status === "running" && sameBackgroundScope && sameBackgroundInstance) {
      const marker = inside(this.stateDirectory, path.join(".settings-refresh-cancel", this.background.id));
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "cancelled", { mode: 0o600 });
    }
    const job = { id: randomUUID(), action, ...context, ...(["probe", "refresh_readiness"].includes(action) && args.component ? { component: args.component } : {}),
      ...(["rebuild_index", "restart_index"].includes(action) ? { component: "code-index", ...(args.all === true ? { all: true } : {}) } : {}), status: "running", startedAt: new Date().toISOString() };
    const scope = this.stateDirectory && context.projectRoot && context.instance ? { root: path_identity(context.projectRoot), instance: context.instance } : null;
    const priority = background && scope ? { ...scope, ...capture_readiness_priority(this.stateDirectory, scope.root, scope.instance) } : null;
    const foregroundLease = !background && scope && ["check", "probe"].includes(action)
      ? begin_foreground_readiness(this.stateDirectory, scope.root, scope.instance, job.id) : null;
    this.observe("operation_started", { id: job.id, action, ...context });
    if (background) this.background = job;
    else this.active = job;
    this.jobs.set(job.id, job);
    // Bound retained results, without discarding a running operation.
    while (this.jobs.size > 16) {
      const oldest = [...this.jobs].find(([, item]) => item.status !== "running");
      if (!oldest) break;
      this.jobs.delete(oldest[0]);
    }
    const progress = value => {
      if (job.status !== "running" || !["rebuild_index", "restart_index"].includes(action) || !value ||
          !["preparing", "waiting_lock", "waiting_readers", "stopping", "indexing", "restarting", "checking", "restoring"].includes(value.phase) ||
          !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.completed) || value.total < 0 || value.completed < 0 || value.completed > value.total) return;
      job.progress = { phase: value.phase, total: value.total, completed: value.completed, updatedAt: new Date().toISOString(),
        ...Object.fromEntries(["repository", "edtProject"].filter(key => typeof value[key] === "string").map(key => [key, value[key].slice(0, 512)])) };
    };
    // A full preparation owns its tickets until it completes. Parallel UI
    // refreshes are observations only, so they cannot supersede that result.
    const runArgs = background ? { ...args, ...(this.stateDirectory ? { dispatchId: job.id } : {}), ...(priority ? { priority } : {}),
      ...(this.active?.status === "running" && this.active.action === "check" ? { transient: true } : {}) } : args;
    let foregroundOwner;
    job.finished = Promise.resolve().then(async () => {
      if (foregroundLease) foregroundOwner = await activate_foreground_readiness(this.stateDirectory, scope.root, scope.instance, foregroundLease, job.id);
      return this.run(action, runArgs, context, progress);
    }).then(
      result => {
        if (["probe", "check", "refresh_readiness"].includes(action)) result = sanitize_setup_result(result);
        if (result?.values && Object.hasOwn(result.values, "projectRoot")) job.projectRoot = result.values.projectRoot || null;
        else if (typeof result?.projectRoot === "string") job.projectRoot = result.projectRoot;
        job.status = "completed"; job.result = result;
        job.completedAt = new Date().toISOString(); this.lastCompleted = job;
        this.observe("operation_completed", { id: job.id, action, projectRoot: job.projectRoot, result: Object.fromEntries(
          ["values", "profile", "managed", "external", "state", "release", "component"].filter(key => result && Object.hasOwn(result, key)).map(key => [key, result[key]])) });
      },
      error => {
        job.status = error.outcomeUnknown ? "outcome_unknown" : "failed";
        job.error = safe_error_message(error);
        job.completedAt = new Date().toISOString(); this.lastCompleted = job;
        this.observe("operation_" + job.status, { id: job.id, action, projectRoot: job.projectRoot, error }, "error");
      },
    ).finally(async () => {
      if (background && this.stateDirectory) try { const marker = inside(this.stateDirectory, path.join(".settings-refresh-cancel", job.id)); fs.rmSync(marker, { force: true }); try { fs.rmdirSync(path.dirname(marker)); } catch {} } catch { /* The finished job must keep its result if cleanup fails. */ }
      if (foregroundLease) {
        try { await foregroundOwner?.close(); } catch { /* The completed operation no longer needs its listener. */ }
        const release = () => { if (!release_foreground_readiness(this.stateDirectory, foregroundLease)) { const timer = setTimeout(release, 1000); timer.unref?.(); } };
        release();
      }
    });
    return job;
  }

  async execute(action, args, context) {
    const job = this.start(action, args, context);
    await job.finished;
    if (job.status !== "completed") throw new Error(job.error);
    return job.result;
  }

  async wait(id, waitMs) {
    const job = id ? this.jobs.get(id) : this.current();
    if (!job || job.status !== "running" || !waitMs) return;
    let timer;
    try { await Promise.race([job.finished, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
    finally { clearTimeout(timer); }
  }

  status(id) {
    const job = id ? this.jobs.get(id) : this.current();
    if (!job) {
      if (id) throw new Error("Операция не найдена в этой MCP-сессии. Проверьте фактические настройки перед повтором.");
      return { status: "idle" };
    }
    const { finished, ...view } = job;
    return view;
  }

  current() {
    return this.active?.status === "running" ? this.active
      : this.background?.status === "running" ? this.background : this.lastCompleted;
  }
}
