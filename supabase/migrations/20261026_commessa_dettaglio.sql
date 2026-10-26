-- Florial (26/10/2026) · funzione commessa_dettaglio
-- Per la scheda commessa dell'app: dato l'ID trattativa HubSpot (commesse_hub.hubspot_id),
-- restituisce le lavorazioni/stato/scadenza della commessa operativa e la lista degli
-- interventi collegati (fatti e in programma). NIENTE prezzi: sicura per ogni ruolo.
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova"). Solo aggiunte.

create or replace function public.commessa_dettaglio(p_hub text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comm commesse%rowtype;
  v_interventi jsonb;
begin
  -- solo utenti autenticati con un ruolo (tecnico/ufficio/admin)
  if mio_ruolo() is null then
    return null;
  end if;

  select * into v_comm from commesse where hubspot_deal_id = p_hub limit 1;

  select coalesce(
           jsonb_agg(to_jsonb(t) order by t.data nulls last, t.ora_inizio nulls last),
           '[]'::jsonb)
    into v_interventi
  from (
    select i.id, i.titolo, i.descrizione, i.data, i.ora_inizio, i.ora_fine, i.stato, i.tipo,
           (select string_agg(btrim(u.nome || ' ' || coalesce(u.cognome, '')), ', ')
              from intervento_tecnici it
              join utenti u on u.id = it.tecnico_id
             where it.intervento_id = i.id) as tecnici
    from interventi i
    where (v_comm.id is not null and i.commessa_id = v_comm.id)
       or i.origine = 'hubspot:' || p_hub
  ) t;

  return jsonb_build_object(
    'lavorazioni',    v_comm.descrizione,
    'stato',          v_comm.stato,
    'data_scadenza',  v_comm.data_scadenza,
    'interventi',     v_interventi
  );
end;
$$;

grant execute on function public.commessa_dettaglio(text) to authenticated, anon;

select 'commessa_dettaglio: funzione pronta' as esito;
