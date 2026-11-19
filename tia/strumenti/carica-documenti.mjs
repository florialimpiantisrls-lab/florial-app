// Carica in TIA i documenti di una cartella (.md e .txt).
//
//   TIA_URL=https://<progetto>.supabase.co/functions/v1  TIA_TOKEN=<token del titolare>  npm run carica -- documenti
//   npm run carica -- documenti --prova        (fa solo vedere cosa caricherebbe)
//
// Chi può leggere un documento (il «livello») va detto in modo esplicito, in uno di due modi:
//   1) mettendo il file in una sottocartella:  documenti/tutti/  documenti/ufficio/  documenti/admin/
//   2) scrivendolo in testa al file:
//        ---
//        codice: FLR-OPE-03
//        titolo: Fine intervento
//        livello: tutti
//        tipo: procedura
//        ---
// Un file senza livello NON viene caricato: meglio fermarsi che far leggere
// ai tecnici un documento riservato.
// I file che cominciano con _ vengono saltati.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const LIVELLI = ["tutti", "ufficio", "admin"];
const CAMPI = ["codice", "titolo", "livello", "tipo", "cliente", "versione"];

// Da percorso e contenuto di un file al documento da mandare a TIA.
export function leggiDocumento(percorsoRelativo, contenuto) {
  let testo = contenuto.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const doc = {};

  const testata = testo.match(/^---\n([\s\S]*?)\n---\n?/);
  if (testata) {
    for (const riga of testata[1].split("\n")) {
      const m = riga.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
      if (m && CAMPI.includes(m[1].toLowerCase())) doc[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
    }
    testo = testo.slice(testata[0].length);
  }

  const nome = basename(percorsoRelativo, extname(percorsoRelativo));
  const cartelle = percorsoRelativo.split(/[\\/]/).slice(0, -1).map((c) => c.toLowerCase());

  if (!doc.livello) doc.livello = cartelle.find((c) => LIVELLI.includes(c));
  if (!doc.codice) {
    const m = nome.match(/^((?:FLR-[A-Z]{3}-\d{2})|(?:(?:PRV|RSC|SCH|CTR)-\d{3}-\d{4}))/i);
    if (m) doc.codice = m[1].toUpperCase().replace(/-(\d{4})$/, "/$1");
  }
  if (!doc.titolo) {
    const primoTitolo = testo.match(/^#\s+(.+)$/m);
    doc.titolo = primoTitolo ? primoTitolo[1].trim() : nome.replace(/[_-]+/g, " ").trim();
  }
  doc.testo = testo.trim();

  if (!doc.testo) return { errore: "file vuoto" };
  if (!doc.livello) return { errore: "manca il livello (sottocartella tutti/ufficio/admin oppure «livello:» in testa al file)" };
  if (!LIVELLI.includes(doc.livello)) return { errore: `livello «${doc.livello}» non valido` };
  return { documento: doc };
}

function elenca(cartella) {
  const trovati = [];
  for (const voce of readdirSync(cartella)) {
    if (voce.startsWith("_") || voce.startsWith(".")) continue;
    const percorso = join(cartella, voce);
    if (statSync(percorso).isDirectory()) trovati.push(...elenca(percorso));
    else if ([".md", ".txt"].includes(extname(voce).toLowerCase())) trovati.push(percorso);
  }
  return trovati.sort();
}

async function principale() {
  const argomenti = process.argv.slice(2);
  const prova = argomenti.includes("--prova");
  const cartella = argomenti.find((a) => !a.startsWith("--")) ?? "documenti";
  const url = (process.env.TIA_URL ?? "").replace(/\/+$/, "");
  const token = process.env.TIA_TOKEN ?? "";

  const documenti = [];
  let scartati = 0;
  for (const percorso of elenca(cartella)) {
    const rel = relative(cartella, percorso).split(sep).join("/");
    const r = leggiDocumento(rel, readFileSync(percorso, "utf8"));
    if (r.errore) {
      scartati++;
      console.log(`✗ ${rel} — ${r.errore}`);
    } else {
      documenti.push(r.documento);
      const d = r.documento;
      console.log(`• ${rel} → ${d.codice ?? "(senza codice)"} · ${d.titolo} · livello ${d.livello} · ${d.testo.length} caratteri`);
    }
  }
  console.log(`\n${documenti.length} documenti pronti, ${scartati} scartati.`);
  if (prova || documenti.length === 0) return;

  if (!url || !token) {
    console.error("Per caricare servono TIA_URL e TIA_TOKEN. Con --prova si vede solo l'elenco.");
    process.exit(1);
  }

  let falliti = scartati;
  for (let i = 0; i < documenti.length; i += 20) {
    const risposta = await fetch(`${url}/tia-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documenti: documenti.slice(i, i + 20) }),
    });
    const corpo = await risposta.json().catch(() => ({}));
    if (!risposta.ok) {
      console.error(`Errore ${risposta.status}: ${corpo.errore ?? "risposta non leggibile"}`);
      process.exit(1);
    }
    for (const e of corpo.esiti ?? []) {
      const ok = e.esito === "caricato" || e.esito === "invariato";
      if (!ok) falliti++;
      console.log(`${ok ? "✓" : "✗"} ${e.documento} — ${e.esito}${e.pezzi ? ` (${e.pezzi} pezzi)` : ""}${e.motivo ? `: ${e.motivo}` : ""}${e.avviso ? ` ⚠ ${e.avviso}` : ""}`);
    }
  }
  if (falliti) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await principale();
}
