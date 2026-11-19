// STRATO 4 · Identità.
// Chi sta scrivendo lo dice il token di accesso dell'app (Supabase Auth),
// verificato da Supabase; nome e ruolo arrivano dalla tabella «utenti».
// Non si accetta mai un ruolo o un nome scritto nel corpo della richiesta.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Config } from "./config.ts";
import { MAPPA, MAPPA_RUOLI } from "./mappa.ts";
import type { Utente } from "./tipi.ts";

export interface Identita {
  utente: Utente;
  dbUtente: SupabaseClient; // legge con i permessi di chi chiede (RLS dell'app)
}

export async function identifica(
  req: Request,
  servizio: SupabaseClient,
  c: Config,
): Promise<Identita | null> {
  const intestazione = req.headers.get("Authorization") ?? "";
  const token = intestazione.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const dbUtente = createClient(c.url, c.chiavePubblica, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await dbUtente.auth.getUser(token);
  if (error || !data?.user) return null;
  const id = data.user.id;

  const m = MAPPA.profili;
  const k = m.col;
  const { data: riga } = await servizio
    .from(m.tabella)
    .select([k.riga, k.nome, k.cognome, k.ruolo, k.attivo].join(", "))
    .eq(k.accesso, id)
    .maybeSingle();
  if (!riga) return null; // ha un accesso ma non è nella squadra: fuori

  const r = riga as unknown as Record<string, unknown>;
  if (r[k.attivo] === false) return null; // utente disattivato dal titolare
  const ruolo = MAPPA_RUOLI[String(r[k.ruolo] ?? "").trim().toLowerCase()];
  if (!ruolo) return null; // ruolo sconosciuto: fuori

  const nome = [r[k.nome], r[k.cognome]].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ");
  return {
    utente: { id, rigaId: String(r[k.riga] ?? ""), nome: nome || "utente", ruolo },
    dbUtente,
  };
}
