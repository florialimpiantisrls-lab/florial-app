// Florial TIA — assistente dell'amministratore dentro l'app Florial (livello 1: legge e risponde).
//
// Chi può usarla: solo gli utenti con ruolo "admin" nella tabella utenti.
// Cosa legge: calendario lavori, commesse (HubSpot), fatture/proforma, contratti di manutenzione,
// rapporti, clienti e locali — sempre con il login dell'utente (RLS attiva), mai con la chiave di servizio.
// Cosa NON fa: non scrive, non modifica e non cancella nulla.
//
// Segreti richiesti (Edge Functions → Secrets): ANTHROPIC_API_KEY  (facoltativo: TIA_MODEL)
// SUPABASE_URL e SUPABASE_ANON_KEY sono già disponibili nelle Edge Functions.
// Deploy con "Verify JWT" attivo.
//
// Corpo: { "messages": [ { "role": "user"|"assistant", "content": "…" }, … ] }
// Risposta: { ok: true, risposta: "…" }  oppure  { ok: false, errore: "…" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Dict = Record<string, unknown>;

// Toglie campi vuoti e tecnici per tenere il contesto compatto
function pulisci<T>(rows: T[] | null | undefined, via: string[] = []): Dict[] {
  return (rows ?? []).map((r) => {
    const o: Dict = {};
    for (const [k, v] of Object.entries(r as Dict)) {
      if (v === null || v === "" || via.includes(k) || k.endsWith("_id") || k === "id") continue;
      o[k] = v;
    }
    return o;
  });
}

const isoGiorno = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, errore: "Metodo non consentito" }, 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ ok: false, errore: "Segreto ANTHROPIC_API_KEY mancante su Supabase" });

    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });

    // Solo admin
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ ok: false, errore: "Accesso non valido: rientra nell'app" }, 401);
    const { data: me } = await sb.from("utenti").select("nome,cognome,ruolo,attivo")
      .eq("auth_user_id", u.user.id).maybeSingle();
    if (!me || me.ruolo !== "admin" || me.attivo === false) {
      return json({ ok: false, errore: "Florial TIA è riservata all'amministratore" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: Dict) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-16)
      .map((m: Dict) => ({ role: m.role, content: String(m.content).slice(0, 6000) }));
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return json({ ok: false, errore: "Scrivi una domanda" }, 400);
    }

    // ---- Dati dell'app (sola lettura, con i permessi dell'utente) ----
    const oggi = new Date();
    const da = isoGiorno(new Date(oggi.getTime() - 30 * 864e5));
    const a = isoGiorno(new Date(oggi.getTime() + 90 * 864e5));
    const [cal, comm, fatt, contr, rap, loc] = await Promise.all([
      sb.rpc("calendario", { da, a }),
      sb.from("commesse_hub").select("*").limit(300),
      sb.from("fatture").select("*").order("numero", { ascending: false }).limit(150),
      sb.from("contratti_manutenzione")
        .select("codice,canone,stato,prossima_visita,reverse_charge,clienti(ragione_sociale),locali(insegna,citta)")
        .eq("archiviata", false).limit(300),
      sb.from("rapporti").select("numero,data,ragione_sociale,esito,origine").order("created_at", { ascending: false }).limit(60),
      sb.rpc("cerca_locale", { termine: "" }),
    ]);

    const dati = {
      calendario_lavori: pulisci(cal.data as Dict[], ["intervento_id", "commessa_id"]),
      commesse_hubspot: pulisci(comm.data as Dict[], ["created_at", "updated_at"]),
      fatture_e_proforma: pulisci(fatt.data as Dict[], ["created_at", "updated_at", "url", "permanent_token"]),
      contratti_manutenzione: pulisci(contr.data as Dict[]),
      rapporti_recenti: pulisci(rap.data as Dict[]),
      clienti_e_locali: pulisci((loc.data as Dict[] ?? []).slice(0, 400)),
    };
    const nonLetti = Object.entries({ cal, comm, fatt, contr, rap, loc })
      .filter(([, r]) => (r as { error: unknown }).error).map(([k]) => k);

    const giorno = oggi.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Rome" });
    const ora = oggi.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });

    const system = `Sei Florial TIA, l'assistente dell'amministratore di Florial Impianti S.r.l.s. (impianti elettrici, settore HoReCa, Firenze; Amministratore Unico ${me.nome ?? ""} ${me.cognome ?? ""}).
Oggi è ${giorno}, ore ${ora} (ora di Roma).

Come lavori:
- Rispondi sempre in italiano, in modo diretto e operativo, frasi brevi. Le domande arrivano spesso dettate a voce: interpreta gli errori di dettatura senza farli notare.
- Usa SOLO i dati qui sotto (estratto dell'app aggiornato a ora). Se un dato non c'è, dillo chiaramente e indica dove andrebbe inserito (HubSpot, Fatture in Cloud, app). Non inventare mai nomi, importi, date o stati.
- Sei in sola lettura: non puoi creare, modificare o cancellare nulla. Se ti chiedono di farlo, spiega in una riga cosa andrebbe fatto e dove; le azioni con conferma arriveranno in una versione successiva.
- Elenchi brevi quando servono (lavori di un giorno, scadenze, cosa manca). Importi in euro con la virgola (es. € 1.164,88). Date in formato gg/mm.
- Regole Florial da tenere presenti: pagamenti 50% acconto alla conferma (inizio lavori subordinato all'incasso), 30% a SAL, 20% saldo a 30 gg fine mese; fase HubSpot 6 "In esecuzione" solo con acconto incassato, fase 8 solo con saldo; reverse charge solo B2B edile/impiantistico, IVA ordinaria per i privati; ogni ordine fornitore richiede conferma d'ordine scritta.
- Fasi commesse HubSpot: 1 Nuovo contatto, 2 Sopralluogo fatto, 3 Preventivo in preparazione, 4 Preventivo inviato, 5 Accettato – attesa acconto, 6 In esecuzione, 7 Collaudo e documenti, 8 Chiusa vinta, 9 Persa/annullata (usa l'etichetta che trovi nei dati se diversa).
${nonLetti.length ? `- Attenzione: non è stato possibile leggere: ${nonLetti.join(", ")}.` : ""}

DATI DELL'APP (JSON):
${JSON.stringify(dati)}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("TIA_MODEL") || "claude-sonnet-5-5",
        max_tokens: 1500,
        system,
        messages,
      }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (out as Dict)?.error ? JSON.stringify((out as Dict).error).slice(0, 300) : `HTTP ${r.status}`;
      return json({ ok: false, errore: `Claude non ha risposto (${r.status}): ${msg}` });
    }
    const testo = ((out as Dict).content as Dict[] ?? [])
      .filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    return json({ ok: true, risposta: testo || "Nessuna risposta." });
  } catch (e) {
    return json({ ok: false, errore: String((e as Error).message ?? e).slice(0, 300) }, 500);
  }
});
