// STRATO 6 · Cache.
// Si salvano solo le risposte nate dai documenti (procedure, manuale):
// cambiano di rado e la stessa domanda arriva da più persone.
// I dati vivi (calendario, clienti, fatture) non si mettono mai in cache.
// La chiave contiene il ruolo: un tecnico non riceve mai la risposta data al titolare.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Fonte, Ruolo } from "./tipi.ts";

export function normalizza(domanda: string): string {
  return domanda
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function chiaveCache(ruolo: Ruolo, domanda: string, versionePrompt: string): Promise<string> {
  const dati = new TextEncoder().encode(`${versionePrompt}|${ruolo}|${normalizza(domanda)}`);
  const impronta = await crypto.subtle.digest("SHA-256", dati);
  return Array.from(new Uint8Array(impronta)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function leggiCache(
  servizio: SupabaseClient,
  chiave: string,
): Promise<{ risposta: string; fonti: Fonte[] } | null> {
  const { data } = await servizio
    .from("tia_cache")
    .select("risposta, fonti")
    .eq("chiave", chiave)
    .gt("scade_il", new Date().toISOString())
    .maybeSingle();
  if (!data) return null;
  return { risposta: data.risposta as string, fonti: (data.fonti ?? []) as Fonte[] };
}

export async function scriviCache(
  servizio: SupabaseClient,
  chiave: string,
  risposta: string,
  fonti: Fonte[],
  giorni: number,
): Promise<void> {
  const scade = new Date(Date.now() + giorni * 86_400_000).toISOString();
  await servizio.from("tia_cache").upsert({ chiave, risposta, fonti, scade_il: scade });
}

// Dopo ogni caricamento di documenti la cache si svuota: niente risposte vecchie.
export async function svuotaCache(servizio: SupabaseClient): Promise<void> {
  await servizio.from("tia_cache").delete().neq("chiave", "");
}
