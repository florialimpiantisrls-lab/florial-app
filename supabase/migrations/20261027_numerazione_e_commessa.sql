-- Florial (27/10/2026) · due correzioni, da eseguire una volta nel SQL Editor di Supabase
-- (progetto "florial prova"). Solo aggiunte/sostituzioni di funzioni: non cancella dati.
--
-- 1) next_numero: la numerazione dei rapporti restava sempre a 1 (l'upsert non incrementava).
--    Qui la versione corretta + funzione di anteprima + inizializzazione della sequenza dal
--    massimo numero già presente, così i nuovi rapporti ripartono da max+1 senza collisioni.
-- 2) commessa_dettaglio: funzione per la scheda commessa (lavorazioni del preventivo + interventi).
--    Non era mai stata creata: per questo la scheda non mostrava la descrizione né gli interventi.

-- ============ 1) NUMERAZIONE RAPPORTI ============
-- tabella sequenze: colonne (seq_id text pk, valore bigint)

create or replace function public.next_numero(seq_id text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v bigint;
begin
  insert into sequenze (seq_id, valore) values (seq_id, 1)
  on conflict (seq_id) do update set valore = sequenze.valore + 1
  returning valore into v;
  return v;
end;
$$;

-- anteprima (non incrementa): per mostrare il prossimo numero quando si apre il form
create or replace function public.prossimo_numero(seq_id text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select coalesce((select valore from sequenze where sequenze.seq_id = $1), 0) + 1;
$$;

grant execute on function public.next_numero(text)    to authenticated, anon;
grant execute on function public.prossimo_numero(text) to authenticated, anon;

-- inizializza la sequenza 'rapporti_AAAA' al massimo numero già usato per quell'anno,
-- così next_numero riparte da max+1 (niente collisioni con i rapporti esistenti).
insert into sequenze (seq_id, valore)
select 'rapporti_' || anno, maxnum
from (
  select substring(numero from '/([0-9]{4})$') as anno,
         max( (substring(numero from '^([0-9]+)/'))::int ) as maxnum
  from rapporti
  where numero ~ '^[0-9]+/[0-9]{4}$'
  group by substring(numero from '/([0-9]{4})$')
) t
where anno is not null
on conflict (seq_id) do update set valore = greatest(sequenze.valore, excluded.valore);

-- ============ 2) SCHEDA COMMESSA ============
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

select 'Numerazione corretta e scheda commessa: pronte' as esito;
