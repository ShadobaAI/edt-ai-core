import { randomUUID } from "node:crypto";

// A transport deadline is not cancellation. Keep ownership and the eventual
// result of a running mutation; status polling never starts another backend.
export class SettingsOperations {
  constructor(run) {
    this.run = run;
    this.jobs = new Map();
    this.active = null;
  }

  start(action, args, context) {
    if (this.active?.status === "running") {
      throw new Error(`Операция ${this.active.id} ещё выполняется. Проверьте settings.operation; повтор не запущен.`);
    }
    const job = { id: randomUUID(), action, ...context, status: "running" };
    this.active = job;
    this.jobs.set(job.id, job);
    // Bound retained results, without discarding a running operation.
    while (this.jobs.size > 16) this.jobs.delete(this.jobs.keys().next().value);
    job.finished = Promise.resolve().then(() => this.run(action, args, context)).then(
      result => {
        if (result?.values && Object.hasOwn(result.values, "projectRoot")) job.projectRoot = result.values.projectRoot || null;
        else if (typeof result?.projectRoot === "string") job.projectRoot = result.projectRoot;
        job.status = "completed"; job.result = result;
      },
      error => {
        job.status = error.outcomeUnknown ? "outcome_unknown" : "failed";
        job.error = error.message;
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

  status(id) {
    const job = id ? this.jobs.get(id) : this.active;
    if (!job) {
      if (id) throw new Error("Операция не найдена в этой MCP-сессии. Проверьте фактические настройки перед повтором.");
      return { status: "idle" };
    }
    const { finished, ...view } = job;
    return view;
  }
}
