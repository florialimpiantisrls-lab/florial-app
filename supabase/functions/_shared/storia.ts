// La storia della conversazione arriva dall'app a ogni domanda (il server non
// tiene memoria). Qui si tiene corta e si rimette in ordine: deve cominciare
// con un messaggio di chi scrive e finire con una risposta di TIA.

import type { Messaggio } from "./modelli.ts";
import type { TurnoStoria } from "./tipi.ts";

const MAX_TURNI = 6;
const MAX_CARATTERI_TURNO = 2000;

export function pulisciStoria(grezza: unknown): Messaggio[] {
  if (!Array.isArray(grezza)) return [];
  const turni = (grezza as TurnoStoria[])
    .filter((t) =>
      t && (t.ruolo === "utente" || t.ruolo === "tia") && typeof t.testo === "string" && t.testo.trim()
    )
    .slice(-MAX_TURNI);

  const messaggi: Messaggio[] = [];
  for (const t of turni) {
    const role = t.ruolo === "utente" ? "user" : "assistant";
    const testo = t.testo.slice(0, MAX_CARATTERI_TURNO);
    const ultimo = messaggi[messaggi.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content = `${ultimo.content}\n${testo}`;
    else messaggi.push({ role, content: testo });
  }
  while (messaggi.length && messaggi[0].role !== "user") messaggi.shift();
  while (messaggi.length && messaggi[messaggi.length - 1].role !== "assistant") messaggi.pop();
  return messaggi;
}
