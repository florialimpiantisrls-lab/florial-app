// invia-rapporto — invia al cliente la scheda d'intervento via Resend.
// Allega le foto e la firma del cliente, niente prezzi, copia al titolare (BCC).
//
// Segreti richiesti (Edge Functions -> Secrets):
//   RESEND_API_KEY   la chiave del tuo account Resend
//   MITTENTE         es. "Florial Impianti <assistenza@florial.it>"  (per la prova: "Florial Impianti <onboarding@resend.dev>")
//   BCC_TITOLARE     (facoltativo) email a cui mandare sempre una copia (Flogert)
//
// Chiamata dall'app:  sb.functions.invoke('invia-rapporto', { body: { rapporto_id, email } })
// Pubblicare con "Verify JWT" ATTIVO: la chiama l'app con la sessione dell'utente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const RESEND = Deno.env.get("RESEND_API_KEY");
const MITTENTE = Deno.env.get("MITTENTE") || "Florial Impianti <onboarding@resend.dev>";
const BCC = (Deno.env.get("BCC_TITOLARE") || "").trim();

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
const br = (s: unknown) => esc(s).replace(/\n/g, "<br>");

type Att = { filename: string; content: string };
function allega(dataUrl: string, nome: string): Att | null {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || "");
  if (!m) return null;
  const ext = m[1].includes("png") ? "png" : m[1].includes("jpeg") || m[1].includes("jpg") ? "jpg" : "bin";
  return { filename: `${nome}.${ext}`, content: m[2] };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Solo POST", { status: 405 });
  try {
    if (!RESEND) return Response.json({ ok: false, errore: "Manca il segreto RESEND_API_KEY" }, { status: 500 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.rapporto_id || "");
    let email = String(body.email || "").trim();
    if (!id) return Response.json({ ok: false, errore: "Serve rapporto_id" }, { status: 400 });

    const { data: r, error } = await sb.from("rapporti").select("*").eq("id", id).single();
    if (error || !r) return Response.json({ ok: false, errore: "Rapporto non trovato" }, { status: 404 });

    // email del cliente: dal body, altrimenti dall'anagrafica per ragione sociale
    if (!email && r.ragione_sociale) {
      const { data: c } = await sb.from("clienti").select("email").ilike("ragione_sociale", r.ragione_sociale).limit(1);
      if (c && c[0]) email = (c[0].email || "").trim();
    }
    if (!email || !email.includes("@")) {
      return Response.json({ ok: false, errore: "Manca un'email valida del cliente" }, { status: 400 });
    }

    // allegati: foto + firma del cliente
    const foto = Array.isArray(r.foto) ? (r.foto as string[]) : [];
    const attachments: Att[] = [];
    foto.forEach((f, i) => { const a = allega(f, `foto-${i + 1}`); if (a) attachments.push(a); });
    if (r.firma_cliente) { const a = allega(r.firma_cliente as string, "firma-cliente"); if (a) attachments.push(a); }

    const dataIt = r.data ? new Date(r.data as string).toLocaleDateString("it-IT") : "";
    const titolo = `Scheda d'intervento${r.numero ? " N° " + r.numero : ""}`;

    const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#0b2326;line-height:1.5;max-width:620px;">
  <h2 style="color:#00726d;margin:0 0 2px;">Florial Impianti</h2>
  <p style="margin:0 0 14px;color:#4a6669;font-size:13px;">${esc(titolo)}${dataIt ? " · " + dataIt : ""}</p>
  <p><b>Gentile ${esc(r.ragione_sociale || "Cliente")},</b><br>Le inviamo il riepilogo dell'intervento svolto.</p>
  ${r.indirizzo ? `<p style="margin:10px 0;"><b>Luogo:</b> ${esc(r.indirizzo)}${r.citta ? ", " + esc(r.citta) : ""}</p>` : ""}
  ${r.lavori ? `<p style="margin:10px 0;"><b>Lavori svolti:</b><br>${br(r.lavori)}</p>` : ""}
  ${r.descrizione ? `<p style="margin:10px 0;"><b>Dettaglio:</b><br>${br(r.descrizione)}</p>` : ""}
  ${r.esito ? `<p style="margin:10px 0;"><b>Esito:</b> ${esc(r.esito)}</p>` : ""}
  ${r.note ? `<p style="margin:10px 0;"><b>Raccomandazioni / note:</b><br>${br(r.note)}</p>` : ""}
  <p style="margin:14px 0;">In allegato trova le foto dell'intervento${r.firma_cliente ? " e la scheda con la firma" : ""}.</p>
  <hr style="border:none;border-top:1px solid #a8ccc8;margin:20px 0;">
  <p style="color:#4a6669;font-size:12px;line-height:1.6;">
    Florial Impianti S.r.l.s. · Via Benedetto Marcello 25/R, 50144 Firenze<br>
    Tel. 055 7601226 · info@florial.it · www.florial.it
  </p>
</div>`;

    const payload: Record<string, unknown> = {
      from: MITTENTE,
      to: [email],
      subject: `Florial Impianti — ${titolo}`,
      html,
      attachments,
    };
    if (BCC) payload.bcc = [BCC];

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return Response.json({ ok: false, errore: `Resend ${resp.status}: ${JSON.stringify(out).slice(0, 300)}` }, { status: 502 });
    }
    return Response.json({ ok: true, id: (out as Record<string, unknown>).id, inviata_a: email });
  } catch (err) {
    return Response.json({ ok: false, errore: (err as Error).message }, { status: 500 });
  }
});
