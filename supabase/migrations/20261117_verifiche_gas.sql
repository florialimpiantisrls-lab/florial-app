-- Florial (17/11/2026) · Verifica semestrale rivelazione incendi e gas, con il video della prova gas
-- Nell'app: Home → «Verifica gas» (scheda digitale, tutti i ruoli) e Home → «Procedure» (istruzione e video tutorial).
--
-- Questo script prepara il database:
--   1) tabella verifiche_gas: una riga per ogni visita (rilievo, maggio, novembre, straordinaria).
--      Tutti i ruoli la compilano; admin e ufficio vedono tutte le verifiche, il tecnico solo le sue;
--      admin e ufficio la aggiornano (firma di Flogert come tecnico qualificato), solo admin cancella;
--   2) cartella privata «verifiche-video» per i video della prova gas (solo video, massimo 25 MB):
--      ognuno carica nella propria sottocartella; admin e ufficio guardano tutti i video, il tecnico
--      solo i suoi; solo admin cancella.
--
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova").
-- Solo aggiunte: non tocca né cancella dati esistenti. Si può rieseguire senza problemi.

-- 1) Tabella verifiche_gas -------------------------------------------------------------------------
-- cliente_id prende lo stesso tipo di clienti.id (uuid o numero).
do $$
declare
  t_cli text;
begin
  select format_type(a.atttypid, a.atttypmod) into t_cli
    from pg_attribute a
   where a.attrelid = 'public.clienti'::regclass and a.attname = 'id' and not a.attisdropped;

  execute format($f$
    create table if not exists public.verifiche_gas (
      id                uuid primary key default gen_random_uuid(),
      cliente_id        %s references public.clienti(id) on delete set null,
      cliente           text,
      locale            text not null,
      data_visita       date not null default current_date,
      tipo_visita       text,
      gas               jsonb not null default '{}'::jsonb,
      antincendio       jsonb not null default '{}'::jsonb,
      chiusura          jsonb not null default '[]'::jsonb,
      esito             text,
      note              text,
      video_path        text,
      video_nome        text,
      firma_esecutore   text,
      firma_locale      text,
      nome_locale       text,
      firma_qualificato text,
      verificata_il     timestamptz,
      verificata_da     text,
      compilato_da      text,
      compilato_da_id   uuid default auth.uid(),
      created_at        timestamptz not null default now(),
      updated_at        timestamptz not null default now()
    )$f$, t_cli);
end $$;

comment on table public.verifiche_gas is
  'Scheda di verifica semestrale rivelazione incendi e gas (istruzione operativa Rev. 0 del 16/11/2026). '
  'tipo_visita: rilievo, maggio, novembre, straordinaria. esito: conforme, non_conforme. '
  'gas: allarme, secondi, gas_prova, valvola, comandi, combinatore, video_whatsapp. '
  'antincendio: controlli e quantita (solo tecnico qualificato). '
  'video_path: percorso del video della prova nella cartella privata «verifiche-video».';

create index if not exists verifiche_gas_data_idx on public.verifiche_gas (data_visita desc, created_at desc);

alter table public.verifiche_gas enable row level security;

drop policy if exists verifiche_gas_lettura on public.verifiche_gas;
create policy verifiche_gas_lettura on public.verifiche_gas
  for select to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio') or compilato_da_id = auth.uid());

drop policy if exists verifiche_gas_inserimento on public.verifiche_gas;
create policy verifiche_gas_inserimento on public.verifiche_gas
  for insert to authenticated
  with check (public.mio_ruolo() is not null and compilato_da_id = auth.uid());

drop policy if exists verifiche_gas_modifica on public.verifiche_gas;
create policy verifiche_gas_modifica on public.verifiche_gas
  for update to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio'))
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists verifiche_gas_cancellazione on public.verifiche_gas;
create policy verifiche_gas_cancellazione on public.verifiche_gas
  for delete to authenticated
  using (public.mio_ruolo() = 'admin');

-- 2) Cartella privata «verifiche-video» ------------------------------------------------------------
-- Ogni video va in <id utente>/<data>_<codice>.<estensione>: il tecnico vede solo la sua sottocartella.
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('verifiche-video', 'verifiche-video', false, 26214400, array['video/*'])
  on conflict (id) do update
    set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "verifiche-video: caricamento" on storage.objects';
  execute $p$create policy "verifiche-video: caricamento" on storage.objects
            for insert to authenticated
            with check (bucket_id = 'verifiche-video' and public.mio_ruolo() is not null
                        and (storage.foldername(name))[1] = auth.uid()::text)$p$;

  execute 'drop policy if exists "verifiche-video: lettura" on storage.objects';
  execute $p$create policy "verifiche-video: lettura" on storage.objects
            for select to authenticated
            using (bucket_id = 'verifiche-video'
                   and (public.mio_ruolo() in ('admin', 'ufficio')
                        or (storage.foldername(name))[1] = auth.uid()::text))$p$;

  execute 'drop policy if exists "verifiche-video: cancellazione solo admin" on storage.objects';
  execute $p$create policy "verifiche-video: cancellazione solo admin" on storage.objects
            for delete to authenticated
            using (bucket_id = 'verifiche-video' and public.mio_ruolo() = 'admin')$p$;
exception when others then
  raise warning 'Cartella video «verifiche-video» non pronta: %', sqlerrm;
end $$;

-- Esito: tutto a 1 (e permessi 4 e 3) = pronto
select 'Verifiche gas: script eseguito' as esito,
       (select count(*) from information_schema.tables
         where table_schema = 'public' and table_name = 'verifiche_gas')                     as tabella_verifiche,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'verifiche_gas')                        as permessi_tabella_su_4,
       (select count(*) from storage.buckets where id = 'verifiche-video')                   as cartella_video,
       (select count(*) from pg_policies
         where schemaname = 'storage' and tablename = 'objects'
           and policyname like 'verifiche-video:%')                                          as permessi_video_su_3;
