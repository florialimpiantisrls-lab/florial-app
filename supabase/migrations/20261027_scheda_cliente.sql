-- Florial (27/10/2026) · Scheda cliente
-- Toccando un cliente nell'app si apre la sua scheda: locali, commesse, contratti, fatture e incassi,
-- e la «storia» con i documenti (preventivi, addizionali, DiCo, contratti, lettere, verifiche…) e i PDF allegati.
--
-- Questo script prepara il database:
--   1) tabella documenti (storia del cliente) con permessi: admin e ufficio leggono e scrivono, solo admin cancella;
--   2) cartella privata «documenti» per i PDF e le foto allegati, con gli stessi permessi;
--   3) colonne per gli incassi delle fatture (rate di Fatture in Cloud) e per il periodo del canone dei contratti.
--
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova").
-- Solo aggiunte: non tocca né cancella dati esistenti. Si può rieseguire senza problemi.

-- 1) Tabella documenti -----------------------------------------------------------------------------
-- cliente_id e locale_id prendono lo stesso tipo di clienti.id e locali.id (uuid o numero).
do $$
declare
  t_cli text;
  t_loc text;
begin
  select format_type(a.atttypid, a.atttypmod) into t_cli
    from pg_attribute a
   where a.attrelid = 'public.clienti'::regclass and a.attname = 'id' and not a.attisdropped;
  select format_type(a.atttypid, a.atttypmod) into t_loc
    from pg_attribute a
   where a.attrelid = 'public.locali'::regclass and a.attname = 'id' and not a.attisdropped;

  execute format($f$
    create table if not exists public.documenti (
      id              uuid primary key default gen_random_uuid(),
      cliente_id      %s not null references public.clienti(id) on delete cascade,
      locale_id       %s references public.locali(id) on delete set null,
      commessa_hub_id text,
      data            date not null default current_date,
      tipo            text not null default 'altro',
      codice          text,
      titolo          text not null,
      descrizione     text,
      importo         numeric(12,2),
      stato           text,
      scadenza        date,
      url             text,
      file_path       text,
      file_nome       text,
      creato_da       text,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )$f$, t_cli, t_loc);
end $$;

comment on table public.documenti is
  'Storia del cliente nella scheda cliente dell''app: preventivi, addizionali, DiCo, contratti, lettere, verifiche, note. '
  'tipo: preventivo, addizionale, contratto, dico, verifica, progetto, lettera, sopralluogo, ordine, fornitore, intervento, nota, cartella, altro. '
  'stato: bozza, da_inviare, inviato, in_attesa, proposto, accettato, firmato, rifiutato, sostituito, annullato, consegnato, '
  'da_aggiornare, da_fatturare, da_chiarire, programmato, fatto, positivo, archiviato. '
  'file_path: percorso del file nella cartella privata «documenti»; url: link esterno (Drive, Fatture in Cloud…).';

create index if not exists documenti_cliente_data_idx on public.documenti (cliente_id, data desc);

alter table public.documenti enable row level security;

drop policy if exists documenti_lettura on public.documenti;
create policy documenti_lettura on public.documenti
  for select to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists documenti_inserimento on public.documenti;
create policy documenti_inserimento on public.documenti
  for insert to authenticated
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists documenti_modifica on public.documenti;
create policy documenti_modifica on public.documenti
  for update to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio'))
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists documenti_cancellazione on public.documenti;
create policy documenti_cancellazione on public.documenti
  for delete to authenticated
  using (public.mio_ruolo() = 'admin');

-- 2) Cartella privata per i file allegati (PDF e foto) ---------------------------------------------
-- I file si aprono dall'app con un link temporaneo: nessun link pubblico.
-- Se Supabase non permettesse di crearla da qui, lo script prosegue lo stesso (la storia funziona,
-- senza allegati): in quel caso crearla a mano da Storage → New bucket «documenti», privata.
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('documenti', 'documenti', false)
  on conflict (id) do nothing;

  execute 'drop policy if exists "documenti: lettura admin e ufficio" on storage.objects';
  execute $p$create policy "documenti: lettura admin e ufficio" on storage.objects
            for select to authenticated
            using (bucket_id = 'documenti' and public.mio_ruolo() in ('admin', 'ufficio'))$p$;

  execute 'drop policy if exists "documenti: caricamento admin e ufficio" on storage.objects';
  execute $p$create policy "documenti: caricamento admin e ufficio" on storage.objects
            for insert to authenticated
            with check (bucket_id = 'documenti' and public.mio_ruolo() in ('admin', 'ufficio'))$p$;

  execute 'drop policy if exists "documenti: modifica admin e ufficio" on storage.objects';
  execute $p$create policy "documenti: modifica admin e ufficio" on storage.objects
            for update to authenticated
            using (bucket_id = 'documenti' and public.mio_ruolo() in ('admin', 'ufficio'))$p$;

  execute 'drop policy if exists "documenti: cancellazione solo admin" on storage.objects';
  execute $p$create policy "documenti: cancellazione solo admin" on storage.objects
            for delete to authenticated
            using (bucket_id = 'documenti' and public.mio_ruolo() = 'admin')$p$;
exception when others then
  raise warning 'Cartella file «documenti» non pronta: %', sqlerrm;
end $$;

-- 3) Incassi delle fatture e periodo del canone ----------------------------------------------------
-- Le compila florial-sync dalle rate di Fatture in Cloud (payments_list).
-- rate: [{ "scadenza": "2026-10-31", "importo": 500.00, "pagata": false, "pagata_il": null }, …]
alter table public.fatture add column if not exists incassato     numeric(12,2);
alter table public.fatture add column if not exists da_incassare  numeric(12,2);
alter table public.fatture add column if not exists rate          jsonb;
alter table public.fatture add column if not exists pagamenti_agg timestamptz;
create index if not exists fatture_p_iva_idx on public.fatture (p_iva);

-- Periodo del canone: 'mese', 'trimestre' o 'anno'. Vuoto = trimestre (come prima).
alter table public.contratti_manutenzione add column if not exists canone_periodo text;

-- Esito: 1 = pronto
select 'Scheda cliente: script eseguito' as esito,
       (select count(*) from information_schema.tables
         where table_schema = 'public' and table_name = 'documenti')                       as tabella_documenti,
       (select count(*) from storage.buckets where id = 'documenti')                       as cartella_file,
       (select count(*) from pg_policies
         where schemaname = 'storage' and tablename = 'objects' and policyname like 'documenti:%') as permessi_file_su_4,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'fatture' and column_name = 'rate')  as colonne_incassi;
