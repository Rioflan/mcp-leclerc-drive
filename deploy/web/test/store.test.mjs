import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertStore } from "../src/store.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "alerts-"));

test("persistance et rechargement", async () => {
  const dir = await tmp();
  const s = await new AlertStore(dir).load();
  const a = await s.upsert({ productId: "42", label: "Oeufs", query: "oeufs" });
  assert.equal(a.status, "armed");
  const again = await new AlertStore(dir).load();
  assert.equal(again.alerts.length, 1);
  assert.equal(again.alerts[0].productId, "42");
  // Écriture atomique : pas de fichier temporaire résiduel.
  assert.deepEqual((await readdir(dir)).sort(), ["alerts.json"]);
});

test("upsert réarme au lieu de dupliquer", async () => {
  const s = await new AlertStore(await tmp()).load();
  const a = await s.upsert({ productId: "42", label: "Oeufs", query: "oeufs" });
  a.status = "triggered";
  const b = await s.upsert({ productId: "42", label: "Oeufs x10", query: "" });
  assert.equal(s.alerts.length, 1);
  assert.equal(b.id, a.id);
  assert.equal(b.status, "armed");
  assert.equal(b.query, "oeufs");
});

test("rearm et remove", async () => {
  const s = await new AlertStore(await tmp()).load();
  const a = await s.upsert({ productId: "1", label: "A", query: "a" });
  a.status = "triggered";
  assert.equal((await s.rearm(a.id)).status, "armed");
  assert.equal(await s.rearm("inconnu"), null);
  assert.equal(await s.remove(a.id), true);
  assert.equal(await s.remove(a.id), false);
});

test("écritures concurrentes : le dernier état gagne, fichier valide", async () => {
  const dir = await tmp();
  const s = await new AlertStore(dir).load();
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.upsert({ productId: String(i), label: `P${i}`, query: "" })));
  const data = JSON.parse(await readFile(join(dir, "alerts.json"), "utf8"));
  assert.equal(data.alerts.length, 20);
});

test("refuse une version de fichier inconnue", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "alerts.json"), JSON.stringify({ version: 99, alerts: [] }));
  await assert.rejects(new AlertStore(dir).load(), /version 99/);
});
