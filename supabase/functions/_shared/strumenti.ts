// STRATO 3 · Strumenti.
// Sono le «mani» di TIA: ogni strumento legge un pezzo dell'app, e solo quello
// che serve alla domanda (non tutto l'archivio a ogni messaggio).
// Ogni chiamata passa dal controllo dei permessi e legge i dati dell'app con
// l'accesso di chi ha fatto la domanda. L'unico strumento che non legge
// soltanto è proponi_azione, che non esegue niente: scrive una proposta in
// attesa di OK.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Config } from "./config.ts";
import { cercaInjection } from "./guardrail.ts";
import { MAPPA } from "./mappa.ts";
import type { DefStrumento } from "./modelli.ts";
import { LIVELLI_PER_RUOLO, puoUsare, strumentiConsentiti } from "./permessi.ts";
import { cerca, formattaPezzi } from "./rag.ts";
import { giornoRoma } from "./router.ts";
import type { Pezzo, Utente } from "./tipi.ts";

export interface Contesto {
  utente: Utente;
  servizio: SupabaseClient; // solo per le tabelle tia_
  dbUtente: SupabaseClient; // per i dati dell'app: valgono i permessi di chi chiede
  c: Config;
  adesso: Date;
  pezzi: Pezzo[]; // documenti letti in questa domanda (per le fonti)
  segnalazioni: string[]; // cose sospette trovate strada facendo
}

export interface Esito {
  esito: "ok" | "vuoto" | "non_collegato" | "negato" | "errore";
  testo: string;
}

export const TIPI_AZIONE = ["crea_cliente", "crea_sopralluogo", "crea_intervento", "nota_cliente"];

const PER_NOME = {
  type: "object",
  properties: { nome: { type: "string", description: "Nome o parte del nome del cliente (facoltativo)" } },
};

const DEFINIZIONI: DefStrumento[] = [
  {
    name: "cerca_documenti",
    description:
      "Cerca nei documenti aziendali di Florial (manuale operativo, procedure FLR, contratti, schede). " +
      "Usalo per ogni domanda su regole, procedure o contenuto di un documento. " +
      "Scrivi nella ricerca le parole chiave, non una frase intera.",
    input_schema: {
      type: "object",
      properties: { ricerca: { type: "string", description: "Parole chiave da cercare" } },
      required: ["ricerca"],
    },
  },
  {
    name: "miei_interventi",
    description:
      "Interventi di un giorno per chi sta scrivendo, con luogo, lavorazione, materiale da preparare, " +
      "telefono del referente e note di accesso. Per titolare e ufficio restituisce tutti gli interventi del giorno.",
    input_schema: {
      type: "object",
      properties: { giorno: { type: "string", description: "Data AAAA-MM-GG" } },
      required: ["giorno"],
    },
  },
  {
    name: "calendario_squadra",
    description:
      "Calendario di tutta la squadra tra due date: chi, dove, quando, che lavoro, stato. " +
      "Non contiene telefoni né note di accesso.",
    input_schema: {
      type: "object",
      properties: {
        dal: { type: "string", description: "Data AAAA-MM-GG" },
        al: { type: "string", description: "Data AAAA-MM-GG, al massimo 31 giorni dopo" },
      },
      required: ["dal", "al"],
    },
  },
  {
    name: "scheda_cliente",
    description: "Clienti e locali: ragione sociale, insegna, indirizzo, referente, contatti.",
    input_schema: {
      type: "object",
      properties: { nome: { type: "string", description: "Nome o parte del nome del cliente o del locale" } },
      required: ["nome"],
    },
  },
  {
    name: "commesse",
    description:
      "Commesse (trattative HubSpot) con cliente, fase, codice preventivo, importo, acconto e scadenza del saldo. " +
      "Senza nome restituisce tutte le commesse.",
    input_schema: PER_NOME,
  },
  {
    name: "contratti_manutenzione",
    description: "Contratti di manutenzione attivi con cliente, locale, canone, stato e prossima visita.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "rapporti_recenti",
    description: "Ultimi rapporti d'intervento: numero, data, cliente, esito. Si può filtrare per cliente.",
    input_schema: PER_NOME,
  },
  {
    name: "fatture",
    description:
      "Fatture e proforma (Fatture in Cloud): numero, data, cliente, totale, incassato, da incassare, scadenza. " +
      "Si può filtrare per cliente e chiedere solo quelle ancora da incassare.",
    input_schema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome o parte del nome del cliente (facoltativo)" },
        solo_da_incassare: { type: "boolean", description: "true = solo documenti con importo ancora da incassare" },
      },
    },
  },
  {
    name: "proponi_azione",
    description:
      "Prepara una proposta di azione che Flogert dovrà approvare. NON esegue nulla. " +
      "Usalo solo se chi scrive chiede esplicitamente di creare o registrare qualcosa.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: TIPI_AZIONE },
        dati: { type: "object", description: "I dati necessari, così come detti da chi scrive" },
        motivo: { type: "string", description: "Una riga: cosa è stato chiesto" },
      },
      required: ["tipo", "dati", "motivo"],
    },
  },
];

export function definizioniPer(utente: Utente, c: Config): DefStrumento[] {
  const consentiti = strumentiConsentiti(utente.ruolo, c.scrittura);
  return DEFINIZIONI.filter((d) => consentiti.includes(d.name));
}

// ---------------------------------------------------------------------------
// Aiuti
// ---------------------------------------------------------------------------
type Riga = Record<string, unknown>;

const NON_COLLEGATO = (cosa: string): Esito => ({
  esito: "non_collegato",
  testo: `Dato non disponibile: ${cosa} non è ancora collegato a TIA.`,
});

function dataValida(v: unknown, predefinita: string): string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : predefinita;
}

function perRicerca(v: unknown): string {
  return String(v ?? "").replace(/[%_,()\\*"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function semplice(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Toglie campi vuoti e tecnici (id, token, link) per tenere il risultato compatto.
export function pulisci(righe: unknown[] | null | undefined, via: string[] = []): Riga[] {
  return (righe ?? []).map((r) => {
    const o: Riga = {};
    for (const [k, v] of Object.entries(r as Riga)) {
      if (v === null || v === "" || via.includes(k) || k === "id" || k.endsWith("_id")) continue;
      o[k] = v;
    }
    return o;
  });
}

function comeTesto(righe: unknown[]): Esito {
  if (righe.length === 0) return { esito: "vuoto", testo: "Nessun risultato." };
  return { esito: "ok", testo: JSON.stringify(righe) };
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------
export interface Intervento {
  giorno: string;
  ora: string;
  locale: string;
  luogo: string;
  lavoro: string;
  stato: string;
  materiale: string;
  squadra: string;
  telefono_referente: string;
  note_accesso: string;
}

function daRiga(r: Riga): Intervento {
  const t = (v: unknown) => String(v ?? "").trim();
  const ora = [t(r.ora_inizio).slice(0, 5), t(r.ora_fine).slice(0, 5)].filter(Boolean).join("–");
  return {
    giorno: t(r.data).slice(0, 10),
    ora,
    locale: t(r.insegna) || t(r.commessa_titolo),
    luogo: [t(r.indirizzo), t(r.citta)].filter(Boolean).join(", "),
    lavoro: t(r.lavorazione) || t(r.commessa_titolo),
    stato: t(r.stato),
    materiale: t(r.materiale),
    squadra: t(r.tecnici),
    telefono_referente: t(r.telefono),
    note_accesso: t(r.note_accesso),
  };
}

// È nella squadra di questo intervento? La funzione calendario restituisce la
// squadra come elenco di «Nome Cognome» separati da virgola.
export function assegnatoA(squadra: string, nome: string): boolean {
  const io = semplice(nome);
  return io.length > 0 && squadra.split(",").some((n) => semplice(n) === io);
}

async function leggiCalendario(
  ctx: Contesto,
  dal: string,
  al: string,
): Promise<{ collegato: boolean; righe: Intervento[]; errore?: string }> {
  const m = MAPPA.calendario;
  if (!m.collegata) return { collegato: false, righe: [] };
  const { data, error } = await ctx.dbUtente.rpc(m.funzione, { da: dal, a: al });
  if (error) return { collegato: true, righe: [], errore: error.message };
  const righe = ((data ?? []) as Riga[]).map(daRiga).filter((r) => r.giorno >= dal && r.giorno <= al);
  return { collegato: true, righe };
}

// Il programma di un giorno: per un tecnico solo i suoi interventi, per
// titolare e ufficio tutti quelli della squadra.
export async function leggiProgramma(
  ctx: Contesto,
  giorno: string,
): Promise<{ collegato: boolean; soloMiei: boolean; righe: Intervento[]; errore?: string }> {
  const soloMiei = ctx.utente.ruolo === "tecnico";
  const r = await leggiCalendario(ctx, giorno, giorno);
  const righe = soloMiei ? r.righe.filter((x) => assegnatoA(x.squadra, ctx.utente.nome)) : r.righe;
  return { ...r, soloMiei, righe };
}

// Risposta già pronta, senza passare dal modello (percorso «diretto»).
export function formattaInterventi(etichetta: string, righe: Intervento[], soloMiei: boolean): string {
  if (righe.length === 0) {
    return soloMiei ? `${etichetta} non hai interventi in calendario.` : `${etichetta} non ci sono interventi in calendario.`;
  }
  const voci = righe.map((r, i) => {
    const testa = [r.ora, r.locale, r.luogo].filter(Boolean).join(" · ");
    const extra = [
      !soloMiei && r.squadra ? `Squadra: ${r.squadra}` : "",
      r.materiale ? `Da preparare: ${r.materiale}` : "",
      r.telefono_referente ? `Referente: ${r.telefono_referente}` : "",
      r.note_accesso ? `Accesso: ${r.note_accesso}` : "",
    ].filter(Boolean);
    return [`${i + 1}. ${testa}`, r.lavoro, ...extra].filter(Boolean).join("\n   ");
  });
  const quanti = righe.length === 1 ? "1 intervento" : `${righe.length} interventi`;
  const apertura = soloMiei ? `${etichetta} hai ${quanti}:` : `${etichetta} in calendario: ${quanti}.`;
  return `${apertura}\n\n${voci.join("\n\n")}`;
}

async function calendarioSquadra(ctx: Contesto, input: Riga): Promise<Esito> {
  const oggi = giornoRoma(ctx.adesso);
  const dal = dataValida(input.dal, oggi);
  let al = dataValida(input.al, dal);
  const limite = giornoRoma(new Date(dal + "T12:00:00Z"), 31);
  if (al < dal) al = dal;
  if (al > limite) al = limite;
  const r = await leggiCalendario(ctx, dal, al);
  if (!r.collegato) return NON_COLLEGATO("il calendario");
  if (r.errore) return { esito: "errore", testo: `Errore di lettura del calendario: ${r.errore}` };
  // Solo chi, dove, quando, che lavoro: telefono e note restano a chi è assegnato.
  return comeTesto(r.righe.map((x) => pulisci([{
    giorno: x.giorno,
    ora: x.ora,
    locale: x.locale,
    luogo: x.luogo,
    lavoro: x.lavoro,
    stato: x.stato,
    squadra: x.squadra,
  }])[0]));
}

// ---------------------------------------------------------------------------
// Clienti, commesse, contratti, rapporti, fatture
// ---------------------------------------------------------------------------
async function schedaCliente(ctx: Contesto, input: Riga): Promise<Esito> {
  const m = MAPPA.clienti;
  if (!m.collegata) return NON_COLLEGATO("l'anagrafica clienti");
  const nome = perRicerca(input.nome);
  if (nome.length < 2) return { esito: "errore", testo: "Serve almeno una parte del nome del cliente." };
  const { data, error } = await ctx.dbUtente.rpc(m.funzione, { termine: nome });
  if (error) return { esito: "errore", testo: `Errore di lettura dei clienti: ${error.message}` };
  return comeTesto(pulisci((data ?? []) as unknown[]).slice(0, 10));
}

async function commesse(ctx: Contesto, input: Riga): Promise<Esito> {
  const m = MAPPA.commesse;
  if (!m.collegata) return NON_COLLEGATO("l'elenco delle commesse");
  const nome = perRicerca(input.nome);
  let q = ctx.dbUtente.from(m.tabella).select("*");
  if (nome.length >= 2) q = q.ilike(m.colCliente, `%${nome}%`);
  const { data, error } = await q.limit(nome.length >= 2 ? 50 : 300);
  if (error) return { esito: "errore", testo: `Errore di lettura delle commesse: ${error.message}` };
  return comeTesto(pulisci((data ?? []) as unknown[], ["created_at", "updated_at"]));
}

async function contratti(ctx: Contesto): Promise<Esito> {
  const m = MAPPA.contratti;
  if (!m.collegata) return NON_COLLEGATO("l'elenco dei contratti");
  const { data, error } = await ctx.dbUtente.from(m.tabella).select(m.campi).eq(m.colArchiviata, false).limit(300);
  if (error) return { esito: "errore", testo: `Errore di lettura dei contratti: ${error.message}` };
  return comeTesto(pulisci((data ?? []) as unknown[]));
}

async function rapportiRecenti(ctx: Contesto, input: Riga): Promise<Esito> {
  const m = MAPPA.rapporti;
  if (!m.collegata) return NON_COLLEGATO("l'archivio dei rapporti");
  const nome = perRicerca(input.nome);
  let q = ctx.dbUtente.from(m.tabella).select(m.campi);
  if (nome.length >= 2) q = q.ilike(m.colCliente, `%${nome}%`);
  const { data, error } = await q.order(m.colOrdine, { ascending: false }).limit(40);
  if (error) return { esito: "errore", testo: `Errore di lettura dei rapporti: ${error.message}` };
  return comeTesto(pulisci((data ?? []) as unknown[]));
}

async function fatture(ctx: Contesto, input: Riga): Promise<Esito> {
  const m = MAPPA.fatture;
  if (!m.collegata) return NON_COLLEGATO("l'archivio fatture");
  const nome = perRicerca(input.nome);
  let q = ctx.dbUtente.from(m.tabella).select("*");
  if (nome.length >= 2) q = q.ilike(m.colCliente, `%${nome}%`);
  if (input.solo_da_incassare === true) q = q.gt(m.colDaIncassare, 0);
  const { data, error } = await q.order(m.colData, { ascending: false }).limit(80);
  if (error) return { esito: "errore", testo: `Errore di lettura delle fatture: ${error.message}` };
  return comeTesto(pulisci((data ?? []) as unknown[], m.nascondi));
}

// ---------------------------------------------------------------------------
// Documenti e proposte
// ---------------------------------------------------------------------------
async function cercaDocumenti(ctx: Contesto, input: Riga): Promise<Esito> {
  const ricerca = String(input.ricerca ?? "").trim().slice(0, 300);
  if (!ricerca) return { esito: "errore", testo: "Ricerca vuota." };
  // I livelli li decide il ruolo di chi chiede.
  const pezzi = await cerca(ctx.servizio, ricerca, LIVELLI_PER_RUOLO[ctx.utente.ruolo], ctx.c);
  for (const p of pezzi) {
    if (!ctx.pezzi.some((x) => x.pezzo_id === p.pezzo_id)) ctx.pezzi.push(p);
    for (const s of cercaInjection(p.testo)) {
      ctx.segnalazioni.push(`documento:${p.codice ?? p.titolo}:${s}`);
    }
  }
  return { esito: pezzi.length ? "ok" : "vuoto", testo: formattaPezzi(pezzi) };
}

async function proponiAzione(ctx: Contesto, input: Riga): Promise<Esito> {
  const tipo = String(input.tipo ?? "");
  if (!TIPI_AZIONE.includes(tipo)) return { esito: "errore", testo: "Tipo di azione non previsto." };
  const dati = input.dati && typeof input.dati === "object" ? input.dati : {};
  const { data, error } = await ctx.servizio
    .from("tia_azioni")
    .insert({
      richiesta_da: ctx.utente.id,
      richiesta_da_nome: ctx.utente.nome,
      tipo,
      dati,
      motivo: String(input.motivo ?? "").slice(0, 500),
    })
    .select("id")
    .single();
  if (error) return { esito: "errore", testo: `Proposta non salvata: ${error.message}` };
  return {
    esito: "ok",
    testo: `Proposta ${data.id} salvata e IN ATTESA di approvazione di Flogert. Nulla è stato eseguito.`,
  };
}

// ---------------------------------------------------------------------------
// Ingresso unico: prima i permessi, poi lo strumento
// ---------------------------------------------------------------------------
export async function esegui(nome: string, input: Riga, ctx: Contesto): Promise<Esito> {
  if (!puoUsare(ctx.utente.ruolo, nome, ctx.c.scrittura)) {
    ctx.segnalazioni.push(`strumento_negato:${nome}`);
    return { esito: "negato", testo: "Strumento non disponibile per chi sta scrivendo." };
  }
  try {
    switch (nome) {
      case "cerca_documenti":
        return await cercaDocumenti(ctx, input);
      case "miei_interventi": {
        const r = await leggiProgramma(ctx, dataValida(input.giorno, giornoRoma(ctx.adesso)));
        if (!r.collegato) return NON_COLLEGATO("il calendario");
        if (r.errore) return { esito: "errore", testo: `Errore di lettura del calendario: ${r.errore}` };
        return comeTesto(pulisci(r.righe));
      }
      case "calendario_squadra":
        return await calendarioSquadra(ctx, input);
      case "scheda_cliente":
        return await schedaCliente(ctx, input);
      case "commesse":
        return await commesse(ctx, input);
      case "contratti_manutenzione":
        return await contratti(ctx);
      case "rapporti_recenti":
        return await rapportiRecenti(ctx, input);
      case "fatture":
        return await fatture(ctx, input);
      case "proponi_azione":
        return await proponiAzione(ctx, input);
      default:
        return { esito: "errore", testo: "Strumento sconosciuto." };
    }
  } catch (e) {
    return { esito: "errore", testo: `Errore dello strumento: ${e instanceof Error ? e.message : String(e)}` };
  }
}
