// ============================================================================
// Florial TIA — caricamento dei documenti (solo titolare)
// ============================================================================
// Riceve documenti già in forma di testo, li divide in pezzi e li salva.
// Corpo: { documenti: [ { codice?, titolo, tipo?, livello?, cliente?, versione?, testo } ] }
//   livello: "tutti" (anche i tecnici) | "ufficio" | "admin" (solo titolare)
// Un documento con lo stesso codice sostituisce il precedente.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { svuotaCache } from "../_shared/cache.ts";
import { intestazioniCors, json, leggiConfig } from "../_shared/config.ts";
import { cercaInjection } from "../_shared/guardrail.ts";
import { identifica } from "../_shared/identita.ts";
import { puoAmministrare } from "../_shared/permessi.ts";
import { dividiInPezzi } from "../_shared/pezzi.ts";
import { incorpora } from "../_shared/rag.ts";

const LIVELLI = ["tutti", "ufficio", "admin"];
const MAX_DOCUMENTI = 50;
const MAX_CARATTERI = 400_000;

async function improntaDi(testo: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(testo));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  if (!puoAmministrare(chi.utente.ruolo)) return json({ errore: "riservato al titolare" }, 403, cors);

  let corpo: { documenti?: unknown };
  try {
    corpo = await req.json();
  } catch (_) {
    return json({ errore: "richiesta non leggibile" }, 400, cors);
  }
  if (!Array.isArray(corpo.documenti) || corpo.documenti.length === 0) {
    return json({ errore: "serve un elenco «documenti»" }, 400, cors);
  }
  if (corpo.documenti.length > MAX_DOCUMENTI) {
    return json({ errore: `al massimo ${MAX_DOCUMENTI} documenti per volta` }, 400, cors);
  }

  const esiti: Record<string, unknown>[] = [];
  let cambiato = false;

  for (const grezzo of corpo.documenti as Record<string, unknown>[]) {
    const titolo = String(grezzo?.titolo ?? "").trim();
    const testo = String(grezzo?.testo ?? "").trim();
    const codice = String(grezzo?.codice ?? "").trim() || null;
    const nome = codice ?? titolo;

    if (!titolo || !testo) {
      esiti.push({ documento: nome || "(senza titolo)", esito: "scartato", motivo: "mancano titolo o testo" });
      continue;
    }
    if (testo.length > MAX_CARATTERI) {
      esiti.push({ documento: nome, esito: "scartato", motivo: "testo troppo lungo: va diviso" });
      continue;
    }
    // Un livello scritto male non deve mai diventare «tutti» per sbaglio.
    const livello = grezzo.livello === undefined ? "tutti" : String(grezzo.livello);
    if (!LIVELLI.includes(livello)) {
      esiti.push({ documento: nome, esito: "scartato", motivo: `livello «${livello}» non valido` });
      continue;
    }

    try {
      const impronta = await improntaDi(`${livello}|${titolo}|${testo}`);
      if (codice) {
        const { data: vecchio } = await servizio
          .from("tia_documenti")
          .select("id, impronta")
          .eq("codice", codice)
          .maybeSingle();
        if (vecchio?.impronta === impronta) {
          esiti.push({ documento: nome, esito: "invariato" });
          continue;
        }
        if (vecchio) await servizio.from("tia_documenti").delete().eq("id", vecchio.id);
      }

      const { data: nuovo, error } = await servizio
        .from("tia_documenti")
        .insert({
          codice,
          titolo,
          tipo: String(grezzo.tipo ?? "procedura"),
          livello,
          cliente: grezzo.cliente ? String(grezzo.cliente) : null,
          versione: grezzo.versione ? String(grezzo.versione) : null,
          impronta,
        })
        .select("id")
        .single();
      if (error || !nuovo) throw new Error(error?.message ?? "inserimento fallito");

      const pezzi = dividiInPezzi(testo);
      const righe = [];
      for (const p of pezzi) {
        const vettore = c.embedding === "nessuno"
          ? null
          : await incorpora(`${p.sezione ?? titolo}\n${p.testo}`, c);
        righe.push({
          documento_id: nuovo.id,
          ordine: p.ordine,
          sezione: p.sezione ?? titolo,
          testo: p.testo,
          embedding: vettore ? JSON.stringify(vettore) : null,
          modello_embedding: vettore ? c.embeddingModello : null,
        });
      }
      const { error: errPezzi } = await servizio.from("tia_pezzi").insert(righe);
      if (errPezzi) {
        await servizio.from("tia_documenti").delete().eq("id", nuovo.id);
        throw new Error(errPezzi.message);
      }

      cambiato = true;
      const sospetti = cercaInjection(testo);
      esiti.push({
        documento: nome,
        esito: "caricato",
        livello,
        pezzi: righe.length,
        ...(sospetti.length ? { avviso: `frasi da controllare: ${sospetti.join(", ")}` } : {}),
      });
    } catch (e) {
      esiti.push({ documento: nome, esito: "errore", motivo: e instanceof Error ? e.message : String(e) });
    }
  }

  if (cambiato) await svuotaCache(servizio);
  return json({ esiti }, 200, cors);
});
