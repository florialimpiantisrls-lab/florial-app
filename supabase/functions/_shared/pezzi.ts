// STRATO 2 · Divisione dei documenti in pezzi.
// Regole: si taglia sui titoli e sui paragrafi, mai a metà frase se si può
// evitare; ogni pezzo si porta dietro il titolo della sezione da cui viene,
// così anche letto da solo si capisce di cosa parla.

export interface PezzoGrezzo {
  ordine: number;
  sezione: string | null;
  testo: string;
}

const MASSIMO = 1200; // caratteri per pezzo: circa mezza pagina
const MINIMO = 200; // sotto questa soglia un pezzo si unisce al successivo

function spezzaLungo(paragrafo: string): string[] {
  if (paragrafo.length <= MASSIMO) return [paragrafo];
  const frasi = paragrafo.split(/(?<=[.!?;:])\s+/);
  const parti: string[] = [];
  let corrente = "";
  for (const f of frasi) {
    if (corrente && corrente.length + f.length + 1 > MASSIMO) {
      parti.push(corrente);
      corrente = "";
    }
    if (f.length > MASSIMO) {
      // frase lunghissima (tabelle, elenchi senza punteggiatura): taglio secco
      for (let i = 0; i < f.length; i += MASSIMO) parti.push(f.slice(i, i + MASSIMO));
      continue;
    }
    corrente = corrente ? corrente + " " + f : f;
  }
  if (corrente) parti.push(corrente);
  return parti;
}

function titoloDi(riga: string): string | null {
  const md = riga.match(/^#{1,6}\s+(.+?)\s*#*$/);
  if (md) return md[1].trim();
  // titoli numerati tipo «3. Fine intervento» o «3.2 Materiale» su riga breve
  if (/^\d+(?:\.\d+)*[.)]?\s+\S/.test(riga) && riga.length <= 80 && !/[.;:,]$/.test(riga)) {
    return riga.trim();
  }
  return null;
}

export function dividiInPezzi(testo: string): PezzoGrezzo[] {
  const pulito = testo.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const blocchi = pulito.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const pezzi: PezzoGrezzo[] = [];
  let sezione: string | null = null;
  let corrente = "";

  const chiudi = () => {
    const t = corrente.trim();
    if (t) pezzi.push({ ordine: pezzi.length, sezione, testo: t });
    corrente = "";
  };

  for (const blocco of blocchi) {
    const righe = blocco.split("\n");
    const titolo = titoloDi(righe[0].trim());
    let corpo = blocco;

    if (titolo) {
      // un titolo apre una sezione nuova: chiudo il pezzo in corso
      // (se è cortissimo resta comunque suo: appartiene alla sezione di prima)
      chiudi();
      sezione = titolo;
      corpo = righe.slice(1).join("\n").trim();
      if (!corpo) continue;
    }

    for (const parte of spezzaLungo(corpo)) {
      if (corrente && corrente.length + parte.length + 2 > MASSIMO && corrente.length >= MINIMO) {
        chiudi();
      }
      corrente = corrente ? corrente + "\n\n" + parte : parte;
      if (corrente.length >= MASSIMO) chiudi();
    }
  }
  chiudi();
  return pezzi;
}
