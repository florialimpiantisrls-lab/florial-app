// STRATO 6 · Router.
// Decide quanto «costa» una domanda:
//   diretto  → nessuna AI: una lettura dal database e una risposta già formattata
//   piccolo  → modello piccolo ed economico (o locale, se configurato)
//   grande   → modello grande, solo per ufficio e titolare e solo quando serve

import type { Ruolo } from "./tipi.ts";

export type Instradamento =
  | { percorso: "diretto"; intento: "programma"; giorno: string; etichetta: string }
  | { percorso: "piccolo" }
  | { percorso: "grande"; motivo: string };

// Data di calendario a Firenze (AAAA-MM-GG), con spostamento in giorni.
export function giornoRoma(adesso: Date, spostamento = 0): string {
  const parti = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(adesso);
  const v = (tipo: string) => Number(parti.find((p) => p.type === tipo)?.value);
  const d = new Date(Date.UTC(v("year"), v("month") - 1, v("day") + spostamento));
  return d.toISOString().slice(0, 10);
}

// L'istante in cui a Firenze è scattata la mezzanotte di oggi (serve al tetto giornaliero).
export function mezzanotteRoma(adesso: Date): Date {
  const base = new Date(giornoRoma(adesso) + "T00:00:00Z");
  const parti = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(base);
  const v = (tipo: string) => Number(parti.find((p) => p.type === tipo)?.value);
  return new Date(base.getTime() - (v("hour") * 60 + v("minute")) * 60_000);
}

export function giornoDopo(giorno: string): string {
  const d = new Date(giorno + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const QUANDO: { schema: RegExp; spostamento: number; etichetta: string }[] = [
  { schema: /\bdopodomani\b/i, spostamento: 2, etichetta: "Dopodomani" },
  { schema: /\bdomani\b/i, spostamento: 1, etichetta: "Domani" },
  { schema: /\b(?:oggi|stamattina|stamani|stasera|adesso)\b/i, spostamento: 0, etichetta: "Oggi" },
];

const CHIEDE_IL_PROGRAMMA =
  /\b(?:chi\s+lavora|chi\s+c'?[eè]\s+in\s+giro|(?:che\s+)?(?:cosa\s+)?c'?[eè]\s+in\s+(?:programma|calendario)|dove\s+(?:vado|devo\s+andare|si\s+va|andiamo)|(?:che\s+)?cosa\s+(?:devo\s+fare|faccio|ho(?:\s+da\s+fare)?|c'?[eè]\s+da\s+fare)|cos'?\s?ho|che\s+(?:lavori|lavoro|interventi)\s+ho|(?:i\s+)?miei\s+(?:lavori|interventi)|(?:il\s+)?mio\s+programma|programma\s+di)\b/i;

const SERVE_IL_GRANDE =
  /\b(?:analizza\w*|analisi|confront\w+|strategi\w+|margin\w+|riepilog\w+|resocont\w+|valuta\w*|scenari\w*|pro\s+e\s+contro|preventiv\w+|andamento|previsione)\b/i;

export interface OpzioniRouter {
  conStoria: boolean; // la domanda continua una conversazione
  grandeDisponibile: boolean; // tetto giornaliero non superato e chiave presente
}

export function instrada(
  testo: string,
  ruolo: Ruolo,
  adesso: Date,
  opz: OpzioniRouter,
): Instradamento {
  const t = testo.trim();

  // 1) Domande di calendario secche: nessuna AI.
  if (!opz.conStoria && t.length <= 90 && CHIEDE_IL_PROGRAMMA.test(t)) {
    for (const q of QUANDO) {
      if (q.schema.test(t)) {
        return {
          percorso: "diretto",
          intento: "programma",
          giorno: giornoRoma(adesso, q.spostamento),
          etichetta: q.etichetta,
        };
      }
    }
  }

  // 2) Modello grande: mai per i tecnici, e solo se c'è margine nel tetto.
  if (ruolo !== "tecnico" && opz.grandeDisponibile) {
    if (t.length > 400) return { percorso: "grande", motivo: "domanda_lunga" };
    if (SERVE_IL_GRANDE.test(t)) return { percorso: "grande", motivo: "analisi" };
  }

  return { percorso: "piccolo" };
}
