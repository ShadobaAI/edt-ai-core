import { IndexObserver } from "./runtime.mjs";

// The settings session itself owns the reader. Its process supervisor and
// reader lease provide cleanup and crash isolation without a detached worker.
export class IndexObserverProxy extends IndexObserver {}
