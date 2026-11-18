-- Florial (18/11/2026) · Istruzioni e video della commessa
-- Dentro ogni commessa (e nel dettaglio del lavoro) l'app mostra la sezione «Istruzioni e video»:
-- video di formazione, checklist, schemi e foto che servono ai ragazzi per fare il lavoro.
--
-- Questo script prepara il database:
--   1) tabella istruzioni_commessa: la vedono tutti gli utenti dell'app (admin, ufficio, tecnici);
--      admin e ufficio aggiungono e modificano; solo l'admin cancella;
--   2) cartella privata «istruzioni» per i file (video, PDF, foto, massimo 50 MB ciascuno),
--      con gli stessi permessi. I file si aprono dall'app con un link temporaneo di un'ora.
--
-- commessa_ref = id della trattativa HubSpot, come per i moduli operativi (sopralluoghi, distinte…).
--
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova").
-- Solo aggiunte: non tocca né cancella dati esistenti. Si può rieseguire senza problemi.

-- 1) Tabella ------------------------------------------------------------------------------------------
create table if not exists public.istruzioni_commessa (
  id            uuid primary key default gen_random_uuid(),
  commessa_ref  text not null,
  codice        text,
  titolo        text not null,
  tipo          text not null default 'altro',
  file_path     text,
  file_nome     text,
  url           text,
  ordine        integer not null default 0,
  creato_da     text,
  created_at    timestamptz not null default now()
);

comment on table public.istruzioni_commessa is
  'Istruzioni e video della commessa (sezione «Istruzioni e video» dell''app). '
  'commessa_ref: id trattativa HubSpot. tipo: video, pdf, foto, link, altro. '
  'file_path: percorso nella cartella privata «istruzioni»; url: link esterno.';

create index if not exists istruzioni_commessa_ref_idx on public.istruzioni_commessa (commessa_ref, ordine);

alter table public.istruzioni_commessa enable row level security;

drop policy if exists istruzioni_lettura on public.istruzioni_commessa;
create policy istruzioni_lettura on public.istruzioni_commessa
  for select to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio', 'tecnico'));

drop policy if exists istruzioni_inserimento on public.istruzioni_commessa;
create policy istruzioni_inserimento on public.istruzioni_commessa
  for insert to authenticated
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists istruzioni_modifica on public.istruzioni_commessa;
create policy istruzioni_modifica on public.istruzioni_commessa
  for update to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio'))
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists istruzioni_cancellazione on public.istruzioni_commessa;
create policy istruzioni_cancellazione on public.istruzioni_commessa
  for delete to authenticated
  using (public.mio_ruolo() = 'admin');

-- 2) Cartella privata per i file ---------------------------------------------------------------------
-- Se Supabase non permettesse di crearla da qui, lo script prosegue lo stesso: in quel caso crearla a mano
-- da Storage → New bucket «istruzioni», privata, limite 50 MB.
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('istruzioni', 'istruzioni', false, 52428800,
          array['video/mp4','video/quicktime','video/webm','video/x-m4v',
                'application/pdf','image/jpeg','image/png','image/webp','image/heic'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "istruzioni: lettura utenti app" on storage.objects';
  execute $p$create policy "istruzioni: lettura utenti app" on storage.objects
            for select to authenticated
            using (bucket_id = 'istruzioni' and public.mio_ruolo() in ('admin', 'ufficio', 'tecnico'))$p$;

  execute 'drop policy if exists "istruzioni: caricamento admin e ufficio" on storage.objects';
  execute $p$create policy "istruzioni: caricamento admin e ufficio" on storage.objects
            for insert to authenticated
            with check (bucket_id = 'istruzioni' and public.mio_ruolo() in ('admin', 'ufficio'))$p$;

  execute 'drop policy if exists "istruzioni: modifica admin e ufficio" on storage.objects';
  execute $p$create policy "istruzioni: modifica admin e ufficio" on storage.objects
            for update to authenticated
            using (bucket_id = 'istruzioni' and public.mio_ruolo() in ('admin', 'ufficio'))$p$;

  execute 'drop policy if exists "istruzioni: cancellazione solo admin" on storage.objects';
  execute $p$create policy "istruzioni: cancellazione solo admin" on storage.objects
            for delete to authenticated
            using (bucket_id = 'istruzioni' and public.mio_ruolo() = 'admin')$p$;
exception when others then
  raise warning 'Cartella file «istruzioni» non pronta: %', sqlerrm;
end $$;

-- Esito: deve dare 1 · 4 · 1 · 4
select (select count(*) from information_schema.tables
         where table_schema = 'public' and table_name = 'istruzioni_commessa')          as tabella,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'istruzioni_commessa')              as permessi_tabella,
       (select count(*) from storage.buckets where id = 'istruzioni')                    as cartella_file,
       (select count(*) from pg_policies
         where schemaname = 'storage' and tablename = 'objects' and policyname like 'istruzioni:%') as permessi_file;
