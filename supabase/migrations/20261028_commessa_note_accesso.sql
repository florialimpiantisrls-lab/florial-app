-- Florial (28/10/2026) · commessa_dettaglio: aggiunge "note_accesso" (preso dal locale),
-- così la scheda della commessa mostra le note d'accesso (es. "4° piano, citofono, quadro…").
-- Visibile solo ad admin/ufficio (i tecnici vedono le note solo sui propri interventi).
-- Il resto della funzione è identico alla versione 20261027b. CREATE OR REPLACE: sostituisce in sicurezza.

create or replace function public.commessa_dettaglio(p_hub text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comm commesse%rowtype;
  v_hub_lav text; v_hub_ind text;
  v_loc_ind text; v_loc_cit text; v_loc_note text;
  v_interventi jsonb; v_moduli jsonb;
begin
  if mio_ruolo() is null then
    return null;
  end if;

  select * into v_comm from commesse where hubspot_deal_id = p_hub limit 1;
  select lavorazioni, indirizzo into v_hub_lav, v_hub_ind from commesse_hub where hubspot_id = p_hub limit 1;
  if v_comm.locale_id is not null then
    select indirizzo, citta, note_accesso into v_loc_ind, v_loc_cit, v_loc_note
      from locali where id = v_comm.locale_id limit 1;
  end if;

  select coalesce(
           jsonb_agg(to_jsonb(t) order by t.data nulls last, t.ora_inizio nulls last),
           '[]'::jsonb)
    into v_interventi
  from (
    select i.id, i.titolo, i.descrizione, i.data, i.ora_inizio, i.ora_fine, i.stato, i.tipo,
           (select string_agg(btrim(u.nome || ' ' || coalesce(u.cognome, '')), ', ')
              from intervento_tecnici it join utenti u on u.id = it.tecnico_id
             where it.intervento_id = i.id) as tecnici
    from interventi i
    where (v_comm.id is not null and i.commessa_id = v_comm.id)
       or i.origine = 'hubspot:' || p_hub
  ) t;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc), '[]'::jsonb)
    into v_moduli
  from (
    select 'Sopralluogo' as tipo, 's-sop' as scr, id, created_at, coalesce(ragione_sociale,'') as label from sopralluoghi where commessa_ref = p_hub
    union all select 'Distinta materiali','s-dis', id, created_at, coalesce(cliente,'')     from distinte  where commessa_ref = p_hub
    union all select 'Prelievi magazzino','s-prl', id, created_at, coalesce(tecnico,'')     from prelievi  where commessa_ref = p_hub
    union all select 'Lavori extra',      's-var', id, created_at, coalesce(committente,'') from varianti  where commessa_ref = p_hub
    union all select 'Registro controlli','s-reg', id, created_at, coalesce(titolare,'')    from registri  where commessa_ref = p_hub
    union all select 'Rapporto di prova', 's-col16', id, created_at, coalesce(cliente,'')   from verifiche where commessa_ref = p_hub
  ) m;

  return jsonb_build_object(
    'lavorazioni',   coalesce(v_comm.descrizione, v_hub_lav),
    'stato',         v_comm.stato,
    'data_scadenza', v_comm.data_scadenza,
    'indirizzo',     coalesce(nullif(btrim(coalesce(v_loc_ind,'') || ' ' || coalesce(v_loc_cit,'')), ''), v_hub_ind),
    'note_accesso',  case when mio_ruolo() in ('admin','ufficio')
                          then nullif(btrim(coalesce(v_loc_note,'')), '')
                          else null end,
    'interventi',    v_interventi,
    'moduli',        v_moduli
  );
end;
$$;

grant execute on function public.commessa_dettaglio(text) to authenticated, anon;

select 'commessa_dettaglio: ora include note_accesso (admin/ufficio)' as esito;
