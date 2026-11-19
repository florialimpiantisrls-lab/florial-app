// STRATO 2 · Ricerca nei documenti.
// La ricerca per parole in italiano funziona sempre e non costa niente.
// I vettori (embedding) sono un di più che si accende con TIA_EMBEDDING.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Config } from "./config.ts";
import type { Livello, Pezzo } from "./tipi.ts";

// Presente solo nell'ambiente delle Edge Function di Supabase.
declare const Supabase: {
  ai: { Session: new (modello: string) => { run(testo: string, opz: Record<string, unknown>): Promise<unknown> } };
} | undefined;

let sessione: { run(testo: string, opz: Record<string, unknown>): Promise<unknown> } | null = null;

export async function incorpora(testo: string, c: Config): Promise<number[] | null> {
  try {
    if (c.embedding === "supabase") {
      // gte-small: gratuito e già dentro Supabase, ma è un modello pensato per l'inglese.
      if (typeof Supabase === "undefined") return null;
      sessione ??= new Supabase.ai.Session("gte-small");
      const v = await sessione.run(testo.slice(0, 2000), { mean_pool: true, normalize: true });
      return Array.isArray(v) ? (v as number[]) : null;
    }
    if (c.embedding === "ollama" && c.embeddingUrl && c.embeddingModello) {
      const r = await fetch(`${c.embeddingUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: c.embeddingModello, input: testo.slice(0, 8000) }),
      });
      if (!r.ok) return null;
      const j = await r.json() as { embeddings?: number[][] };
      return j.embeddings?.[0] ?? null;
    }
  } catch (_) {
    // se i vettori non rispondono si va avanti con la sola ricerca per parole
  }
  return null;
}

export async function cerca(
  servizio: SupabaseClient,
  domanda: string,
  livelli: Livello[],
  c: Config,
  quanti = 6,
): Promise<Pezzo[]> {
  const vettore = c.embedding === "nessuno" ? null : await incorpora(domanda, c);
  const { data, error } = await servizio.rpc("tia_cerca", {
    p_domanda: domanda,
    p_livelli: livelli,
    p_embedding: vettore ? JSON.stringify(vettore) : null,
    p_modello: vettore ? c.embeddingModello : null,
    p_quanti: quanti,
  });
  if (error) throw new Error(`ricerca documenti: ${error.message}`);
  return (data ?? []) as Pezzo[];
}

export function formattaPezzi(pezzi: Pezzo[]): string {
  if (pezzi.length === 0) return "Nessun documento trovato per questa ricerca.";
  return pezzi
    .map((p) => {
      const testa = [p.codice, p.titolo, p.sezione].filter(Boolean).join(" · ");
      return `[${testa}]\n${p.testo}`;
    })
    .join("\n\n---\n\n");
}
