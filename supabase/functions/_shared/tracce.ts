// STRATO 7 · Osservabilità.
// Una riga per ogni domanda: chi, cosa ha chiesto, che strada ha preso,
// quali strumenti e documenti sono stati usati, quanti token, quanto tempo.
// Quando una risposta è sbagliata, da qui si capisce se è colpa del prompt,
// di un documento o di uno strumento.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Fonte, Percorso, Utente } from "./tipi.ts";

export interface Traccia {
  utente: Utente;
  domanda: string;
  risposta: string;
  percorso: Percorso;
  modello?: string;
  strumenti?: { nome: string; esito: string }[];
  fonti?: Fonte[];
  segnalazioni?: string[];
  tokenIn?: number;
  tokenOut?: number;
  durataMs: number;
  errore?: string;
  versionePrompt: string;
}

export async function registra(servizio: SupabaseClient, t: Traccia): Promise<number | null> {
  try {
    const { data } = await servizio
      .from("tia_tracce")
      .insert({
        utente_id: t.utente.id,
        utente_nome: t.utente.nome,
        ruolo: t.utente.ruolo,
        domanda: t.domanda.slice(0, 4000),
        risposta: t.risposta.slice(0, 8000),
        percorso: t.percorso,
        modello: t.modello ?? null,
        strumenti: t.strumenti ?? [],
        fonti: t.fonti ?? [],
        segnalazioni: t.segnalazioni ?? [],
        token_in: t.tokenIn ?? 0,
        token_out: t.tokenOut ?? 0,
        durata_ms: t.durataMs,
        errore: t.errore ?? null,
        versione_prompt: t.versionePrompt,
      })
      .select("id")
      .single();
    return (data?.id as number) ?? null;
  } catch (_) {
    return null; // la traccia non deve mai far fallire la risposta
  }
}

export interface Consumo {
  totale: number;
  grande: number;
}

// Token usati da mezzanotte (ora di Firenze).
export async function consumoDiOggi(servizio: SupabaseClient, inizioGiornoIso: string): Promise<Consumo> {
  const { data } = await servizio.rpc("tia_consumo", { p_da: inizioGiornoIso });
  const righe = (data ?? []) as { percorso: string; token: number }[];
  let totale = 0;
  let grande = 0;
  for (const r of righe) {
    totale += Number(r.token) || 0;
    if (r.percorso === "grande") grande += Number(r.token) || 0;
  }
  return { totale, grande };
}
