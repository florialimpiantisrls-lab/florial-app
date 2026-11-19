// Prova della base dati di TIA su un Postgres «tascabile» (PGlite), senza
// toccare Supabase: esegue la migrazione vera e controlla ricerca e permessi.
// Si lancia con:  npm run test:db

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

const sql = readFileSync(new URL("../../supabase/migrations/20261119_tia.sql", import.meta.url), "utf8");

async function nuovaBase() {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(sql);
  return db;
}

async function carica(db, doc) {
  const { rows } = await db.query(
    "insert into tia_documenti (codice, titolo, livello, impronta) values ($1, $2, $3, 'x') returning id",
    [doc.codice, doc.titolo, doc.livello],
  );
  let ordine = 0;
  for (const p of doc.pezzi) {
    await db.query(
      "insert into tia_pezzi (documento_id, ordine, sezione, testo, embedding, modello_embedding) values ($1, $2, $3, $4, $5, $6)",
      [rows[0].id, ordine++, p.sezione, p.testo, p.vettore ?? null, p.vettore ? "prova" : null],
    );
  }
}

const DOCUMENTI = [
  {
    codice: "FLR-OPE-03",
    titolo: "Fine intervento",
    livello: "tutti",
    pezzi: [
      { sezione: "Rapportino", testo: "A fine intervento il tecnico compila il rapportino nell'app e fa firmare il cliente.", vettore: "[1,0,0]" },
      { sezione: "Pulizia", testo: "Il locale va lasciato pulito e gli imballi vanno portati via.", vettore: "[0,1,0]" },
    ],
  },
  {
    codice: "FLR-COM-01",
    titolo: "Condizioni commerciali",
    livello: "ufficio",
    pezzi: [{ sezione: "Pagamenti", testo: "Acconto del 50% alla conferma, 30% a stato avanzamento, 20% a saldo.", vettore: "[0,0,1]" }],
  },
  {
    codice: "FLR-FIN-02",
    titolo: "Rientro fornitori",
    livello: "admin",
    pezzi: [{ sezione: "Piano", testo: "Piano di rientro con rate mensili verso i fornitori e gestione dei fidi.", vettore: "[0,1,1]" }],
  },
];

test("la migrazione si esegue, anche due volte di fila", async () => {
  const db = await nuovaBase();
  await db.exec(sql);
  const { rows } = await db.query(
    "select tablename, rowsecurity from pg_tables where tablename like 'tia_%' order by 1",
  );
  assert.deepEqual(rows.map((r) => r.tablename), ["tia_azioni", "tia_cache", "tia_documenti", "tia_pezzi", "tia_tracce"]);
  assert.ok(rows.every((r) => r.rowsecurity === true), "RLS accesa su tutte le tabelle");
});

test("la ricerca trova il pezzo giusto con parole italiane diverse da quelle del testo", async () => {
  const db = await nuovaBase();
  for (const d of DOCUMENTI) await carica(db, d);
  // «rapportini» e «firma» non compaiono così nel testo («rapportino», «firmare»)
  const { rows } = await db.query(
    "select codice, sezione from tia_cerca($1, $2)",
    ["Chi deve compilare i rapportini e prendere la firma dei clienti?", ["tutti"]],
  );
  assert.equal(rows[0].codice, "FLR-OPE-03");
  assert.equal(rows[0].sezione, "Rapportino");
});

test("il tecnico non riceve documenti di ufficio o del titolare, nemmeno chiedendoli", async () => {
  const db = await nuovaBase();
  for (const d of DOCUMENTI) await carica(db, d);
  const domanda = "acconto pagamenti saldo rientro fornitori rate fidi";
  const tecnico = await db.query("select codice from tia_cerca($1, $2)", [domanda, ["tutti"]]);
  const ufficio = await db.query("select codice from tia_cerca($1, $2)", [domanda, ["tutti", "ufficio"]]);
  const admin = await db.query("select codice from tia_cerca($1, $2)", [domanda, ["tutti", "ufficio", "admin"]]);
  assert.deepEqual(tecnico.rows, []);
  assert.deepEqual(ufficio.rows.map((r) => r.codice), ["FLR-COM-01"]);
  assert.deepEqual(admin.rows.map((r) => r.codice).sort(), ["FLR-COM-01", "FLR-FIN-02"]);
});

test("i vettori rispettano gli stessi permessi e si sommano alla ricerca per parole", async () => {
  const db = await nuovaBase();
  for (const d of DOCUMENTI) await carica(db, d);
  // vettore vicinissimo al documento del titolare, chiesto da un tecnico
  const tecnico = await db.query(
    "select codice from tia_cerca($1, $2, $3::vector, $4)",
    ["domanda senza parole utili", ["tutti"], "[0,1,1]", "prova"],
  );
  assert.ok(tecnico.rows.length > 0);
  assert.ok(tecnico.rows.every((r) => r.codice === "FLR-OPE-03"));
  // modello diverso da quello con cui sono stati creati i vettori: non si confrontano
  const altro = await db.query(
    "select codice from tia_cerca($1, $2, $3::vector, $4)",
    ["domanda senza parole utili", ["tutti", "ufficio", "admin"], "[0,1,1]", "altro-modello"],
  );
  assert.deepEqual(altro.rows, []);
});

test("domande vuote, strane o ostili non rompono la ricerca", async () => {
  const db = await nuovaBase();
  for (const d of DOCUMENTI) await carica(db, d);
  for (const domanda of ["", "   ", "il lo la di a", "'); drop table tia_pezzi; --", "l'impianto & | ! ( ) :* \\", null]) {
    const r = await db.query("select codice from tia_cerca($1, $2)", [domanda, ["tutti", "ufficio", "admin"]]);
    assert.ok(Array.isArray(r.rows), String(domanda));
  }
  const { rows } = await db.query("select count(*)::int as n from tia_pezzi");
  assert.equal(rows[0].n, 4);
});

test("cancellando un documento spariscono i suoi pezzi; il codice non si duplica", async () => {
  const db = await nuovaBase();
  for (const d of DOCUMENTI) await carica(db, d);
  await assert.rejects(() => carica(db, DOCUMENTI[0]));
  await db.query("delete from tia_documenti where codice = 'FLR-OPE-03'");
  const { rows } = await db.query("select count(*)::int as n from tia_pezzi");
  assert.equal(rows[0].n, 2);
});

test("il consumo si somma per percorso e solo dal momento richiesto", async () => {
  const db = await nuovaBase();
  await db.exec(`
    insert into tia_tracce (percorso, token_in, token_out, creato_il) values
      ('grande',  1000, 200, now()),
      ('grande',   500, 100, now()),
      ('piccolo',  300,  50, now()),
      ('diretto',    0,   0, now()),
      ('grande',  9000, 900, now() - interval '2 days');
  `);
  const { rows } = await db.query("select * from tia_consumo(now() - interval '1 hour') order by percorso");
  assert.deepEqual(
    rows.map((r) => [r.percorso, Number(r.domande), Number(r.token)]),
    [["diretto", 1, 0], ["grande", 2, 1800], ["piccolo", 1, 350]],
  );
});

test("un'azione nasce in attesa e accetta solo stati previsti", async () => {
  const db = await nuovaBase();
  const { rows } = await db.query(
    "insert into tia_azioni (richiesta_da, tipo) values ('u1', 'crea_cliente') returning stato",
  );
  assert.equal(rows[0].stato, "in_attesa");
  await assert.rejects(() => db.query("update tia_azioni set stato = 'fatta_di_nascosto'"));
  await assert.rejects(() =>
    db.query("insert into tia_documenti (titolo, livello, impronta) values ('x', 'pubblico', 'x')")
  );
});
