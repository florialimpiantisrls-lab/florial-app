// ============================================================================
// Florial TIA — funzione principale
// ============================================================================
// Una sola porta d'ingresso per l'app. Il corpo della richiesta ha un «tipo»:
//   chiedi  → domanda a TIA                      (i ruoli elencati in TIA_RUOLI: all'inizio solo il titolare)
//   stato   → cosa è acceso e cosa è collegato   (solo titolare)
//   tracce  → ultime domande con il loro percorso (solo titolare)
//   azioni  → proposte in attesa di approvazione  (solo titolare)
//   decidi  → approva o rifiuta una proposta      (solo titolare)
// La chat già presente nell'app manda { messages: [ {role, content}, … ] } e si
// aspetta { ok, risposta } oppure { ok: false, errore }: quel formato è accettato
// così com'è, per cui nell'app basta cambiare il nome della funzione chiamata.
// ============================================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { chiaveCache, leggiCache, scriviCache } from "../_shared/cache.ts";
import { type Config, intestazioniCors, json, leggiConfig } from "../_shared/config.ts";
import { controllaIngresso, incartaDati, mascheraUscita } from "../_shared/guardrail.ts";
import { identifica } from "../_shared/identita.ts";
import { MAPPA } from "../_shared/mappa.ts";
import { chiamaClaude, chiamaLocale, type Messaggio, testoDi } from "../_shared/modelli.ts";
import { LIVELLI_PER_RUOLO, puoAmministrare } from "../_shared/permessi.ts";
import { promptFisso, promptVariabile, VERSIONE_PROMPT } from "../_shared/prompt.ts";
import { cerca, formattaPezzi } from "../_shared/rag.ts";
import { instrada, mezzanotteRoma } from "../_shared/router.ts";
import {
  type Contesto,
  definizioniPer,
  esegui,
  formattaInterventi,
  leggiProgramma,
} from "../_shared/strumenti.ts";
import { pulisciStoria } from "../_shared/storia.ts";
import { consumoDiOggi, registra } from "../_shared/tracce.ts";
import type { Fonte, Percorso, Pezzo, Utente } from "../_shared/tipi.ts";

const MAX_GIRI_STRUMENTI = 4;

// Esecutori delle azioni approvate. Vuoto apposta: nella prima versione TIA
// legge e basta. Un'azione si può approvare solo quando qui c'è il suo esecutore.
const ESECUTORI: Record<
  string,
  (servizio: SupabaseClient, dati: Record<string, unknown>) => Promise<string>
> = {};

function fontiDa(pezzi: Pezzo[]): Fonte[] {
  const viste = new Set<string>();
  const fonti: Fonte[] = [];
  for (const p of pezzi) {
    const k = `${p.codice}|${p.titolo}|${p.sezione}`;
    if (viste.has(k)) continue;
    viste.add(k);
    fonti.push({ codice: p.codice, titolo: p.titolo, sezione: p.sezione });
    if (fonti.length >= 5) break;
  }
  return fonti;
}

interface Risultato {
  risposta: string;
  percorso: Percorso;
  modello?: string;
  strumenti: { nome: string; esito: string }[];
  fonti: Fonte[];
  segnalazioni: string[];
  tokenIn: number;
  tokenOut: number;
  errore?: string;
}

async function conClaude(
  ctx: Contesto,
  modello: string,
  percorso: "piccolo" | "grande",
  storia: Messaggio[],
  domanda: string,
): Promise<Risultato> {
  const messaggi: Messaggio[] = [...storia, { role: "user", content: domanda }];
  const strumenti = definizioniPer(ctx.utente, ctx.c);
  const usati: { nome: string; esito: string }[] = [];
  let tokenIn = 0;
  let tokenOut = 0;
  let testo = "";

  for (let giro = 0; giro <= MAX_GIRI_STRUMENTI; giro++) {
    const r = await chiamaClaude({
      url: ctx.c.urlAnthropic,
      chiave: ctx.c.chiaveAnthropic,
      modello,
      sistemaFisso: promptFisso(ctx.utente.ruolo),
      sistemaVariabile: promptVariabile(ctx.utente, ctx.adesso),
      messaggi,
      // all'ultimo giro niente strumenti: il modello deve chiudere con una risposta
      strumenti: giro === MAX_GIRI_STRUMENTI ? [] : strumenti,
      maxToken: percorso === "grande" ? 1500 : 700,
    });
    tokenIn += r.tokenIn;
    tokenOut += r.tokenOut;

    if (r.motivoStop !== "tool_use") {
      testo = testoDi(r.blocchi);
      break;
    }

    messaggi.push({ role: "assistant", content: r.blocchi });
    const risultati: unknown[] = [];
    for (const b of r.blocchi) {
      if (b.type !== "tool_use" || !b.id || !b.name) continue;
      const e = await esegui(b.name, b.input ?? {}, ctx);
      usati.push({ nome: b.name, esito: e.esito });
      risultati.push({
        type: "tool_result",
        tool_use_id: b.id,
        content: incartaDati(b.name, e.testo, 14000),
      });
    }
    messaggi.push({ role: "user", content: risultati });
  }

  return {
    risposta: testo || "Non sono riuscita a chiudere la ricerca. Riprova con una domanda più precisa.",
    percorso,
    modello,
    strumenti: usati,
    fonti: fontiDa(ctx.pezzi),
    segnalazioni: ctx.segnalazioni,
    tokenIn,
    tokenOut,
  };
}

// Modello locale: prima si cercano i documenti, poi si chiede al modello di
// rispondere solo da quelli. Nessuno strumento, nessun dato vivo.
async function conLocale(ctx: Contesto, domanda: string): Promise<Risultato> {
  const pezzi = await cerca(ctx.servizio, domanda, LIVELLI_PER_RUOLO[ctx.utente.ruolo], ctx.c);
  ctx.pezzi.push(...pezzi);
  const sistema = `${promptFisso(ctx.utente.ruolo)}\n\n${promptVariabile(ctx.utente, ctx.adesso)}\n\n` +
    `Non hai strumenti. Rispondi solo con ciò che trovi qui sotto; se non basta, di' che non lo trovi nei documenti.\n\n` +
    incartaDati("documenti", formattaPezzi(pezzi));
  const r = await chiamaLocale(ctx.c.localeUrl, ctx.c.localeModello, sistema, domanda);
  return {
    risposta: r.testo,
    percorso: "locale",
    modello: ctx.c.localeModello,
    strumenti: [{ nome: "cerca_documenti", esito: pezzi.length ? "ok" : "vuoto" }],
    fonti: fontiDa(pezzi),
    segnalazioni: ctx.segnalazioni,
    tokenIn: r.tokenIn,
    tokenOut: r.tokenOut,
  };
}

async function chiedi(
  corpo: Record<string, unknown>,
  utente: Utente,
  servizio: SupabaseClient,
  dbUtente: SupabaseClient,
  c: Config,
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const inizio = Date.now();
  const adesso = new Date();
  const domanda = typeof corpo.messaggio === "string" ? corpo.messaggio.trim() : "";
  const ctx: Contesto = { utente, servizio, dbUtente, c, adesso, pezzi: [], segnalazioni: [] };

  const chiudi = async (r: Risultato) => {
    const uscita = mascheraUscita(r.risposta);
    const segnalazioni = [...new Set([...r.segnalazioni, ...uscita.mascherati.map((m) => `uscita:${m}`)])];
    const id = await registra(servizio, {
      utente,
      domanda,
      risposta: uscita.testo,
      percorso: r.percorso,
      modello: r.modello,
      strumenti: r.strumenti,
      fonti: r.fonti,
      segnalazioni,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      durataMs: Date.now() - inizio,
      errore: r.errore,
      versionePrompt: VERSIONE_PROMPT,
    });
    // Sempre 200: la chat dell'app legge «ok» e mostra «errore» in rosso.
    const ok = r.percorso !== "bloccato" && r.percorso !== "errore";
    return {
      stato: 200,
      corpo: {
        ok,
        risposta: uscita.testo,
        ...(ok ? {} : { errore: uscita.testo }),
        fonti: r.fonti,
        percorso: r.percorso,
        traccia: id,
      },
    };
  };
  const vuoto = { strumenti: [], fonti: [], segnalazioni: [], tokenIn: 0, tokenOut: 0 };

  // 1) Guardrail in ingresso
  const ingresso = controllaIngresso(corpo.messaggio);
  if (!ingresso.ok) {
    const testo = ingresso.motivo === "messaggio_troppo_lungo"
      ? "Il messaggio è troppo lungo. Dividilo in due domande."
      : "Non ho ricevuto nessuna domanda.";
    return chiudi({ ...vuoto, risposta: testo, percorso: "bloccato", errore: ingresso.motivo });
  }
  ctx.segnalazioni.push(...ingresso.segnalazioni);

  try {
    const storia = pulisciStoria(corpo.storia);
    const consumo = await consumoDiOggi(servizio, mezzanotteRoma(adesso).toISOString());
    const via = instrada(domanda, utente.ruolo, adesso, {
      conStoria: storia.length > 0,
      grandeDisponibile: Boolean(c.chiaveAnthropic) && consumo.grande < c.tettoTokenGrande,
    });

    // 2) Percorso diretto: nessuna AI
    if (via.percorso === "diretto") {
      const r = await leggiProgramma(ctx, via.giorno);
      if (r.collegato && !r.errore) {
        return chiudi({
          ...vuoto,
          risposta: formattaInterventi(via.etichetta, r.righe, r.soloMiei),
          percorso: "diretto",
          strumenti: [{ nome: "miei_interventi", esito: r.righe.length ? "ok" : "vuoto" }],
          segnalazioni: ctx.segnalazioni,
        });
      }
      // calendario non leggibile: si prosegue con il modello, che lo dirà in chiaro
    }

    // 3) Cache (solo domande singole, senza storia)
    const chiave = storia.length === 0 ? await chiaveCache(utente.ruolo, domanda, VERSIONE_PROMPT) : null;
    if (chiave) {
      const salvata = await leggiCache(servizio, chiave);
      if (salvata) {
        return chiudi({
          ...vuoto,
          risposta: salvata.risposta,
          percorso: "cache",
          fonti: salvata.fonti,
          segnalazioni: ctx.segnalazioni,
        });
      }
    }

    // 4) Tetto giornaliero
    if (consumo.totale >= c.tettoTokenGiorno) {
      return chiudi({
        ...vuoto,
        risposta: "Per oggi TIA ha raggiunto il tetto di utilizzo. Riparte domani; per le urgenze senti Flogert.",
        percorso: "bloccato",
        errore: "tetto_giornaliero",
        segnalazioni: ctx.segnalazioni,
      });
    }

    // 5) Modello
    let r: Risultato | null = null;
    if (via.percorso !== "grande" && c.localeUrl && c.localeModello && storia.length === 0) {
      try {
        r = await conLocale(ctx, domanda);
      } catch (_) {
        r = null; // il locale non risponde: si passa al modello via API
        ctx.segnalazioni.push("locale_non_raggiungibile");
      }
    }
    if (!r) {
      if (!c.chiaveAnthropic) {
        return chiudi({
          ...vuoto,
          risposta: "TIA non è ancora collegata a un modello. Va impostata la chiave API.",
          percorso: "errore",
          errore: "nessun_modello",
        });
      }
      const grande = via.percorso === "grande";
      r = await conClaude(ctx, grande ? c.modelloGrande : c.modelloPiccolo, grande ? "grande" : "piccolo", storia, domanda);
    }

    // 6) In cache solo le risposte nate dai soli documenti e senza segnalazioni
    const soloDocumenti = r.strumenti.length > 0 &&
      r.strumenti.every((s) => s.nome === "cerca_documenti" && s.esito === "ok");
    if (chiave && soloDocumenti && r.segnalazioni.length === 0) {
      await scriviCache(servizio, chiave, mascheraUscita(r.risposta).testo, r.fonti, c.cacheGiorni);
    }

    return chiudi(r);
  } catch (e) {
    const messaggio = e instanceof Error ? e.message : String(e);
    return chiudi({
      ...vuoto,
      risposta: "C'è stato un errore tecnico e non ho potuto rispondere. Riprova tra poco.",
      percorso: "errore",
      errore: messaggio.slice(0, 500),
      segnalazioni: ctx.segnalazioni,
    });
  }
}

async function conta(servizio: SupabaseClient, tabella: string, stato?: string): Promise<number | null> {
  let q = servizio.from(tabella).select("*", { count: "exact", head: true });
  if (stato) q = q.eq("stato", stato);
  const { count, error } = await q;
  return error ? null : count ?? 0;
}

async function stato(servizio: SupabaseClient, c: Config): Promise<Record<string, unknown>> {
  const consumo = await consumoDiOggi(servizio, mezzanotteRoma(new Date()).toISOString());
  return {
    versione_prompt: VERSIONE_PROMPT,
    modello: {
      chiave_api_presente: Boolean(c.chiaveAnthropic),
      piccolo: c.modelloPiccolo,
      grande: c.modelloGrande,
      locale: c.localeUrl && c.localeModello ? c.localeModello : "spento",
    },
    documenti: {
      caricati: await conta(servizio, "tia_documenti"),
      pezzi: await conta(servizio, "tia_pezzi"),
      vettori: c.embedding,
    },
    dati_app_collegati: Object.fromEntries(
      Object.entries(MAPPA).map(([nome, blocco]) => [nome, blocco.collegata]),
    ),
    ruoli_ammessi: c.ruoliAmmessi,
    scrittura: c.scrittura ? "proposte con approvazione" : "spenta (sola lettura)",
    azioni_in_attesa: await conta(servizio, "tia_azioni", "in_attesa"),
    oggi: {
      token_usati: consumo.totale,
      tetto_giorno: c.tettoTokenGiorno,
      token_modello_grande: consumo.grande,
      tetto_modello_grande: c.tettoTokenGrande,
    },
  };
}

async function decidi(
  corpo: Record<string, unknown>,
  utente: Utente,
  servizio: SupabaseClient,
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const id = String(corpo.id ?? "");
  const decisione = String(corpo.decisione ?? "");
  if (!id || !["approva", "rifiuta"].includes(decisione)) {
    return { stato: 400, corpo: { errore: "servono id e decisione (approva | rifiuta)" } };
  }
  const { data: azione } = await servizio.from("tia_azioni").select("*").eq("id", id).maybeSingle();
  if (!azione) return { stato: 404, corpo: { errore: "azione non trovata" } };
  if (azione.stato !== "in_attesa") {
    return { stato: 409, corpo: { errore: `azione già ${azione.stato}` } };
  }
  const firma = { deciso_da: utente.id, deciso_il: new Date().toISOString() };

  if (decisione === "rifiuta") {
    await servizio.from("tia_azioni").update({ ...firma, stato: "rifiutata" }).eq("id", id);
    return { stato: 200, corpo: { esito: "rifiutata" } };
  }

  const esecutore = ESECUTORI[azione.tipo as string];
  if (!esecutore) {
    return {
      stato: 409,
      corpo: { errore: `Per «${azione.tipo}» non c'è ancora un esecutore collegato: la proposta resta in attesa.` },
    };
  }
  try {
    const esito = await esecutore(servizio, (azione.dati ?? {}) as Record<string, unknown>);
    await servizio.from("tia_azioni").update({ ...firma, stato: "eseguita", esito }).eq("id", id);
    return { stato: 200, corpo: { esito: "eseguita", dettaglio: esito } };
  } catch (e) {
    const messaggio = e instanceof Error ? e.message : String(e);
    await servizio.from("tia_azioni").update({ ...firma, stato: "fallita", esito: messaggio }).eq("id", id);
    return { stato: 500, corpo: { errore: messaggio } };
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const c = leggiConfig();
  const cors = intestazioniCors(req, c);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ errore: "metodo non previsto" }, 405, cors);

  const servizio = createClient(c.url, c.chiaveServizio, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const chi = await identifica(req, servizio, c);
  if (!chi) return json({ errore: "accesso non riconosciuto" }, 401, cors);
  const { utente, dbUtente } = chi;

  let corpo: Record<string, unknown>;
  try {
    corpo = await req.json() as Record<string, unknown>;
  } catch (_) {
    return json({ errore: "richiesta non leggibile" }, 400, cors);
  }

  // Formato della chat già presente nell'app: l'ultimo messaggio è la domanda, il resto è la storia.
  if (corpo.tipo === undefined && Array.isArray(corpo.messages)) {
    const messaggi = (corpo.messages as Record<string, unknown>[])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    const ultimo = messaggi[messaggi.length - 1];
    corpo = {
      tipo: "chiedi",
      messaggio: ultimo?.role === "user" ? ultimo.content : "",
      storia: messaggi.slice(0, -1).map((m) => ({ ruolo: m.role === "user" ? "utente" : "tia", testo: m.content })),
    };
  }

  const tipo = String(corpo.tipo ?? "chiedi");

  if (tipo === "chiedi") {
    if (!c.ruoliAmmessi.includes(utente.ruolo)) {
      return json({ ok: false, errore: "Florial TIA è riservata all'amministratore" }, 403, cors);
    }
    const r = await chiedi(corpo, utente, servizio, dbUtente, c);
    return json(r.corpo, r.stato, cors);
  }

  // Da qui in giù: solo il titolare.
  if (!puoAmministrare(utente.ruolo)) return json({ errore: "riservato al titolare" }, 403, cors);

  if (tipo === "stato") return json(await stato(servizio, c), 200, cors);

  if (tipo === "tracce") {
    const quante = Math.min(Math.max(Number(corpo.quante) || 20, 1), 100);
    const { data } = await servizio.from("tia_tracce").select("*").order("id", { ascending: false }).limit(quante);
    return json({ tracce: data ?? [] }, 200, cors);
  }

  if (tipo === "azioni") {
    const { data } = await servizio
      .from("tia_azioni")
      .select("*")
      .eq("stato", "in_attesa")
      .order("creato_il", { ascending: true })
      .limit(50);
    return json({ azioni: data ?? [] }, 200, cors);
  }

  if (tipo === "decidi") {
    const r = await decidi(corpo, utente, servizio);
    return json(r.corpo, r.stato, cors);
  }

  return json({ errore: "tipo di richiesta sconosciuto" }, 400, cors);
});
