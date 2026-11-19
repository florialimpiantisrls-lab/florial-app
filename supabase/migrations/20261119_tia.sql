-- ============================================================================
-- Florial TIA — base dati
-- Solo tabelle nuove con prefisso tia_. Non tocca nessuna tabella dell'app.
-- Si può rieseguire senza danni (if not exists / create or replace).
-- ============================================================================

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- STRATO 2 · Documenti (RAG)
-- ---------------------------------------------------------------------------
create table if not exists tia_documenti (
  id            uuid primary key default gen_random_uuid(),
  codice        text,                                  -- es. FLR-OPE-03, PRV-058/2026
  titolo        text not null,
  tipo          text not null default 'procedura',     -- procedura, manuale, contratto, preventivo, scheda...
  livello       text not null default 'tutti'
                check (livello in ('tutti', 'ufficio', 'admin')),
  cliente       text,
  versione      text,
  impronta      text not null,                         -- sha256 del testo: serve a saltare i ricaricamenti identici
  creato_il     timestamptz not null default now()
);

create unique index if not exists tia_documenti_codice_idx
  on tia_documenti (codice) where codice is not null;

create table if not exists tia_pezzi (
  id                 bigint generated always as identity primary key,
  documento_id       uuid not null references tia_documenti (id) on delete cascade,
  ordine             int  not null,
  sezione            text,
  testo              text not null,
  ricerca            tsvector generated always as
                     (to_tsvector('italian', coalesce(sezione, '') || ' ' || testo)) stored,
  embedding          vector,                           -- facoltativo: senza dimensione fissa, vedi README
  modello_embedding  text
);

create index if not exists tia_pezzi_ricerca_idx   on tia_pezzi using gin (ricerca);
create index if not exists tia_pezzi_documento_idx on tia_pezzi (documento_id);

-- Ricerca ibrida: testo italiano sempre, vettori solo se arriva p_embedding.
-- p_livelli lo decide il codice in base al ruolo di chi chiede, mai il modello.
create or replace function tia_cerca(
  p_domanda   text,
  p_livelli   text[],
  p_embedding vector default null,
  p_modello   text   default null,
  p_quanti    int    default 6
)
returns table (
  pezzo_id     bigint,
  documento_id uuid,
  codice       text,
  titolo       text,
  sezione      text,
  testo        text,
  punteggio    real
)
language sql
stable
as $$
  with q as (
    -- le parole della domanda in OR: basta che un pezzo ne contenga alcune
    select string_agg(t::text, ' | ')::tsquery as tsq
    from (
      select plainto_tsquery('italian', w) as t
      from regexp_split_to_table(coalesce(p_domanda, ''), '\s+') as w
    ) s
    where numnode(t) > 0
  ),
  testuale as (
    select p.id,
           row_number() over (order by ts_rank_cd(p.ricerca, q.tsq) desc, p.id) as pos
    from tia_pezzi p
    join tia_documenti d on d.id = p.documento_id
    cross join q
    where d.livello = any (p_livelli)
      and p.ricerca @@ q.tsq
    order by ts_rank_cd(p.ricerca, q.tsq) desc, p.id
    limit 30
  ),
  vettoriale as (
    select p.id,
           row_number() over (order by p.embedding <=> p_embedding, p.id) as pos
    from tia_pezzi p
    join tia_documenti d on d.id = p.documento_id
    where p_embedding is not null
      and p.embedding is not null
      and p.modello_embedding = p_modello
      and d.livello = any (p_livelli)
    order by p.embedding <=> p_embedding, p.id
    limit 30
  ),
  fusi as (
    select x.id, sum(1.0 / (60 + x.pos)) as punti
    from (select id, pos from testuale union all select id, pos from vettoriale) x
    group by x.id
  )
  select p.id, d.id, d.codice, d.titolo, p.sezione, p.testo, f.punti::real
  from fusi f
  join tia_pezzi p     on p.id = f.id
  join tia_documenti d on d.id = p.documento_id
  order by f.punti desc, p.id
  limit greatest(1, least(coalesce(p_quanti, 6), 20));
$$;

-- ---------------------------------------------------------------------------
-- STRATO 5 · Azioni in attesa di approvazione (nessuna scrittura senza OK)
-- ---------------------------------------------------------------------------
create table if not exists tia_azioni (
  id                 uuid primary key default gen_random_uuid(),
  creato_il          timestamptz not null default now(),
  richiesta_da       text not null,
  richiesta_da_nome  text,
  tipo               text not null,
  dati               jsonb not null default '{}'::jsonb,
  motivo             text,
  stato              text not null default 'in_attesa'
                     check (stato in ('in_attesa', 'approvata', 'rifiutata', 'eseguita', 'fallita')),
  deciso_da          text,
  deciso_il          timestamptz,
  esito              text
);

create index if not exists tia_azioni_stato_idx on tia_azioni (stato, creato_il desc);

-- ---------------------------------------------------------------------------
-- STRATO 6 · Cache delle risposte da documenti
-- ---------------------------------------------------------------------------
create table if not exists tia_cache (
  chiave     text primary key,
  risposta   text not null,
  fonti      jsonb not null default '[]'::jsonb,
  creato_il  timestamptz not null default now(),
  scade_il   timestamptz not null
);

-- ---------------------------------------------------------------------------
-- STRATO 7 · Tracce: una riga per ogni domanda
-- ---------------------------------------------------------------------------
create table if not exists tia_tracce (
  id               bigint generated always as identity primary key,
  creato_il        timestamptz not null default now(),
  utente_id        text,
  utente_nome      text,
  ruolo            text,
  domanda          text,
  risposta         text,
  percorso         text not null,     -- diretto | cache | locale | piccolo | grande | bloccato | errore
  modello          text,
  strumenti        jsonb not null default '[]'::jsonb,
  fonti            jsonb not null default '[]'::jsonb,
  segnalazioni     jsonb not null default '[]'::jsonb,
  token_in         int not null default 0,
  token_out        int not null default 0,
  durata_ms        int,
  errore           text,
  versione_prompt  text
);

create index if not exists tia_tracce_creato_idx on tia_tracce (creato_il desc);

-- Consumo di token da un certo momento in poi, diviso per percorso (serve al tetto giornaliero)
create or replace function tia_consumo(p_da timestamptz)
returns table (percorso text, domande bigint, token bigint)
language sql
stable
as $$
  select t.percorso, count(*)::bigint, coalesce(sum(t.token_in + t.token_out), 0)::bigint
  from tia_tracce t
  where t.creato_il >= p_da
  group by t.percorso;
$$;

-- ---------------------------------------------------------------------------
-- Sicurezza: RLS accesa e nessuna policy.
-- Queste tabelle le legge e le scrive solo la funzione TIA (chiave di servizio).
-- Dall'app, con la chiave pubblica, non si vede niente.
-- ---------------------------------------------------------------------------
alter table tia_documenti enable row level security;
alter table tia_pezzi     enable row level security;
alter table tia_azioni    enable row level security;
alter table tia_cache     enable row level security;
alter table tia_tracce    enable row level security;
