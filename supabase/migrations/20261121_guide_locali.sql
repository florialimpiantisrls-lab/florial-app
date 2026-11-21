-- Florial (21/11/2026) · Guide dei locali a contratto: cosa fare, cosa NON fare, cosa portare e NON portare
-- Nell'app la guida compare da sola dentro ogni lavoro del locale (Lavori → tocca il lavoro) e in
-- Home → Procedure, nel gruppo con lo stesso nome, sopra a video, checklist e schede.
--
-- Questo script crea solo la tabella, vuota, con i permessi:
--   tutti gli utenti dell'app leggono; admin e ufficio scrivono; solo l'admin cancella.
-- I contenuti dei locali (nomi dei clienti, impianti, cose da non fare) NON stanno in questo repository,
-- che è pubblico: si caricano con lo script privato che Flogert esegue a parte, dopo questo.
--
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova").
-- Solo aggiunte: non tocca né cancella dati esistenti. Si può rieseguire senza problemi.

create table if not exists public.guide_locali (
  id            uuid primary key default gen_random_uuid(),
  gruppo        text not null unique,            -- nome del gruppo in Procedure (lo stesso dei video e delle checklist)
  cerca         text[] not null default '{}',    -- parole per riconoscere i lavori del locale: insegna, via (minuscolo)
  contratto     text,                            -- es. «CTR-004/2026»
  sottotitolo   text,                            -- cliente e indirizzo
  impianti      text[] not null default '{}',
  regole        text[] not null default '{}',    -- valgono per ogni lavoro nel locale
  fare          text[] not null default '{}',    -- la visita, in ordine
  non_fare      text[] not null default '{}',
  portare       text[] not null default '{}',
  non_portare   text[] not null default '{}',    -- cosa NON portare e NON preparare
  attenzione    text[] not null default '{}',    -- controlli e rischi di questo locale
  fine          text[] not null default '{}',    -- prima di andare via
  incendi       boolean not null default false,
  gas           boolean not null default false,
  ordine        integer not null default 0,
  attiva        boolean not null default true,
  aggiornato    timestamptz not null default now(),
  aggiornato_da text
);

comment on table public.guide_locali is
  'Guida di ogni locale a contratto (Rev. 1 del 21/11/2026): regole, cosa fare in ordine, cosa NON fare, '
  'cosa portare e NON portare, attenzione, fine visita. L''app la mostra nei lavori il cui testo (insegna, '
  'indirizzo, titolo) contiene una delle parole di «cerca», e in Procedure nel gruppo «gruppo».';

alter table public.guide_locali enable row level security;

drop policy if exists guide_locali_lettura on public.guide_locali;
create policy guide_locali_lettura on public.guide_locali
  for select to authenticated
  using (public.mio_ruolo() is not null);

drop policy if exists guide_locali_inserimento on public.guide_locali;
create policy guide_locali_inserimento on public.guide_locali
  for insert to authenticated
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists guide_locali_modifica on public.guide_locali;
create policy guide_locali_modifica on public.guide_locali
  for update to authenticated
  using (public.mio_ruolo() in ('admin', 'ufficio'))
  with check (public.mio_ruolo() in ('admin', 'ufficio'));

drop policy if exists guide_locali_cancellazione on public.guide_locali;
create policy guide_locali_cancellazione on public.guide_locali
  for delete to authenticated
  using (public.mio_ruolo() = 'admin');

-- Esito: 1 e 4 = pronto (poi eseguire lo script privato con le guide dei locali)
select 'Guide dei locali: script eseguito' as esito,
       (select count(*) from information_schema.tables
         where table_schema = 'public' and table_name = 'guide_locali')                      as tabella_guide,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'guide_locali')                         as permessi_su_4;
