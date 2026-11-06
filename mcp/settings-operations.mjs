import { randomUUID } from "node:crypto";
import { sanitize_setup_result, safe_error_message } from "../scripts/diagnostics.mjs";

// A transport deadline is not cancellation. Keep ownership and the eventual
// result of a running mutation; status polling never starts another backend.
export class SettingsOperations {
  constructor(run, observe = () => {}) {
    this.run = run;
    this.observe = observe;
    this.jobs = new Map();
    this.active = null;
    this.background = null;
    this.lastCompleted = null;
  }

  start(action, args, context) {
    const background = action === "refresh_readiness";
    if (this.active?.status === "running" || (background && this.background?.status === "running")) {
      throw new Error(`Операция ${this.current().id} ещё выполняется. Проверьте settings.operation; повтор не запущен.`);
    }
    const job = { id: randomUUID(), action, ...context, ...(["probe", "refresh_readiness"].includes(action) && args.component ? { component: args.component } : {}),
      ...(["rebuild_index", "restart_index"].includes(action) ? { component: "code-index", ...(args.all === true ? { all: true } : {}) } : {}), status: "running", startedAt: new Date().toISOString() };
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
    job.finished = Promise.resolve().then(() => this.run(action, args, context, progress)).then(
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
    );
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
