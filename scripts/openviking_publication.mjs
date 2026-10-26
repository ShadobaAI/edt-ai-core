import { stable } from "./common.mjs";
import { createPublicKey, verify } from "node:crypto";
import { sha256 } from "./project_paths.mjs";
import { validate_publication_receipt, publication_inventory, parse_material, knowledge_material_active } from "./knowledge.mjs";

// Trust is provisioned by the external operator, never a profile, returned
// document, MCP ready flag or project-owned public key.
const RECEIPTS = "EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS";
const PUBLIC_KEY = "EDT_AI_OPENVIKING_PUBLICATION_PUBLIC_KEY";
export function publication_revision(options) {
  const raw = process.env[RECEIPTS] || "";
  let relevant = raw;
  try {
    const all = JSON.parse(raw);
    if (Array.isArray(all)) relevant = all.filter(entry => entry?.payload?.server?.endpoint === options.url);
  } catch { /* Invalid operator state must invalidate a pinned confirmation. */ }
  return sha256(stable([relevant, process.env[PUBLIC_KEY] || ""]));
}

export class PublicationConfirmation {
  #receipt;
  #expected;
  #revision;
  #nextActivation = Infinity;
  constructor(expected, now = Date.now()) {
    this.#expected = structuredClone(expected);
    let envelopes, key;
    try {
      const raw = process.env[RECEIPTS];
      if (!raw || raw.length > 262144) throw new Error();
      envelopes = JSON.parse(raw);
      if (!Array.isArray(envelopes) || !envelopes.length || envelopes.length > 64) throw new Error();
      key = createPublicKey(process.env[PUBLIC_KEY] || "");
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
    } catch { throw new Error("Publication requires external signed receipts and an operator Ed25519 trust key"); }
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
    if (!matches.length) throw new Error("No current signed publication confirmation matches this manifest and server");
    matches.sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
    const pin = matches[0];
    for (const other of current) {
      if (stable([other.publication_revision, other.manifest_sha256, other.index_revision]) !==
          stable([pin.publication_revision, pin.manifest_sha256, pin.index_revision]) ||
          other.collection_snapshots.some(item => {
            if (![...this.#expected.collections.values()].some(root => root === item.root || root.startsWith(item.root + "/") || item.root.startsWith(root + "/"))) return false;
            return !pin.collection_snapshots.some(selected => stable(item) === stable(selected));
          })) throw new Error("Conflicting signed publication snapshots for overlapping collection areas");
    }
    this.#receipt = structuredClone(matches[0]);
    this.#revision = publication_revision({ url: expected.endpoint });
  }
  check(now = Date.now()) {
    if (this.#revision !== publication_revision({ url: this.#expected.endpoint }))
      throw new Error("Publication confirmation or trust key changed; reconnect required");
    if (!Number.isFinite(now) || now < Date.parse(this.#receipt.verified_at) || now >= Date.parse(this.#receipt.expires_at))
      throw new Error("Publication confirmation is no longer current; reconnect required");
    if (now >= this.#nextActivation) throw new Error("Another signed publication confirmation became active; reconnect required");
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
    throw new Error("Publication confirmation is expired, future-dated or exceeds one day");
  if (receipt.server.endpoint !== expected.endpoint || receipt.server.scope !== expected.scope ||
      receipt.verification.deployment_id !== expected.deploymentId)
    throw new Error("Publication confirmation belongs to another server, scope or deployment");
  if (receipt.manifest_sha256 !== expected.manifest.sha256)
    throw new Error("Publication manifest bytes changed");
  const inventory = publication_inventory(expected.manifest.data, [...expected.collections.keys()])
    .map(item => ({ ...item, root: expected.collections.get(item.collection) }));
  const actual = [...receipt.collection_snapshots].sort((a, b) => a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0);
  if (stable(actual) !== stable(inventory))
    throw new Error("Publication index does not match the exact selected collection inventory");
  return receipt;
}

export function publication_entry(receipt, manifest, uri, collection) {
  validate_publication_receipt(receipt);
  const inventory = publication_inventory(manifest.data, receipt.collections);
  if (receipt.manifest_sha256 !== manifest.sha256 || inventory.some(item => {
    const declared = receipt.collection_snapshots.find(snapshot => snapshot.collection === item.collection);
    return declared.material_count !== item.material_count || declared.materials_sha256 !== item.materials_sha256;
  })) throw new Error("Material manifest differs from the confirmed publication inventory");
  const root = receipt.collection_snapshots.find(item => item.collection === collection)?.root;
  const entry = root && manifest.data.materials.find(item => item.collection === collection && root + "/" + item.id + ".md" === uri);
  if (!entry) throw new Error("Material is absent from the active publication manifest (excluded, deleted or unselected)");
  return entry;
}

export function verify_publication_material(receipt, manifest, { uri, collection, text, partial = false }) {
  const entry = publication_entry(receipt, manifest, uri, collection);
  if (partial || typeof text !== "string" || sha256(Buffer.from(text, "utf8")) !== entry.sha256)
    throw new Error("Material bytes do not match the publication snapshot; truncated or mixed content is rejected");
  let metadata;
  try { metadata = parse_material(text); }
  catch { throw new Error("Invalid published material metadata; parser excerpt omitted"); }
  if (metadata.id !== entry.id || !knowledge_material_active(metadata))
    throw new Error("Material identity or status does not match the active publication manifest");
  return entry;
}
