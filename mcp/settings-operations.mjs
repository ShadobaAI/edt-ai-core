import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitize_setup_result, safe_error_message } from "../scripts/diagnostics.mjs";
import { inside } from "../scripts/common.mjs";
import { begin_foreground_readiness, activate_foreground_readiness, retain_foreground_readiness, retain_readiness_scope, release_foreground_readiness, assert_readiness_cleanup_known, capture_readiness_priority, capture_component_flights } from "../scripts/setup_readiness.mjs";
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
    this.observerSession = randomUUID();
    this.closing = false;
    this.unconfirmed = false;
    this.observedStates = new Map();
  }

  start(action, args, context) {
    const independentIndex = ["probe", "refresh_readiness"].includes(action) && args.component === "code-index";
    const reject = (message, properties = {}) => {
      const error = Object.assign(new Error(message), properties);
      this.observe("operation_rejected", { action, projectRoot: context.projectRoot, component: args.component, phase: "dispatch", error }, "error");
      throw error;
    };
    if (this.closing) reject("Сеанс настроек завершён; новая операция не запущена.", { code: "RUNTIME_BUSY" });
    if (this.unconfirmed && !independentIndex && ["probe", "check", "refresh_readiness"].includes(action))
      reject("Завершение предыдущей проверки не подтверждено; новая проверка заблокирована.", { outcomeUnknown: true });
    const background = action === "refresh_readiness";
    const overlap = background && ["rebuild_index", "restart_index", "updates", "check"].includes(this.active?.action);
    if (this.active?.status === "running" && !overlap || (background && this.background?.status === "running")) {
      reject(`Операция ${this.current().id} ещё выполняется. Проверьте settings.operation; повтор не запущен.`, { code: "RUNTIME_BUSY" });
    }
    // Signal an older background process synchronously, before dispatching a
    // foreground job. It checks this marker while holding the state lock, so
    // process scheduling cannot let it steal the foreground's tickets.
    const sameBackgroundScope = !this.background?.projectRoot || !context.projectRoot || path_identity(this.background.projectRoot) === path_identity(context.projectRoot);
    const sameBackgroundInstance = !this.background?.instance || !context.instance || this.background.instance === context.instance;
    if (!background && !(action === "probe" && args.component) && this.stateDirectory && this.background?.status === "running" && sameBackgroundScope && sameBackgroundInstance) {
      const marker = inside(this.stateDirectory, path.join(".settings-refresh-cancel", this.background.id));
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "cancelled", { mode: 0o600 });
    }
    const job = { id: randomUUID(), action, ...context, ...(["probe", "refresh_readiness"].includes(action) && args.component ? { component: args.component } : {}),
      ...(["rebuild_index", "restart_index"].includes(action) ? { component: "code-index", ...(args.all === true ? { all: true } : {}) } : {}), status: "running", startedAt: new Date().toISOString() };
    const scope = this.stateDirectory && context.projectRoot && context.instance ? { root: path_identity(context.projectRoot), instance: context.instance } : null;
    if (scope && !independentIndex && ["probe", "check", "refresh_readiness"].includes(action)) assert_readiness_cleanup_known(this.stateDirectory, scope.root, scope.instance);
    const priority = background && scope && !independentIndex ? { ...scope, ...capture_readiness_priority(this.stateDirectory, scope.root, scope.instance) } : null;
    const observedFlights = background && scope ? capture_component_flights(this.stateDirectory, scope.root) : null;
    const foregroundLease = !background && !independentIndex && scope && ["check", "probe"].includes(action)
      ? begin_foreground_readiness(this.stateDirectory, scope.root, scope.instance, job.id) : null;
    const backgroundObservation = action === "refresh_readiness";
    if (!backgroundObservation) this.observe("operation_started", { id: job.id, action, ...context, component: job.component, phase: "dispatch", startedAt: job.startedAt });
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
      const previous = job.progress;
      job.progress = { phase: value.phase, total: value.total, completed: value.completed, updatedAt: new Date().toISOString(),
        ...Object.fromEntries(["repository", "edtProject"].filter(key => typeof value[key] === "string").map(key => [key, value[key].slice(0, 512)])) };
      if (!previous || previous.phase !== value.phase || previous.completed !== value.completed)
        this.observe("operation_phase", { id: job.id, action, projectRoot: job.projectRoot, component: job.component, phase: value.phase, total: value.total, completed: value.completed });
    };
    // A full preparation owns its tickets until it completes. Parallel UI
    // refreshes are observations only, so they cannot supersede that result.
    const runArgs = background ? { ...args, observedFlights: observedFlights || undefined, ...(this.stateDirectory ? { dispatchId: job.id, observerSession: this.observerSession } : {}), ...(priority ? { priority } : {}),
      ...(this.active?.status === "running" && this.active.action === "check" ? { transient: true } : {}) } : args;
    let foregroundOwner;
    job.finished = Promise.resolve().then(async () => {
      let result, failure;
      try {
        if (this.closing) throw new Error("Сеанс настроек завершён.");
        if (foregroundLease) foregroundOwner = await activate_foreground_readiness(this.stateDirectory, scope.root, scope.instance, foregroundLease, job.id);
        if (this.closing) throw new Error("Сеанс настроек завершён.");
        result = await this.run(action, runArgs, { ...context, operationId: job.id }, progress);
      } catch (error) { failure = error; }
      let cleanupFailure;
      if (background && this.stateDirectory) try {
        const marker = inside(this.stateDirectory, path.join(".settings-refresh-cancel", job.id));
        fs.rmSync(marker, { force: true });
        try { fs.rmdirSync(path.dirname(marker)); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      } catch (error) { cleanupFailure = error; }
      if (foregroundLease) {
        if (failure?.markerChanged && !foregroundOwner) cleanupFailure ||= new Error("Маркер проверки изменился; его очистка не подтверждена.");
        else {
          // Persist the barrier before closing the listener, so a lost callback
          // cannot leave an inactive-looking marker in another session.
          if (!retain_foreground_readiness(this.stateDirectory, foregroundLease, job.id))
            cleanupFailure ||= new Error("Не удалось сохранить барьер незавершённой проверки.");
          try { await foregroundOwner?.close(); } catch (error) { cleanupFailure ||= error; }
          if (!cleanupFailure && !failure?.outcomeUnknown && !release_foreground_readiness(this.stateDirectory, foregroundLease))
            cleanupFailure = new Error("Не удалось освободить маркер проверки готовности.");
        }
      }
      if (cleanupFailure) {
        this.observe("operation_cleanup_failed", { id: job.id, action, projectRoot: job.projectRoot, error: cleanupFailure }, "error");
        throw Object.assign(new Error("Завершение ресурсов операции не подтверждено; проверьте состояние перед повтором."), { outcomeUnknown: true, cause: cleanupFailure });
      }
      if (failure) throw failure;
      return result;
    }).then(
      result => {
        const observationResult = result;
        if (["probe", "check", "refresh_readiness"].includes(action)) result = sanitize_setup_result(result);
        if (result?.values && Object.hasOwn(result.values, "projectRoot")) job.projectRoot = result.values.projectRoot || null;
        else if (typeof result?.projectRoot === "string") job.projectRoot = result.projectRoot;
        job.status = "completed"; job.result = result;
        job.completedAt = new Date().toISOString(); this.lastCompleted = job;
        const durationMs = Date.parse(job.completedAt) - Date.parse(job.startedAt);
        if (!backgroundObservation) this.observe("operation_completed", { id: job.id, action, projectRoot: job.projectRoot, component: job.component,
          phase: "completed", durationMs, status: result?.cancelled ? "cancelled" : "completed" });
        for (const check of Array.isArray(observationResult?.componentChecks) ? observationResult.componentChecks : []) {
          if (!check || !["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"].includes(check.id) || typeof check.state !== "string" || observationResult.superseded || (Array.isArray(observationResult.supersededComponents) && observationResult.supersededComponents.includes(check.id))) continue;
          const external = observationResult.external?.[check.id], failure = check.failure || check.diagnostic?.failure || external?.failure;
          const key = JSON.stringify([job.projectRoot, job.instance, check.id]);
          const detail = check.detail || external?.detail;
          const state = JSON.stringify([check.state, check.reasonCode, failure?.category, failure?.httpStatus, failure?.rpcCode, failure?.osCode, detail,
            external?.configured, external?.connected, external?.ready, external?.toolsVerified, external?.server?.version]
            .map(value => typeof value === "string" ? value.slice(0, 128) : ["number", "boolean"].includes(typeof value) ? value : null));
          if (this.observedStates.get(key) === state) continue;
          this.observedStates.set(key, state);
          while (this.observedStates.size > 256) this.observedStates.delete(this.observedStates.keys().next().value);
          this.observe("component_observed", { operationId: job.id, action, projectRoot: job.projectRoot, component: check.id, state: check.state,
            reasonCode: check.reasonCode, failure, detail, diagnostic: check.diagnostic, checkedAt: check.checkedAt, expiresAt: check.expiresAt, durationMs,
            configured: external?.configured, connected: external?.connected, ready: external?.ready, toolsVerified: external?.toolsVerified, version: external?.server?.version },
            check.state === "error" ? "error" : "info");
        }
      },
      error => {
        job.status = error.outcomeUnknown ? "outcome_unknown" : "failed";
        if (error.outcomeUnknown) {
          this.unconfirmed = true;
          if (scope && !foregroundLease && !retain_readiness_scope(this.stateDirectory, scope.root, scope.instance, job.id))
            this.observe("operation_barrier_failed", { id: job.id, action, projectRoot: job.projectRoot }, "error");
        }
        job.error = safe_error_message(error);
        job.completedAt = new Date().toISOString(); this.lastCompleted = job;
        this.observe("operation_" + job.status, { id: job.id, action, projectRoot: job.projectRoot, component: job.component,
          phase: job.progress?.phase || "dispatch", startedAt: job.startedAt, durationMs: Date.parse(job.completedAt) - Date.parse(job.startedAt), error }, "error");
      },
    );
    return job;
  }

  async execute(action, args, context) {
    const job = this.start(action, args, context);
    await job.finished;
    if (job.status !== "completed") throw Object.assign(new Error(job.error), { outcomeUnknown: job.status === "outcome_unknown" });
    return job.result;
  }

  async shutdown() {
    this.closing = true;
    const active = [this.active, this.background].filter(job => job?.status === "running");
    await Promise.all(active.map(job => job.finished));
    if (this.unconfirmed || active.some(job => job.status === "outcome_unknown"))
      throw Object.assign(new Error("Завершение операции настроек не подтверждено."), { outcomeUnknown: true });
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

  retained() {
    return [...this.jobs.values()].map(({ finished, result, error, ...job }) => job);
  }

  current() {
    return this.active?.status === "running" ? this.active
      : this.background?.status === "running" ? this.background : this.lastCompleted;
  }
}
