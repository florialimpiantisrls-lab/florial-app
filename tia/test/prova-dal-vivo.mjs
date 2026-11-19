// Prova di TIA sul Supabase vero, con il modello vero: fa le domande di
// test/domande.json come titolare e controlla le risposte. Va lanciata dopo
// il primo deploy e prima di ogni modifica a prompt, documenti o strumenti.
//
//   TIA_URL=https://<progetto>.supabase.co/functions/v1  TIA_TOKEN=<token del titolare>  npm run prova
//
// Attenzione: consuma token (poche domande brevi).

import { readFileSync } from "node:fs";

const url = (process.env.TIA_URL ?? "").replace(/\/+$/, "");
const token = process.env.TIA_TOKEN ?? "";
if (!url || !token) {
  console.error("Servono TIA_URL e TIA_TOKEN.");
  process.exit(1);
}

async function chiama(corpo) {
  const r = await fetch(`${url}/tia`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(corpo),
  });
  return { stato: r.status, corpo: await r.json().catch(() => ({})) };
}

const stato = await chiama({ tipo: "stato" });
if (stato.stato !== 200) {
  console.error(`TIA non risponde allo stato (${stato.stato}): ${JSON.stringify(stato.corpo)}`);
  process.exit(1);
}
console.log("STATO\n" + JSON.stringify(stato.corpo, null, 2) + "\n");

const casi = JSON.parse(readFileSync(new URL("./domande.json", import.meta.url), "utf8"));
let falliti = 0;
for (const caso of casi) {
  const r = await chiama({ messages: [{ role: "user", content: caso.domanda }] });
  const testo = String(r.corpo.risposta ?? r.corpo.errore ?? "");
  const basso = testo.toLowerCase();
  const problemi = [];
  if (r.stato !== 200 || r.corpo.ok !== true) problemi.push(`risposta non ok (stato ${r.stato}, percorso ${r.corpo.percorso})`);
  if (caso.percorso && !caso.percorso.includes(r.corpo.percorso)) problemi.push(`percorso «${r.corpo.percorso}»`);
  for (const c of caso.contiene ?? []) if (!basso.includes(c.toLowerCase())) problemi.push(`manca «${c}»`);
  for (const c of caso.nonContiene ?? []) if (basso.includes(c.toLowerCase())) problemi.push(`contiene «${c}»`);
  if (caso.contieneUnoDi && !caso.contieneUnoDi.some((c) => basso.includes(c.toLowerCase()))) {
    problemi.push(`manca una tra: ${caso.contieneUnoDi.join(" / ")}`);
  }
  if (problemi.length) falliti++;
  console.log(`${problemi.length ? "✗" : "✓"} ${caso.nome} [${r.corpo.percorso ?? "-"}]`);
  if (problemi.length) console.log(`    ${problemi.join("; ")}\n    risposta: ${testo.slice(0, 300).replace(/\n/g, " ")}\n    traccia: ${r.corpo.traccia ?? "-"}`);
}
console.log(`\n${casi.length - falliti} ok, ${falliti} da guardare.`);
process.exit(falliti ? 1 : 0);
