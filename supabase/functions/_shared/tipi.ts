// Tipi condivisi da tutti i moduli di Florial TIA.

export type Ruolo = "admin" | "ufficio" | "tecnico";
export type Livello = "tutti" | "ufficio" | "admin";
export type Percorso =
  | "diretto"
  | "cache"
  | "locale"
  | "piccolo"
  | "grande"
  | "bloccato"
  | "errore";

export interface Utente {
  id: string; // id di accesso (Supabase Auth)
  rigaId: string; // id della riga in «utenti»: è quello usato nelle assegnazioni degli interventi
  nome: string; // nome e cognome, come compaiono nella squadra di un intervento
  ruolo: Ruolo;
}

export interface Pezzo {
  pezzo_id: number;
  documento_id: string;
  codice: string | null;
  titolo: string;
  sezione: string | null;
  testo: string;
  punteggio: number;
}

export interface Fonte {
  codice: string | null;
  titolo: string;
  sezione: string | null;
}

export interface TurnoStoria {
  ruolo: "utente" | "tia";
  testo: string;
}
