-- Florial TIA · verifica dei permessi dell'app (SOLA LETTURA: non modifica niente).
-- Da incollare nell'SQL Editor di Supabase. Copiare i tre risultati e passarli a Claude.
-- Serve a confermare che un tecnico, anche tramite TIA, non possa leggere
-- fatture, importi e documenti riservati, e a preparare l'accesso dei clienti.

-- 1) Tabelle: RLS accesa o spenta
select c.relname as tabella, c.relrowsecurity as rls_accesa
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;

-- 2) Regole di accesso (policy) di ogni tabella
select tablename as tabella, policyname as regola, cmd as operazione, roles as ruoli,
       qual as condizione_lettura, with_check as condizione_scrittura
from pg_policies
where schemaname = 'public'
order by 1, 2;

-- 3) Funzioni usate dall'app e da TIA
select p.proname as funzione, pg_get_functiondef(p.oid) as definizione
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mio_ruolo', 'calendario', 'cerca_locale', 'accesso_tecnico_consentito');
