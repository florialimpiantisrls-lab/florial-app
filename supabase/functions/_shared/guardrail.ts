// STRATO 5 · Guardrail.
// Tre difese: controllo di ciò che entra, isolamento di ciò che TIA legge
// (documenti, schede, risultati degli strumenti) e mascheramento di ciò che esce.
// La difesa vera contro la prompt injection però è strutturale: TIA non ha
// strumenti che scrivono senza approvazione (vedi permessi.ts e tia_azioni).

export const MAX_CARATTERI = 4000;

const SCHEMI_INJECTION: { nome: string; schema: RegExp }[] = [
  { nome: "ignora_istruzioni", schema: /ignora\s+(?:tutte\s+)?(?:le\s+)?(?:tue\s+|precedenti\s+|sopra\s+)?(?:istruzioni|regole)/i },
  { nome: "ignore_instructions", schema: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|your)\s+(?:instructions|rules)/i },
  { nome: "dimentica", schema: /dimentica\s+(?:tutto|le\s+(?:tue\s+)?istruzioni|quanto\s+detto)/i },
  { nome: "nuovo_ruolo", schema: /(?:da\s+ora|d'ora\s+in\s+poi|from\s+now\s+on)[^.\n]{0,40}(?:sei|agisci|comportati|you\s+are|act\s+as)/i },
  { nome: "prompt_di_sistema", schema: /(?:system\s*prompt|prompt\s+di\s+sistema|istruzioni\s+di\s+sistema)/i },
  { nome: "rivela_istruzioni", schema: /(?:rivela|mostra|stampa|ripeti)\s+(?:le\s+)?(?:tue\s+)?istruzioni/i },
  { nome: "etichette_finte", schema: /<\/?\s*(?:system|assistant|istruzioni|dati_non_fidati)\b/i },
  { nome: "ordine_operativo", schema: /(?:rimborsa|bonifica|cancella|elimina|invia)\s+(?:subito\s+)?(?:tutt[ie]|ogni)\b/i },
];

// Cerca frasi tipiche da injection. Restituisce i nomi degli schemi trovati.
export function cercaInjection(testo: string): string[] {
  const trovati: string[] = [];
  for (const { nome, schema } of SCHEMI_INJECTION) {
    if (schema.test(testo)) trovati.push(nome);
  }
  return trovati;
}

export interface EsitoIngresso {
  ok: boolean;
  motivo?: string;
  segnalazioni: string[];
}

// Il messaggio dell'utente: chi scrive è una persona di Florial che ha fatto
// l'accesso, quindi non si blocca per una frase sospetta, ma si annota in traccia.
export function controllaIngresso(testo: unknown): EsitoIngresso {
  if (typeof testo !== "string" || testo.trim().length === 0) {
    return { ok: false, motivo: "messaggio_vuoto", segnalazioni: [] };
  }
  if (testo.length > MAX_CARATTERI) {
    return { ok: false, motivo: "messaggio_troppo_lungo", segnalazioni: [] };
  }
  return { ok: true, segnalazioni: cercaInjection(testo).map((n) => `ingresso:${n}`) };
}

// Avvolge materiale letto (documenti, risultati) in un contenitore che il
// prompt di sistema dichiara «solo dati». Si neutralizzano le etichette di
// chiusura per impedire a un testo di «uscire» dal contenitore.
export function incartaDati(etichetta: string, contenuto: string, massimo = 6000): string {
  let pulito = contenuto.replace(/<\s*\/?\s*dati_non_fidati[^>]*>/gi, "[etichetta rimossa]");
  if (pulito.length > massimo) pulito = pulito.slice(0, massimo) + "\n[…testo tagliato]";
  const nome = etichetta.replace(/[^a-z0-9_ -]/gi, "").slice(0, 60);
  return `<dati_non_fidati origine="${nome}">\n${pulito}\n</dati_non_fidati>`;
}

function luhn(cifre: string): boolean {
  let somma = 0;
  let doppio = false;
  for (let i = cifre.length - 1; i >= 0; i--) {
    let n = cifre.charCodeAt(i) - 48;
    if (doppio) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    somma += n;
    doppio = !doppio;
  }
  return somma % 10 === 0;
}

function ibanValido(iban: string): boolean {
  const girato = iban.slice(4) + iban.slice(0, 4);
  let resto = 0;
  for (const ch of girato) {
    const codice = ch.charCodeAt(0);
    const valore = codice >= 65 ? String(codice - 55) : ch; // A=10 … Z=35
    for (const cifra of valore) resto = (resto * 10 + (cifra.charCodeAt(0) - 48)) % 97;
  }
  return resto === 1;
}

export interface EsitoUscita {
  testo: string;
  mascherati: string[];
}

// Maschera nei testi in uscita i dati che non devono mai comparire in chat:
// IBAN, codici fiscali di persone, numeri di carta.
// (P.IVA, telefoni e codici EAN dei materiali NON vengono toccati.)
export function mascheraUscita(testo: string): EsitoUscita {
  const mascherati: string[] = [];
  let t = testo;

  t = t.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, (m) => {
    const compatto = m.replace(/ /g, "");
    // si maschera solo un IBAN vero (cifre di controllo giuste): così le sigle
    // dei materiali tipo «IP65 CAVO FG16 OR16» non vengono toccate
    if (compatto.length < 15 || compatto.length > 34 || !ibanValido(compatto)) return m;
    mascherati.push("iban");
    return "[IBAN nascosto]";
  });

  t = t.replace(/\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/g, () => {
    mascherati.push("codice_fiscale");
    return "[codice fiscale nascosto]";
  });

  t = t.replace(/\b\d(?:[ -]?\d){14,18}\b/g, (m) => {
    const cifre = m.replace(/[ -]/g, "");
    if (cifre.length < 15 || cifre.length > 19 || !luhn(cifre)) return m;
    mascherati.push("carta");
    return "[numero carta nascosto]";
  });

  return { testo: t, mascherati };
}
