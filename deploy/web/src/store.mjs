// Alertes et état du planificateur, persistés dans un fichier JSON versionné.
// Écriture atomique (fichier temporaire + rename) et sérialisée : un arrêt brutal
// ne laisse jamais un fichier tronqué.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const VERSION = 1;
export const MAX_ALERTS = 200;

const emptyState = () => ({
  version: VERSION,
  alerts: [],
  scheduler: {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    failureNotified: false,
    cartOutOfStock: [],
  },
});

export class AlertStore {
  constructor(dataDir) {
    this.file = join(dataDir, "alerts.json");
    this.dataDir = dataDir;
    this.data = emptyState();
    this.writing = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return this;
      throw err;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.version !== VERSION) {
      throw new Error(`${this.file} : version ${parsed?.version} non prise en charge.`);
    }
    const base = emptyState();
    this.data = {
      version: VERSION,
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      scheduler: { ...base.scheduler, ...parsed.scheduler },
    };
    return this;
  }

  save() {
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, this.file);
      });
    return this.writing;
  }

  get alerts() {
    return this.data.alerts;
  }

  get scheduler() {
    return this.data.scheduler;
  }

  armed() {
    return this.data.alerts.filter((a) => a.status === "armed");
  }

  find(id) {
    return this.data.alerts.find((a) => a.id === id) ?? null;
  }

  /** Crée une alerte, ou réarme celle qui existe déjà pour ce produit. */
  async upsert({ productId, label, query }) {
    let alert = this.data.alerts.find((a) => a.productId === productId);
    if (alert) {
      Object.assign(alert, { status: "armed", triggeredAt: null, label, query: query || alert.query });
    } else {
      if (this.data.alerts.length >= MAX_ALERTS) {
        throw Object.assign(new Error(`Limite de ${MAX_ALERTS} alertes atteinte.`), { status: 409 });
      }
      alert = {
        id: randomUUID(),
        productId,
        label,
        query,
        status: "armed",
        createdAt: new Date().toISOString(),
        lastCheckedAt: null,
        lastAvailable: null,
        triggeredAt: null,
      };
      this.data.alerts.push(alert);
    }
    await this.save();
    return alert;
  }

  async rearm(id) {
    const alert = this.find(id);
    if (!alert) return null;
    Object.assign(alert, { status: "armed", triggeredAt: null });
    await this.save();
    return alert;
  }

  async remove(id) {
    const before = this.data.alerts.length;
    this.data.alerts = this.data.alerts.filter((a) => a.id !== id);
    if (this.data.alerts.length === before) return false;
    await this.save();
    return true;
  }
}
