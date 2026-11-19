// STRATO 4 · Permessi per ruolo.
// Qui si decide in codice cosa può fare ogni ruolo. Il modello non può
// allargare questi permessi nemmeno se glielo si chiede.
// Sono allineati a ciò che l'app già mostra: fatture solo al titolare,
// contratti e clienti non ai tecnici.

import type { Livello, Ruolo } from "./tipi.ts";

// Quali documenti può leggere ogni ruolo.
export const LIVELLI_PER_RUOLO: Record<Ruolo, Livello[]> = {
  tecnico: ["tutti"],
  ufficio: ["tutti", "ufficio"],
  admin: ["tutti", "ufficio", "admin"],
};

// Strumenti che scrivono (o meglio: che propongono una scrittura).
export const STRUMENTI_DI_SCRITTURA = ["proponi_azione"];

const BASE = ["cerca_documenti", "miei_interventi", "calendario_squadra"];
const UFFICIO = [...BASE, "scheda_cliente", "commesse", "contratti_manutenzione", "rapporti_recenti", "proponi_azione"];

const STRUMENTI_PER_RUOLO: Record<Ruolo, string[]> = {
  tecnico: BASE,
  ufficio: UFFICIO,
  admin: [...UFFICIO, "fatture"],
};

export function strumentiConsentiti(ruolo: Ruolo, scritturaAttiva: boolean): string[] {
  const tutti = STRUMENTI_PER_RUOLO[ruolo] ?? [];
  return scritturaAttiva ? [...tutti] : tutti.filter((s) => !STRUMENTI_DI_SCRITTURA.includes(s));
}

export function puoUsare(ruolo: Ruolo, strumento: string, scritturaAttiva: boolean): boolean {
  return strumentiConsentiti(ruolo, scritturaAttiva).includes(strumento);
}

// Solo il titolare approva le azioni, carica documenti e guarda tracce e stato.
export function puoAmministrare(ruolo: Ruolo): boolean {
  return ruolo === "admin";
}
