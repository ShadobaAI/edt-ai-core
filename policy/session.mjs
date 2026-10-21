// References save retransmission, never replace current evidence or checks.
import { randomUUID } from "node:crypto";
import { detectMechanisms } from "./detector.mjs";
import { select, validateCompliance } from "./selector.mjs";
export class PolicySession {
  constructor(registry) { this.registry = registry; this.records = new Map(); }
  retain(value) {
    const ref = randomUUID();
    this.records.set(ref, structuredClone(value));
    while (this.records.size > 64) this.records.delete(this.records.keys().next().value);
    return ref;
  }
  read(ref) {
    if (!this.records.has(ref)) throw new Error("Policy reference expired or belongs to another session; submit current evidence again");
    return structuredClone(this.records.get(ref));
  }
  assess({ assessments, sourceRef, ...input }) {
    const detection = detectMechanisms({ sourceRef, assessments }),
      selection = select("oneC", { ...input, detection }, this.registry);
    if (!selection.digest) return { selection };
    return { selection, selectionRef: this.retain({ kind: "selection", value: selection }),
      detectionRef: this.retain({ kind: "detection", value: detection }) };
  }
  validate({ phase, selectionRef, current, rows }) {
    const saved = this.read(selectionRef);
    if (saved.kind !== "selection") throw new Error("Expected a selection reference");
    const selection = saved.value, { detectionRef, ...actual } = current;
    if (detectionRef) {
      const record = this.read(detectionRef);
      if (record.kind !== "detection") throw new Error("Expected a detection reference");
      actual.detection = record.value;
    }
    const ledger = rows.map(([selector, status, evidence, reason]) => ({
      selector, status, evidence, ...(reason === undefined ? {} : { reason }),
      selection_digest: selection.digest, target: actual.target, source_ref: actual.sourceRef,
    }));
    return validateCompliance(selection, ledger, actual, this.registry, phase);
  }
}
