// Configurazione: tutto arriva dai segreti di Supabase (mai nel codice, mai nell'app).

export interface Config {
  url: string;
  chiavePubblica: string;
  chiaveServizio: string;

  origini: string[]; // siti da cui l'app può chiamare TIA
  ruoliAmmessi: string[]; // chi può usare TIA: si allarga solo quando lo decide il titolare

  chiaveAnthropic: string;
  urlAnthropic: string; // si cambia solo per le prove o per passare da un proxy
  modelloPiccolo: string;
  modelloGrande: string;

  localeUrl: string; // server compatibile OpenAI (es. Ollama sul NAS), vuoto = spento
  localeModello: string;

  embedding: "nessuno" | "supabase" | "ollama";
  embeddingUrl: string;
  embeddingModello: string;

  scrittura: boolean; // se false, TIA non può nemmeno proporre azioni

  tettoTokenGiorno: number; // oltre questo, TIA risponde solo dai percorsi gratuiti
  tettoTokenGrande: number; // oltre questo, il modello grande si spegne fino a domani
  cacheGiorni: number;
}

function lista(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function numero(v: string, predefinito: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : predefinito;
}

export function leggiConfig(): Config {
  const e = (k: string, d = ""): string => Deno.env.get(k) ?? d;
  const emb = e("TIA_EMBEDDING", "nessuno");
  return {
    url: e("SUPABASE_URL"),
    chiavePubblica: e("SUPABASE_ANON_KEY") || e("SUPABASE_PUBLISHABLE_KEY"),
    chiaveServizio: e("SUPABASE_SERVICE_ROLE_KEY") || e("SUPABASE_SECRET_KEY"),

    origini: lista(e("TIA_ORIGINI", "*")),
    ruoliAmmessi: lista(e("TIA_RUOLI", "admin")),

    chiaveAnthropic: e("ANTHROPIC_API_KEY"),
    urlAnthropic: e("ANTHROPIC_API_URL", "https://api.anthropic.com").replace(/\/+$/, ""),
    modelloPiccolo: e("TIA_MODELLO_PICCOLO", "claude-haiku-5-5"),
    modelloGrande: e("TIA_MODELLO_GRANDE", "claude-sonnet-5-5"),

    localeUrl: e("TIA_LOCALE_URL").replace(/\/+$/, ""),
    localeModello: e("TIA_LOCALE_MODELLO"),

    embedding: emb === "supabase" || emb === "ollama" ? emb : "nessuno",
    embeddingUrl: e("TIA_EMBEDDING_URL").replace(/\/+$/, ""),
    embeddingModello: e("TIA_EMBEDDING_MODELLO", emb === "supabase" ? "gte-small" : ""),

    scrittura: e("TIA_SCRITTURA", "off") === "on",

    tettoTokenGiorno: numero(e("TIA_TETTO_TOKEN_GIORNO"), 1_500_000),
    tettoTokenGrande: numero(e("TIA_TETTO_TOKEN_GRANDE"), 300_000),
    cacheGiorni: numero(e("TIA_CACHE_GIORNI"), 7),
  };
}

export function intestazioniCors(req: Request, c: Config): Record<string, string> {
  const origine = req.headers.get("Origin") ?? "";
  const consentita = c.origini.includes("*")
    ? "*"
    : c.origini.includes(origine)
    ? origine
    : c.origini[0] ?? "";
  return {
    "Access-Control-Allow-Origin": consentita,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(corpo: unknown, stato: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(corpo), {
    status: stato,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}
