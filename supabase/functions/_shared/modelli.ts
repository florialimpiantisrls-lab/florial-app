// Il «cervello» sotto TIA: un modello via API (Claude) e, se configurato,
// un modello locale su un server compatibile OpenAI (per esempio Ollama su un NAS).

export interface Blocco {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface Messaggio {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface DefStrumento {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RispostaModello {
  blocchi: Blocco[];
  motivoStop: string;
  tokenIn: number;
  tokenOut: number;
}

export interface RichiestaModello {
  url: string;
  chiave: string;
  modello: string;
  sistemaFisso: string; // uguale per tutte le domande dello stesso ruolo: va in cache dal fornitore
  sistemaVariabile: string; // data, nome di chi scrive
  messaggi: Messaggio[];
  strumenti: DefStrumento[];
  maxToken: number;
}

const ATTESA_MS = 45_000;

export async function chiamaClaude(r: RichiestaModello): Promise<RispostaModello> {
  const corpo: Record<string, unknown> = {
    model: r.modello,
    max_tokens: r.maxToken,
    system: [
      { type: "text", text: r.sistemaFisso, cache_control: { type: "ephemeral" } },
      { type: "text", text: r.sistemaVariabile },
    ],
    messages: r.messaggi,
  };
  if (r.strumenti.length > 0) corpo.tools = r.strumenti;

  let ultimo = "";
  for (let tentativo = 0; tentativo < 2; tentativo++) {
    const risposta = await fetch(`${r.url}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": r.chiave,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(ATTESA_MS),
    });

    if (risposta.ok) {
      const j = await risposta.json() as {
        content?: Blocco[];
        stop_reason?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      const u = j.usage ?? {};
      return {
        blocchi: j.content ?? [],
        motivoStop: j.stop_reason ?? "",
        tokenIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0),
        tokenOut: u.output_tokens ?? 0,
      };
    }

    ultimo = `${risposta.status} ${(await risposta.text()).slice(0, 300)}`;
    // sovraccarico o errore momentaneo: un solo secondo tentativo
    if (![429, 500, 502, 503, 529].includes(risposta.status)) break;
    await new Promise((ok) => setTimeout(ok, 1200));
  }
  throw new Error(`modello: ${ultimo}`);
}

export function testoDi(blocchi: Blocco[]): string {
  return blocchi.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
}

// Modello locale: solo domanda + documenti già trovati, senza strumenti.
export async function chiamaLocale(
  url: string,
  modello: string,
  sistema: string,
  domanda: string,
): Promise<{ testo: string; tokenIn: number; tokenOut: number }> {
  const risposta = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modello,
      temperature: 0.2,
      messages: [{ role: "system", content: sistema }, { role: "user", content: domanda }],
    }),
    signal: AbortSignal.timeout(ATTESA_MS),
  });
  if (!risposta.ok) throw new Error(`modello locale: ${risposta.status}`);
  const j = await risposta.json() as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const testo = j.choices?.[0]?.message?.content?.trim() ?? "";
  if (!testo) throw new Error("modello locale: risposta vuota");
  return { testo, tokenIn: j.usage?.prompt_tokens ?? 0, tokenOut: j.usage?.completion_tokens ?? 0 };
}
