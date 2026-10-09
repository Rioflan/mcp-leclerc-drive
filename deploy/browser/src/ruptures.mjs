// CLI : articles du panier en rupture de stock (appelée par scripts/ruptures.sh).
import { createLeclerc, readCart } from "./leclerc.mjs";

const json = process.argv.includes("--json");
const { browser, client } = createLeclerc();
const eur = (n) => n.toFixed(2).replace(".", ",") + " €";

try {
  const cart = await readCart(client);
  const out = cart.items
    .filter((i) => !i.available)
    .map(({ id, label, quantity, lineTotal }) => ({ id, label, quantity, lineTotal }));

  if (json) {
    console.log(JSON.stringify({ storeId: cart.storeId, total: cart.total, outOfStock: out }, null, 2));
  } else if (out.length === 0) {
    console.log(`Aucune rupture (${cart.items.length} articles dans le panier).`);
  } else {
    console.log(`${out.length} article(s) en rupture sur ${cart.items.length} :`);
    for (const i of out) console.log(`• ${i.quantity}× ${i.label} — ${eur(i.lineTotal)} (id=${i.id})`);
    const missing = out.reduce((s, i) => s + i.lineTotal, 0);
    console.log(`\nTotal panier : ${eur(cart.total)} — dont ${eur(missing)} en rupture.`);
  }
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit();
}
