import { stable } from "./common.mjs";
import { createPublicKey, verify } from "node:crypto";
import { sha256 } from "./project_paths.mjs";
import { validate_publication_receipt, publication_inventory, parse_material, knowledge_material_active } from "./knowledge.mjs";
import { read_openviking_record } from "./openviking_store.mjs";

// Trust is provisioned by the external operator, never a profile, returned
// document, MCP ready flag or project-owned public key.
const record = (options, state) => options.url ? read_openviking_record(options.url, options.connection_id || "", state) : { revision: "missing", values: {} };
export function publication_receipt_epoch(options, now = Date.now(), state) {
  try {
    const entries = JSON.parse(record(options, state).values.publicationReceipts || "");
    if (Array.isArray(entries)) return entries.filter(entry => entry?.payload?.server?.endpoint === options.url).map(entry => {
      const start = Date.parse(entry?.payload?.verified_at), end = Date.parse(entry?.payload?.expires_at);
      return !Number.isFinite(start) || !Number.isFinite(end) ? "invalid" : now < start ? "future" : now >= end ? "expired" : "current";
    });
  } catch {}
  return "invalid";
}
export function publication_revision(options, state) {
  return sha256(stable([options.url, options.connection_id || "", record(options, state).revision]));
}

export class PublicationConfirmation {
  #receipt;
  #expected;
  #revision;
  #nextActivation = Infinity;
  constructor(expected, now = Date.now()) {
    this.#expected = structuredClone(expected);
    const initialRevision = publication_revision({ url: expected.endpoint, connection_id: expected.connectionId }, expected.state);
    let envelopes, key;
    try {
      const values = record({ url: expected.endpoint, connection_id: expected.connectionId }, expected.state).values, raw = values.publicationReceipts;
      if (!raw || raw.length > 262144) throw new Error();
      envelopes = JSON.parse(raw);
      if (!Array.isArray(envelopes) || !envelopes.length || envelopes.length > 64) throw new Error();
      key = createPublicKey(values.publicationPublicKey || "");
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
    } catch { throw new Error("Для публикации нужны внешние подписанные подтверждения и доверенный ключ оператора Ed25519"); }
    const matches = [], current = [];
    for (const envelope of envelopes) {
      try {
        const { payload, signature } = envelope;
        if (typeof signature !== "string" || Buffer.from(signature, "base64").toString("base64") !== signature ||
            !verify(null, Buffer.from(stable(payload)), key, Buffer.from(signature, "base64"))) continue;
        validate_publication_receipt(payload);
        const start = Date.parse(payload.verified_at), end = Date.parse(payload.expires_at);
        if (end - start > 86400000 || end <= now || payload.server.endpoint !== expected.endpoint ||
            payload.server.scope !== expected.scope || payload.verification.deployment_id !== expected.deploymentId ||
            !payload.collection_snapshots.some(item => [...this.#expected.collections.values()]
              .some(root => root === item.root || root.startsWith(item.root + "/") || item.root.startsWith(root + "/")))) continue;
        if (start > now) {
          this.#nextActivation = Math.min(this.#nextActivation, start);
          continue;
        }
        current.push(payload);
        match_publication_receipt(payload, this.#expected, now);
        matches.push(payload);
      } catch { /* Malformed, untrusted and unrelated declarations prove nothing. */ }
    }
    if (!matches.length) throw new Error("Нет действующего подписанного подтверждения публикации для этого манифеста и сервера");
    matches.sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
    const pin = matches[0];
    for (const other of current) {
      if (stable([other.publication_revision, other.manifest_sha256, other.index_revision]) !==
          stable([pin.publication_revision, pin.manifest_sha256, pin.index_revision]) ||
          other.collection_snapshots.some(item => {
            if (![...this.#expected.collections.values()].some(root => root === item.root || root.startsWith(item.root + "/") || item.root.startsWith(root + "/"))) return false;
            return !pin.collection_snapshots.some(selected => stable(item) === stable(selected));
          })) throw new Error("Конфликтуют подписанные снимки публикации для пересекающихся областей коллекций");
    }
    this.#receipt = structuredClone(matches[0]);
    this.#revision = publication_revision({ url: expected.endpoint, connection_id: expected.connectionId }, expected.state);
    if (this.#revision !== initialRevision) throw new Error("Подтверждение публикации или доверенный ключ изменились; переподключитесь");
  }
  check(now = Date.now()) {
    if (this.#revision !== publication_revision({ url: this.#expected.endpoint, connection_id: this.#expected.connectionId }, this.#expected.state))
      throw new Error("Подтверждение публикации или доверенный ключ изменились; переподключитесь");
    if (!Number.isFinite(now) || now < Date.parse(this.#receipt.verified_at) || now >= Date.parse(this.#receipt.expires_at))
      throw new Error("Подтверждение публикации больше не действует; переподключитесь");
    if (now >= this.#nextActivation) throw new Error("Вступило в силу другое подписанное подтверждение публикации; переподключитесь");
    return this.receipt;
  }
  get receipt() { return structuredClone(this.#receipt); }
  entry(uri, collection, now = Date.now()) {
    this.check(now);
    return structuredClone(publication_entry(this.#receipt, this.#expected.manifest, uri, collection));
  }
  material(result, now = Date.now()) {
    this.check(now);
    return structuredClone(verify_publication_material(this.#receipt, this.#expected.manifest, result));
  }
}

// Matching declarations is deliberately separate from authenticating their
// publisher. Callers must authenticate a receipt before relying on this match.
export function match_publication_receipt(receipt, expected, now = Date.now()) {
  validate_publication_receipt(receipt);
  const start = Date.parse(receipt.verified_at), end = Date.parse(receipt.expires_at);
  if (!Number.isFinite(now) || start > now || end <= now || end - start > 86400000)
    throw new Error("Подтверждение публикации просрочено, ещё не вступило в силу или действует дольше суток");
  if (receipt.server.endpoint !== expected.endpoint || receipt.server.scope !== expected.scope ||
      receipt.verification.deployment_id !== expected.deploymentId)
    throw new Error("Подтверждение публикации относится к другому серверу, области или развёртыванию");
  if (receipt.manifest_sha256 !== expected.manifest.sha256)
    throw new Error("Содержимое манифеста публикации изменилось");
  const inventory = publication_inventory(expected.manifest.data, [...expected.collections.keys()])
    .map(item => ({ ...item, root: expected.collections.get(item.collection) }));
  const actual = [...receipt.collection_snapshots].sort((a, b) => a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0);
  if (stable(actual) !== stable(inventory))
    throw new Error("Индекс публикации не соответствует точному составу выбранных коллекций");
  return receipt;
}

export function publication_entry(receipt, manifest, uri, collection) {
  validate_publication_receipt(receipt);
  const inventory = publication_inventory(manifest.data, receipt.collections);
  if (receipt.manifest_sha256 !== manifest.sha256 || inventory.some(item => {
    const declared = receipt.collection_snapshots.find(snapshot => snapshot.collection === item.collection);
    return declared.material_count !== item.material_count || declared.materials_sha256 !== item.materials_sha256;
  })) throw new Error("Манифест материала отличается от подтверждённого состава публикации");
  const root = receipt.collection_snapshots.find(item => item.collection === collection)?.root;
  const entry = root && manifest.data.materials.find(item => item.collection === collection && root + "/" + item.id + ".md" === uri);
  if (!entry) throw new Error("Материал отсутствует в действующем манифесте публикации: исключён, удалён или не выбран");
  return entry;
}

export function verify_publication_material(receipt, manifest, { uri, collection, text, partial = false }) {
  const entry = publication_entry(receipt, manifest, uri, collection);
  if (partial || typeof text !== "string" || sha256(Buffer.from(text, "utf8")) !== entry.sha256)
    throw new Error("Содержимое материала не совпадает со снимком публикации; обрезанное или смешанное содержимое отклонено");
  let metadata;
  try { metadata = parse_material(text); }
  catch { throw new Error("Некорректные метаданные опубликованного материала; фрагмент разбора скрыт"); }
  if (metadata.id !== entry.id || !knowledge_material_active(metadata))
    throw new Error("Идентичность или статус материала не совпадают с действующим манифестом публикации");
  return entry;
}
