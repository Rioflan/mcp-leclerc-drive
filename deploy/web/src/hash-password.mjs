// Génère la valeur de UI_PASSWORD_HASH.
// Interactif : saisie masquée et confirmée. Sinon : mot de passe lu sur stdin.
import { createInterface } from "node:readline";
import { hashPassword } from "./auth.mjs";

const MIN_LENGTH = 12;

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

let password;
if (process.stdin.isTTY) {
  password = await askHidden("Mot de passe de l'interface : ");
  if (password !== (await askHidden("Confirmation : "))) {
    console.error("Les deux saisies diffèrent.");
    process.exit(1);
  }
} else {
  password = await readStdin();
}

if (password.length < MIN_LENGTH) {
  console.error(`Mot de passe trop court (${MIN_LENGTH} caractères minimum).`);
  process.exit(1);
}
console.log(await hashPassword(password));
