// ============================================================================
// MAPPA DEI DATI DELL'APP
// ============================================================================
// I nomi veri di tabelle e funzioni di Florial App, letti dal codice dell'app
// (index.html e supabase/functions/florial-tia) il 19/11/2026.
// Se un nome cambia nell'app, si cambia qui e in nessun altro posto.
// Con collegata: false lo strumento risponde «non ancora collegato».
//
// Tutti questi dati si leggono SEMPRE con l'accesso di chi chiede: valgono le
// regole (RLS e funzioni) che l'app applica già a quel ruolo.
// ============================================================================

import type { Ruolo } from "./tipi.ts";

export const MAPPA = {
  // Chi è chi.
  profili: {
    collegata: true,
    tabella: "utenti",
    col: { accesso: "auth_user_id", riga: "id", nome: "nome", cognome: "cognome", ruolo: "ruolo", attivo: "attivo" },
  },

  // Calendario lavori: funzione calendario(da, a), la stessa usata dalla schermata «Lavori».
  // Campi attesi: intervento_id, data, ora_inizio, ora_fine, stato, insegna, indirizzo, citta,
  // lavorazione, commessa_titolo, materiale, tecnici, telefono, note_accesso.
  calendario: { collegata: true, funzione: "calendario" },

  // Clienti e locali: funzione cerca_locale(termine), la stessa della schermata «Clienti».
  clienti: { collegata: true, funzione: "cerca_locale" },

  // Commesse arrivate da HubSpot.
  commesse: { collegata: true, tabella: "commesse_hub", colCliente: "cliente" },

  // Fatture e proforma arrivate da Fatture in Cloud.
  fatture: {
    collegata: true,
    tabella: "fatture",
    colCliente: "cliente",
    colData: "data",
    colDaIncassare: "da_incassare",
    nascondi: ["url", "permanent_token", "created_at", "updated_at", "pagamenti_agg"],
  },

  contratti: {
    collegata: true,
    tabella: "contratti_manutenzione",
    campi: "codice,canone,canone_periodo,stato,prossima_visita,reverse_charge,clienti(ragione_sociale),locali(insegna,citta)",
    colArchiviata: "archiviata",
  },

  rapporti: {
    collegata: true,
    tabella: "rapporti",
    campi: "numero,data,ragione_sociale,esito,origine",
    colCliente: "ragione_sociale",
    colOrdine: "created_at",
  },
};

// Come l'app chiama i ruoli → come li chiama TIA.
// Un ruolo che non è in questa lista viene rifiutato (meglio fuori che dentro per sbaglio).
export const MAPPA_RUOLI: Record<string, Ruolo> = {
  admin: "admin",
  ufficio: "ufficio",
  tecnico: "tecnico",
};
