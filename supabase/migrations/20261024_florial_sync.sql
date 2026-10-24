-- Florial Sync (24/10/2026): colonne per il collegamento HubSpot / Fatture in Cloud -> app.
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova").
-- Solo aggiunte: non tocca né cancella dati esistenti.

alter table public.fatture    add column if not exists tipo text not null default 'fattura';
alter table public.fatture    add column if not exists hubspot_deal_id text;
alter table public.interventi add column if not exists origine text;

create unique index if not exists interventi_origine_key
  on public.interventi(origine) where origine is not null;
create unique index if not exists commesse_hubspot_deal_id_key
  on public.commesse(hubspot_deal_id) where hubspot_deal_id is not null;

select 'Florial Sync: colonne pronte' as esito;
