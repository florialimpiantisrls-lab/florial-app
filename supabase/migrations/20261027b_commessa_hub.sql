-- Florial (27/10/2026) · La commessa diventa l'hub.
-- Da eseguire una volta nel SQL Editor di Supabase (progetto "florial prova").
-- Solo aggiunte: non cancella dati.
--  1) Collega i moduli operativi a una commessa (colonna commessa_ref = hubspot_id).
--  2) Porta lavorazioni + indirizzo del preventivo su commesse_hub (anche per i preventivi
--     non ancora accettati), con backfill dei dati presenti in HubSpot.
--  3) commessa_dettaglio: ritorna lavorazioni, indirizzo, interventi e la lista dei moduli
--     collegati alla commessa.

-- 1) collegamento moduli -> commessa
alter table sopralluoghi add column if not exists commessa_ref text;
alter table distinte     add column if not exists commessa_ref text;
alter table prelievi     add column if not exists commessa_ref text;
alter table varianti     add column if not exists commessa_ref text;
alter table registri     add column if not exists commessa_ref text;
alter table verifiche    add column if not exists commessa_ref text;

-- 2) preventivo (lavorazioni) + indirizzo su commesse_hub, per tutte le commesse
alter table commesse_hub add column if not exists lavorazioni text;
alter table commesse_hub add column if not exists indirizzo  text;

-- backfill dei dati oggi presenti in HubSpot (gli altri preventivi non hanno le lavorazioni scritte)
update commesse_hub set indirizzo = $i$Via della Condotta 46/R e Piazza del Duomo 28/R – Firenze$i$,
 lavorazioni = $lav$CAFFÈ CONDOTTA – BAR (Via della Condotta 46/R)
A.1) Sostituire il faretto da incasso Ø150 con LED CCT 3000/4000 K
A.2) Ingresso magazzino: linea + interruttore Gewiss System, fori in facciata, collegare 2 faretti esterni del cliente
A.3) Seconda facciata: linea + interruttore Gewiss System, fori in facciata, collegare 2 faretti esterni del cliente
A.4) Presa 2P+T Gewiss System nel punto indicato dal cliente
CAFFÈ CONDOTTA – APPARTAMENTO
B.1) Nuovo quadro 24 mod.: generale C32, 6 MTD 30 mA tipo A, 3 relè passo-passo
B.2) Linee dedicate: prese cucina, lavatrice, scaldabagno (tubazioni esistenti)
B.3) Ingresso e scala: supporto Plana, verifica luci, barra LED 90 cm 3000 K, chiudere le scatole
B.4) Presa telefonica nel punto del router, prova Wi-Fi in tutte le stanze
B.5) Citofono: RJ11 + presa, accensioni, applique del cliente al posto del mobile
B.6) Bagno: scaldabagno con bipolare, aspiratore con timer, punto specchio, luci del cliente, presa eliminata (tappo), scatole chiuse
B.7) Disimpegno: 2 Unel servizio + 2 Unel lavatrice (linea dedicata)
B.8) Cucina: verifica induzione, telaio 6 mod. con 3 Unel
B.9) Camera: 3 pulsanti all'ingresso, punto TV (presa + USB-C), sotto TV 2 Unel + USB A+C, testata 2 pulsanti + presa
B.10) Prove strumentali, schema quadro, DiCo
LE BOTTEGHE DI DONATELLO (Piazza del Duomo 28/R) – preferibilmente prima dell'apertura
C.1) 2 linee dal quadro magazzini con MTD 16 A tipo A: bagno donne / bagno uomini
C.2) Minicanale 32×20 verniciato tinta corten, cavi FG17 1×2,5
C.3) Sezionatore bipolare 16 A accanto a ogni asciugamano (4)
C.4) Fissare e collegare i 4 Dyson del cliente, prova
C.5) Sonos: 2 prese per casse a parete, staffe e 10 casse, configurazione app/Wi-Fi/stanze
C.6) Prove strumentali, targhette quadro, DiCo$lav$
 where hubspot_id = '531433679096';

update commesse_hub set indirizzo = $i$Via del Proconsolo 69/R – Firenze$i$,
 lavorazioni = $lav$1) Smontaggio sistema a cavi tesi e luci esistenti (3 sale)
2) Binario SLV monofase centrale (10×2 m, 3 testate, 7 raccordi, tappi) + 28 proiettori HELIA 50 3000K
3) 11 reglette LED 90 cm 3000K su cornice grigia
4) 3 relè Smart Life (1 per sala) + configurazione app/orari
5) 4 lampade emergenza a bandiera + cartellonistica vie di fuga e quadro
6) Eliminare cavi volanti/ciabatte, chiudere scatole, minicanale
7) Quadro trifase: pulizia, linee dismesse, siglatura, 2 linee 2,5 mm² con magn-diff (cucina, sottocassa)
8) Cantina: interruttore + 2 plafoniere
9) Verifiche differenziali, collaudo, foto per DiCo$lav$
 where hubspot_id = '530910473462';

update commesse_hub set indirizzo = $i$Viale Corsica 83, int. 1 – Firenze$i$,
 lavorazioni = $lav$1) Verifiche: isolamento linee (PRIMA del salvavita), continuità PE, terra, prova differenziale – valori per DiCo
2) Salvavita 30 mA tipo A 2P 40A subito dopo il generale; impianto esistente invariato
3) Magnetotermico 1P+N C16 per nuova linea, sotto il salvavita
4) Cordicella FS17 2,5 mm² (blu, marrone, giallo-verde) nelle tubazioni esistenti
5) 6 prese UNEL 16A sui punti presa esistenti, riusando scatole e placche
6) Collaudo, spiegare riarmo e tasto test, foto e rapportino$lav$
 where hubspot_id = '530614499550';

-- 3) commessa_dettaglio potenziata
create or replace function public.commessa_dettaglio(p_hub text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comm commesse%rowtype;
  v_hub_lav text; v_hub_ind text;
  v_loc_ind text; v_loc_cit text;
  v_interventi jsonb; v_moduli jsonb;
begin
  if mio_ruolo() is null then
    return null;
  end if;

  select * into v_comm from commesse where hubspot_deal_id = p_hub limit 1;
  select lavorazioni, indirizzo into v_hub_lav, v_hub_ind from commesse_hub where hubspot_id = p_hub limit 1;
  if v_comm.locale_id is not null then
    select indirizzo, citta into v_loc_ind, v_loc_cit from locali where id = v_comm.locale_id limit 1;
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
    'interventi',    v_interventi,
    'moduli',        v_moduli
  );
end;
$$;

grant execute on function public.commessa_dettaglio(text) to authenticated, anon;

select 'Commessa hub: moduli collegabili, lavorazioni/indirizzo e lista moduli pronti' as esito;
