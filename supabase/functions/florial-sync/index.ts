// Florial Sync — riceve da Zapier solo un ID (trattativa HubSpot o documento Fatture in Cloud),
// rilegge i dati dalla fonte con chiavi in sola lettura (segreti Supabase) e aggiorna l'app.
// Una richiesta falsa può al massimo far rileggere dati veri: nessuna chiave passa da Zapier.
//
// Segreti richiesti (Edge Functions → Secrets): HUBSPOT_TOKEN, FIC_TOKEN
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili nelle Edge Functions.
// Deploy con "Verify JWT" disattivato (chiamata da Zapier senza login).
//
// Corpo accettato (JSON):
//   { "hubspot_deal_id": "530614499550" }
//   { "fic_document_id": 562220749 }
//   { "fic_cliente_piva": "01234567890" }   ← solo admin (login dell'app): rilegge tutte le fatture,
//                                            proforma e note di credito del cliente (pulsante nella scheda cliente)
// Risposta: { ok, azioni: [...], avvisi: [...] }
//
// 27/10/2026: salva anche gli incassi (rate di Fatture in Cloud) nelle colonne fatture.incassato, da_incassare,
// rate, pagamenti_agg (script SQL 20261027_scheda_cliente.sql; senza quelle colonne salva come prima).
// Risponde anche all'app (CORS). Il nome del locale (insegna) non viene più sovrascritto col nome della società.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FIC_COMPANY_ID = 489231;
const ORA_INIZIO = "08:30";
const ORA_FINE = "16:30";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Dict = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const risposta = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function hs(path: string): Promise<Dict> {
  const token = Deno.env.get("HUBSPOT_TOKEN");
  if (!token) throw new Error("Segreto HUBSPOT_TOKEN mancante");
  const r = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HubSpot ${r.status} su ${path}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function fic(path: string): Promise<Dict> {
  const token = Deno.env.get("FIC_TOKEN");
  if (!token) throw new Error("Segreto FIC_TOKEN mancante");
  const r = await fetch(`https://api-v2.fattureincloud.it/c/${FIC_COMPANY_ID}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Fatture in Cloud ${r.status} su ${path}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// Numero fase (1–9) dall'etichetta HubSpot "5 Accettato – attesa acconto"
const numFase = (label: string) => parseInt(label.trim(), 10) || 0;
const statoCommessa = (n: number) =>
  ({ 5: "accettata", 6: "in_esecuzione", 7: "collaudo", 8: "chiusa", 9: "annullata" } as Record<number, string>)[n] ?? null;

// "Viale Corsica 83, int. 1 – Firenze" → { via, citta }
function splitIndirizzo(txt: string) {
  const parti = txt.split(/\s+[–-]\s+/);
  if (parti.length > 1) return { via: parti.slice(0, -1).join(" – ").trim(), citta: parti[parti.length - 1].trim() };
  return { via: txt.trim(), citta: "" };
}

async function etichettaFase(pipeline: string, stageId: string): Promise<string> {
  const p = await hs(`/crm/v3/pipelines/deals/${pipeline || "default"}`);
  const st = (p.stages as Dict[] | undefined)?.find((x) => x.id === stageId);
  return s(st?.label) || stageId;
}

async function syncDeal(dealId: string) {
  const azioni: string[] = [];
  const avvisi: string[] = [];
  const props = [
    "dealname", "dealstage", "pipeline", "amount", "codice_prv", "indirizzo_lavori", "referente_sul_posto",
    "telefono_referente", "note_accesso", "lavorazioni_tecnici", "squadra_assegnata", "data_inizio_lavori",
    "data_fine_prevista", "documenti_fic", "scadenza_saldo", "acconto_incassato",
  ].join(",");
  const deal = await hs(`/crm/v3/objects/deals/${dealId}?properties=${props}&associations=companies,contacts`);
  const p = (deal.properties ?? {}) as Dict;
  const assoc = (deal.associations ?? {}) as Dict;
  const companyId = s(((assoc.companies as Dict)?.results as Dict[] | undefined)?.[0]?.id);
  const contactId = s(((assoc.contacts as Dict)?.results as Dict[] | undefined)?.[0]?.id);

  // Cliente (azienda se c'è, altrimenti contatto privato)
  let cliente = { nome: "", p_iva: "", telefono: "", email: "", indirizzo: "", citta: "", hubspot_id: "" };
  if (companyId) {
    const c = ((await hs(`/crm/v3/objects/companies/${companyId}?properties=name,phone,address,city,p_iva_fic`)).properties ?? {}) as Dict;
    cliente = { nome: s(c.name), p_iva: s(c.p_iva_fic), telefono: s(c.phone), email: "", indirizzo: s(c.address), citta: s(c.city), hubspot_id: companyId };
  } else if (contactId) {
    const c = ((await hs(`/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone,address,city`)).properties ?? {}) as Dict;
    cliente = { nome: `${s(c.firstname)} ${s(c.lastname)}`.trim(), p_iva: "", telefono: s(c.phone), email: s(c.email), indirizzo: s(c.address), citta: s(c.city), hubspot_id: contactId };
  }

  const fase = await etichettaFase(s(p.pipeline), s(p.dealstage));
  const n = numFase(fase);
  const importo = p.amount ? Number(p.amount) : null;

  // 1) Specchio commesse (sempre, tutte le fasi)
  {
    const { error } = await sb.from("commesse_hub").upsert({
      hubspot_id: dealId, nome: s(p.dealname), codice: s(p.codice_prv) || null, fase,
      pipeline: s(p.pipeline) || null, cliente: cliente.nome || null, importo, updated_at: new Date().toISOString(),
      // solo admin: documenti Fatture in Cloud e scadenze scritti su HubSpot dal workflow Fatture in Cloud → HubSpot
      documenti_fic: s(p.documenti_fic) || null, scadenza_saldo: s(p.scadenza_saldo) || null,
      acconto_incassato: s(p.acconto_incassato) === "true" ? true : (s(p.acconto_incassato) === "false" ? false : null),
    }, { onConflict: "hubspot_id" });
    if (error) throw new Error(`commesse_hub: ${error.message}`);
    azioni.push(`commessa aggiornata (fase ${fase})`);
  }

  const stato = statoCommessa(n);
  if (!stato) return { azioni, avvisi }; // fasi 1–4: solo tracciamento

  // 2) Cliente nell'anagrafica dell'app
  let clienteId: string | null = null;
  if (cliente.nome) {
    let q = await sb.from("clienti").select("id").eq("hubspot_id", cliente.hubspot_id).limit(1);
    if (!q.data?.length && cliente.p_iva) q = await sb.from("clienti").select("id").eq("p_iva", cliente.p_iva).limit(1);
    if (!q.data?.length) q = await sb.from("clienti").select("id").ilike("ragione_sociale", cliente.nome).limit(1);
    if (q.data?.length) {
      clienteId = q.data[0].id;
      await sb.from("clienti").update({ hubspot_id: cliente.hubspot_id }).eq("id", clienteId).is("hubspot_id", null);
    } else {
      const ins = await sb.from("clienti").insert({
        ragione_sociale: cliente.nome, telefono: cliente.telefono || null, email: cliente.email || null,
        indirizzo: cliente.indirizzo || null, citta: cliente.citta || null, p_iva: cliente.p_iva || null,
        hubspot_id: cliente.hubspot_id,
      }).select("id").single();
      if (ins.error) throw new Error(`clienti: ${ins.error.message}`);
      clienteId = ins.data.id;
      azioni.push("cliente creato");
    }
  }

  // 3) Locale = luogo dei lavori
  let localeId: string | null = null;
  const indirizzo = s(p.indirizzo_lavori);
  if (clienteId && indirizzo) {
    const { via, citta } = splitIndirizzo(indirizzo);
    const loc = {
      cliente_id: clienteId, insegna: cliente.nome, indirizzo: via, citta: citta || cliente.citta || null,
      referente: s(p.referente_sul_posto) || null, telefono: s(p.telefono_referente) || null,
      note_accesso: s(p.note_accesso) || null,
    };
    // stesso indirizzo anche con apostrofi, accenti o spazi diversi ("Via dell'Oriuolo" / "Via dell’Oriuolo")
    const normInd = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const q = await sb.from("locali").select("id,indirizzo").eq("cliente_id", clienteId);
    const esistente = (q.data ?? []).find((l) => normInd(s(l.indirizzo)) === normInd(via));
    if (esistente) {
      localeId = esistente.id;
      // non si sovrascrivono l'insegna del locale (es. il nome del bar) né i campi lasciati vuoti in HubSpot
      const aggiorna = Object.fromEntries(Object.entries(loc).filter(([k, v]) => k !== "insegna" && v !== null && v !== ""));
      await sb.from("locali").update(aggiorna).eq("id", localeId);
    } else {
      const ins = await sb.from("locali").insert(loc).select("id").single();
      if (ins.error) throw new Error(`locali: ${ins.error.message}`);
      localeId = ins.data.id;
      azioni.push("luogo dei lavori creato");
    }
  } else if (!indirizzo) {
    avvisi.push("Indirizzo lavori vuoto in HubSpot: il tecnico non vedrà dove andare");
  }

  // 4) Commessa operativa (senza prezzi per i tecnici: l'importo lo vede solo admin/ufficio)
  const comm = {
    codice: s(p.codice_prv) || null, cliente_id: clienteId, locale_id: localeId, titolo: s(p.dealname),
    descrizione: s(p.lavorazioni_tecnici) || null, stato, importo, hubspot_deal_id: dealId,
    data_scadenza: s(p.data_fine_prevista) || null, updated_at: new Date().toISOString(),
  };
  let commessaId: string;
  {
    const q = await sb.from("commesse").select("id").eq("hubspot_deal_id", dealId).limit(1);
    if (q.data?.length) {
      commessaId = q.data[0].id;
      const up = await sb.from("commesse").update(comm).eq("id", commessaId);
      if (up.error) throw new Error(`commesse: ${up.error.message}`);
    } else {
      const ins = await sb.from("commesse").insert(comm).select("id").single();
      if (ins.error) throw new Error(`commesse: ${ins.error.message}`);
      commessaId = ins.data.id;
      azioni.push("commessa operativa creata");
    }
  }

  // 5) Intervento in calendario solo con data inizio + squadra
  const data = s(p.data_inizio_lavori);
  const squadra = s(p.squadra_assegnata);
  if (!data || !squadra) {
    if (n === 5 || n === 6) avvisi.push("Manca data inizio lavori o squadra: niente in calendario");
    return { azioni, avvisi };
  }
  const origine = `hubspot:${dealId}`;
  const interv = {
    commessa_id: commessaId, titolo: s(p.dealname), descrizione: s(p.lavorazioni_tecnici) || null,
    data, ora_inizio: ORA_INIZIO, ora_fine: ORA_FINE, tipo: "commessa", origine, updated_at: new Date().toISOString(),
  };
  let intId: string;
  {
    const q = await sb.from("interventi").select("id,stato").eq("origine", origine).limit(1);
    if (q.data?.length) {
      intId = q.data[0].id;
      if (q.data[0].stato === "da_fare") await sb.from("interventi").update(interv).eq("id", intId);
      else avvisi.push(`Intervento già ${q.data[0].stato}: data non spostata`);
    } else {
      const ins = await sb.from("interventi").insert({ ...interv, stato: "da_fare" }).select("id").single();
      if (ins.error) throw new Error(`interventi: ${ins.error.message}`);
      intId = ins.data.id;
      azioni.push(`intervento in calendario il ${data}`);
    }
  }

  // Squadra: abbina i nomi agli utenti dell'app
  const { data: utenti } = await sb.from("utenti").select("id,nome,cognome").eq("attivo", true);
  const nomi = squadra.split(/,|\+|\be\b|\//i).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ids: string[] = [];
  for (const nome of nomi) {
    const u = (utenti ?? []).find((x) => {
      const pieno = `${s(x.nome)} ${s(x.cognome)}`.toLowerCase();
      return pieno === nome || pieno.startsWith(nome) || s(x.nome).toLowerCase() === nome;
    });
    if (u) ids.push(u.id); else avvisi.push(`Tecnico «${nome}» non trovato tra gli utenti dell'app`);
  }
  if (ids.length) {
    await sb.from("intervento_tecnici").delete().eq("intervento_id", intId);
    const ins = await sb.from("intervento_tecnici").insert(ids.map((t) => ({ intervento_id: intId, tecnico_id: t })));
    if (ins.error) throw new Error(`intervento_tecnici: ${ins.error.message}`);
    azioni.push(`squadra assegnata (${ids.length})`);
  }
  return { azioni, avvisi };
}

// Riga della tabella fatture da un documento di Fatture in Cloud (fieldset detailed)
function rigaFattura(d: Dict, docId?: number) {
  const e = (d.entity ?? {}) as Dict;
  const tipo = s(d.type);
  return {
    fic_id: docId ?? Number(d.id), numero: d.number ?? null, data: s(d.date) || null, cliente: s(e.name) || null,
    p_iva: s(e.vat_number) || s(e.tax_code) || null, oggetto: s(d.visible_subject) || null,
    imponibile: d.amount_net ?? null, iva: d.amount_vat ?? null, totale: d.amount_gross ?? null,
    scadenza: s(d.next_due_date) || null,
    tipo: tipo === "invoice" ? "fattura" : tipo === "proforma" ? "proforma" : "nota_credito",
  };
}

// Incassi dalle rate (payments_list): pagato, ancora da incassare e scadenze rata per rata
function incassi(d: Dict) {
  const lista = Array.isArray(d.payments_list) ? (d.payments_list as Dict[]) : [];
  if (!lista.length || s(d.type) === "credit_note") return { incassato: null, da_incassare: null, rate: null };
  let pagato = 0, residuo = 0; // in centesimi, per non accumulare errori di arrotondamento
  const rate = lista.map((p) => {
    const cent = Math.round((Number(p.amount) || 0) * 100);
    const pagata = s(p.status) === "paid";
    if (pagata) pagato += cent; else residuo += cent;
    return { scadenza: s(p.due_date) || null, importo: cent / 100, pagata, pagata_il: s(p.paid_date) || null };
  });
  return { incassato: pagato / 100, da_incassare: residuo / 100, rate };
}

let colonneIncassi = true; // diventa false (per la richiesta in corso) se il database non ha ancora le colonne degli incassi
const AVVISO_INCASSI = "Incassi non salvati: su Supabase va eseguito lo script SQL 20261027_scheda_cliente.sql";

async function salvaFattura(d: Dict, docId?: number) {
  const row = rigaFattura(d, docId);
  if (colonneIncassi) {
    const { error } = await sb.from("fatture")
      .upsert({ ...row, ...incassi(d), pagamenti_agg: new Date().toISOString() }, { onConflict: "fic_id" });
    if (!error) return row;
    if (!/incassato|da_incassare|rate|pagamenti_agg/.test(error.message)) throw new Error(`fatture: ${error.message}`);
    colonneIncassi = false; // colonne mancanti: si salva come prima, senza incassi
  }
  const { error } = await sb.from("fatture").upsert(row, { onConflict: "fic_id" });
  if (error) throw new Error(`fatture: ${error.message}`);
  return row;
}

async function syncFic(docId: number) {
  const r = await fic(`/issued_documents/${docId}?fieldset=detailed`);
  const d = (r.data ?? {}) as Dict;
  const tipo = s(d.type);
  if (!["invoice", "proforma", "credit_note"].includes(tipo)) return { azioni: [`documento ${tipo} ignorato`], avvisi: [] };
  const row = await salvaFattura(d, docId);
  return { azioni: [`${row.tipo} n. ${row.numero} aggiornata`], avvisi: colonneIncassi ? [] : [AVVISO_INCASSI] };
}

// Rilegge da Fatture in Cloud fatture, proforma e note di credito di un cliente (per P.IVA)
async function syncClienteFic(pivaGrezza: string) {
  const piva = pivaGrezza.toUpperCase().replace(/^\s*IT/, "").replace(/\D/g, "");
  if (piva.length < 8) throw new Error("P.IVA non valida");
  const azioni: string[] = [];
  for (const type of ["invoice", "proforma", "credit_note"]) {
    for (let page = 1; page <= 20; page++) {
      const q = encodeURIComponent(`entity.vat_number = '${piva}'`);
      const r = await fic(`/issued_documents?type=${type}&q=${q}&fieldset=detailed&per_page=50&page=${page}`);
      const lista = (Array.isArray(r.data) ? r.data : []) as Dict[];
      for (const d of lista) {
        const row = await salvaFattura(d);
        azioni.push(`${row.tipo} n. ${row.numero}`);
      }
      if (!lista.length || page >= (Number(r.last_page) || 1)) break;
    }
  }
  return { azioni, avvisi: colonneIncassi ? [] : [AVVISO_INCASSI] };
}

// Solo l'amministratore dell'app (token di login nella richiesta) può chiedere la rilettura di un cliente
async function eAdmin(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return false;
  const { data: me } = await sb.from("utenti").select("ruolo,attivo").eq("auth_user_id", data.user.id).maybeSingle();
  return !!me && me.ruolo === "admin" && me.attivo !== false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return risposta({ ok: false, errore: "Solo POST" }, 405);
  try {
    colonneIncassi = true;
    const body = await req.json().catch(() => ({})) as Dict;
    let esito;
    if (body.hubspot_deal_id) esito = await syncDeal(s(body.hubspot_deal_id).replace(/\D/g, ""));
    else if (body.fic_document_id) esito = await syncFic(Number(body.fic_document_id));
    else if (body.fic_cliente_piva) {
      if (!(await eAdmin(req))) return risposta({ ok: false, errore: "Aggiornamento riservato all'amministratore" }, 403);
      esito = await syncClienteFic(s(body.fic_cliente_piva));
    } else return risposta({ ok: false, errore: "Serve hubspot_deal_id, fic_document_id oppure fic_cliente_piva" }, 400);
    return risposta({ ok: true, ...esito });
  } catch (err) {
    return risposta({ ok: false, errore: (err as Error).message }, 500);
  }
});
