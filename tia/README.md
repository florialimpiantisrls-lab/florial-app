# Florial TIA — motore a strati

Nuovo motore della chat «Florial TIA» già presente nell'app. La schermata resta
quella di prima; cambia la funzione che risponde: `tia` al posto di `florial-tia`.

## Cosa cambia rispetto alla TIA di prima

| | Prima (`florial-tia`) | Ora (`tia`) |
|---|---|---|
| Dati dell'app | tutto l'archivio dentro ogni domanda | solo ciò che serve, letto con gli strumenti |
| Modello | sempre quello grande | piccolo di norma, grande solo per le analisi; calendario del giorno senza modello |
| Documenti aziendali | no | sì, con le fonti sotto la risposta |
| Tracce di ogni risposta | no | sì (`tia_tracce`) |
| Tetto di spesa giornaliero | no | sì |
| Chi può usarla | titolare | titolare; ufficio e tecnici quando si aggiungono a `TIA_RUOLI` |
| Scrittura | no | no |

I dati dell'app si leggono sempre con l'accesso di chi chiede, come faceva la
TIA di prima: valgono le regole che l'app applica già a quel ruolo.

## Messa online (in quest'ordine)

1. **Base dati.** Eseguire `supabase/migrations/20261119_tia.sql` nell'SQL Editor.
   Crea solo tabelle nuove con prefisso `tia_`; si può rieseguire.
2. **Funzioni.** `supabase functions deploy tia` e `supabase functions deploy tia-ingest`
   (con «Verify JWT» attivo, come le altre). La chiave `ANTHROPIC_API_KEY` c'è già.
3. **Prova prima di toccare l'app.** `npm run prova` da questa cartella (vedi sotto):
   la vecchia TIA intanto continua a funzionare, perché l'app online chiama ancora quella.
4. **App.** Unire questo ramo: `index.html` chiama `tia` e mostra le fonti.
5. **Documenti.** Mettere le procedure in `documenti/tutti|ufficio|admin/` (formato in
   `documenti/_esempio.md`) e lanciare `npm run carica -- documenti --prova`, poi senza `--prova`.

**Tornare indietro:** in `index.html` rimettere `'florial-tia'` al posto di `'tia'`
nella funzione `tiaInvia`. La vecchia funzione non viene toccata né cancellata.

## Da verificare

- `verifica-permessi.sql`: tre query di sola lettura da eseguire in Supabase. Servono a
  confermare le regole di accesso delle tabelle di base, che non sono in questo repository,
  **prima** di aggiungere `tecnico` o `ufficio` a `TIA_RUOLI`.
- La funzione `calendario` restituisce la squadra come elenco di nomi: TIA riconosce gli
  interventi di un tecnico confrontando nome e cognome. Se due persone avessero lo stesso
  nome e cognome va cambiato il criterio.
- Ogni domanda viene registrata in `tia_tracce` con il nome di chi la fa: quando si apre
  ai dipendenti, vanno informati.

## Prove

```
cd tia && npm install
npm test                    # moduli, nessuna chiave
npm run test:db             # base dati su Postgres di prova
npm run test:integrazione   # giro completo con Supabase e modello finti
npm run prova               # sul Supabase vero, come titolare: consuma qualche token
```

Le prime tre si rilanciano prima di ogni modifica messa online.

## Dove stanno gli strati

Tutto in `supabase/functions/_shared/`: `prompt.ts` (1), `pezzi.ts` e `rag.ts` (2),
`strumenti.ts` e `mappa.ts` (3), `permessi.ts` e `identita.ts` (4), `guardrail.ts` (5),
`router.ts` e `cache.ts` (6), `tracce.ts` (7). `mappa.ts` è l'unico file che contiene i
nomi di tabelle e funzioni dell'app.
