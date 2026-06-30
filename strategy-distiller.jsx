import { useState, useEffect, useRef } from "react";
import { ScrollText, Link2, Wand2, Save, X, Pencil, Trash2, ChevronRight, AlertCircle, Loader2 } from "lucide-react";

const ACCENT = "#D98E3B";
const TEAL = "#4A8C82";
const INK = "#0E1320";
const INK_LIGHT = "#161D2E";
const PAPER = "#F7F4EC";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function ticketNumber(n) {
  return "No. " + String(n).padStart(4, "0");
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("API request failed: " + res.status);
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  return text;
}

function stripJsonFence(text) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
}

const EXTRACTION_PROMPT = (transcript) => `You are distilling a day-trading strategy from a raw YouTube transcript. Read the transcript below and extract the trader's strategy into clean, structured form.

Respond ONLY with a JSON object, no preamble, no markdown fences, matching exactly this shape:

{
  "name": "short strategy name (max 6 words), inferred from content",
  "summary": "2-3 sentence plain-English summary of the core idea",
  "market": "what instrument/market this applies to, e.g. 'futures', 'forex', 'options', 'stocks' - infer if not explicit, else 'unspecified'",
  "timeframe": "the timeframe(s) mentioned, e.g. '5-minute chart', else 'unspecified'",
  "indicators": ["list of indicators/tools used, e.g. RSI, VWAP, volume profile - empty array if none mentioned"],
  "entry_rules": ["ordered list of specific, actionable entry conditions/steps"],
  "exit_rules": ["ordered list of specific exit/stop/target rules"],
  "risk_notes": ["any risk management notes mentioned - empty array if none"],
  "caveats": ["any conditions, exceptions, or warnings the trader mentions - empty array if none"]
}

Be faithful to what's actually in the transcript - do not invent rules that aren't there. If a section has no real content, use an empty array or 'unspecified'. Keep each list item concise and concrete.

TRANSCRIPT:
"""
${transcript}
"""`;

function ExtractedView({ data }) {
  return (
    <div className="extracted">
      <p className="extracted-summary">{data.summary}</p>
      <div className="meta-row">
        <span className="meta-pill" style={{ borderColor: TEAL, color: TEAL }}>{data.market}</span>
        <span className="meta-pill" style={{ borderColor: TEAL, color: TEAL }}>{data.timeframe}</span>
      </div>
      {data.indicators?.length > 0 && (
        <div className="meta-row wrap">
          {data.indicators.map((ind, i) => (
            <span key={i} className="indicator-tag">{ind}</span>
          ))}
        </div>
      )}
      <Section title="Entry" items={data.entry_rules} numbered />
      <Section title="Exit" items={data.exit_rules} numbered />
      {data.risk_notes?.length > 0 && <Section title="Risk notes" items={data.risk_notes} />}
      {data.caveats?.length > 0 && <Section title="Caveats" items={data.caveats} />}
    </div>
  );
}

function Section({ title, items, numbered }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="rule-section">
      <div className="rule-section-title">{title}</div>
      <ol className={numbered ? "rule-list numbered" : "rule-list bulleted"}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ol>
    </div>
  );
}

export default function StrategyDistiller() {
  const [strategies, setStrategies] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState("link"); // "link" | "transcript"
  const [linkValue, setLinkValue] = useState("");
  const [transcriptValue, setTranscriptValue] = useState("");
  const [status, setStatus] = useState("idle"); // idle | fetching | distilling | error
  const [errorMsg, setErrorMsg] = useState("");
  const [pendingResult, setPendingResult] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [counter, setCounter] = useState(1);
  const inputRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("strategies-list");
        const list = res ? JSON.parse(res.value) : [];
        setStrategies(list);
        setCounter(list.length ? Math.max(...list.map((s) => s.num || 0)) + 1 : 1);
      } catch (e) {
        setStrategies([]);
      }
      setLoaded(true);
    })();
  }, []);

  async function persist(list) {
    try {
      await window.storage.set("strategies-list", JSON.stringify(list));
    } catch (e) {
      // best effort
    }
  }

  function extractYouTubeId(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
    return m ? m[1] : null;
  }

  async function tryFetchTranscript(url) {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error("That doesn't look like a YouTube link. Paste the transcript text instead.");
    // Best-effort attempt via timedtext endpoint - frequently blocked by CORS/auth in-browser.
    const attempts = [
      `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`,
      `https://video.google.com/timedtext?lang=en&v=${videoId}`,
    ];
    for (const endpoint of attempts) {
      try {
        const r = await fetch(endpoint);
        if (r.ok) {
          const text = await r.text();
          if (text && text.includes("<text")) {
            const matches = [...text.matchAll(/<text[^>]*>([^<]*)<\/text>/g)];
            const joined = matches.map((m) => decodeHtmlEntities(m[1])).join(" ");
            if (joined.trim().length > 50) return joined;
          }
        }
      } catch (e) {
        // continue to next attempt / fallback
      }
    }
    throw new Error(
      "Couldn't automatically pull captions for this video from the browser - YouTube usually blocks this. Paste the transcript text instead (open the video, click \u201cShow transcript,\u201d copy it in, and paste it here)."
    );
  }

  function decodeHtmlEntities(str) {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  async function handleDistill() {
    setErrorMsg("");
    setPendingResult(null);
    let transcript = "";

    if (mode === "link") {
      if (!linkValue.trim()) {
        setErrorMsg("Paste a YouTube link first.");
        return;
      }
      setStatus("fetching");
      try {
        transcript = await tryFetchTranscript(linkValue.trim());
      } catch (e) {
        setStatus("error");
        setErrorMsg(e.message);
        return;
      }
    } else {
      if (!transcriptValue.trim() || transcriptValue.trim().length < 50) {
        setErrorMsg("Paste a fuller transcript - at least a few sentences of actual content.");
        return;
      }
      transcript = transcriptValue.trim();
    }

    setStatus("distilling");
    try {
      const raw = await callClaude(EXTRACTION_PROMPT(transcript.slice(0, 15000)));
      const cleaned = stripJsonFence(raw);
      const parsed = JSON.parse(cleaned);
      setPendingResult(parsed);
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setErrorMsg("Couldn't distill that transcript into a strategy. Try again, or paste a longer excerpt.");
    }
  }

  async function handleSave() {
    if (!pendingResult) return;
    const entry = {
      id: uid(),
      num: counter,
      name: pendingResult.name || "Untitled strategy",
      data: pendingResult,
      savedAt: Date.now(),
    };
    const updated = [entry, ...strategies];
    setStrategies(updated);
    setCounter(counter + 1);
    await persist(updated);
    setPendingResult(null);
    setLinkValue("");
    setTranscriptValue("");
    setSelectedId(entry.id);
  }

  function handleDiscard() {
    setPendingResult(null);
  }

  async function handleDelete(id) {
    const updated = strategies.filter((s) => s.id !== id);
    setStrategies(updated);
    await persist(updated);
    if (selectedId === id) setSelectedId(null);
  }

  function startRename(s) {
    setRenamingId(s.id);
    setRenameValue(s.name);
  }

  async function commitRename() {
    if (!renamingId) return;
    const updated = strategies.map((s) =>
      s.id === renamingId ? { ...s, name: renameValue.trim() || s.name } : s
    );
    setStrategies(updated);
    await persist(updated);
    setRenamingId(null);
  }

  const selected = strategies.find((s) => s.id === selectedId);
  const busy = status === "fetching" || status === "distilling";

  return (
    <div className="sd-root">
      <style>{`
        .sd-root {
          --ink: ${INK};
          --ink-light: ${INK_LIGHT};
          --paper: ${PAPER};
          --accent: ${ACCENT};
          --teal: ${TEAL};
          background: var(--ink);
          color: #DDE2EC;
          min-height: 100%;
          font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
          display: flex;
          flex-direction: column;
        }
        .sd-root * { box-sizing: border-box; }
        .mono { font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace; }

        .sd-header {
          padding: 28px 28px 18px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .sd-eyebrow {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--teal);
          margin: 0 0 6px;
        }
        .sd-title {
          font-size: 26px;
          margin: 0;
          font-weight: 600;
          color: #F2EFE6;
          letter-spacing: -0.01em;
        }
        .sd-sub {
          margin: 8px 0 0;
          font-size: 14px;
          color: #8B93A8;
          max-width: 520px;
          line-height: 1.5;
        }

        .sd-body {
          display: grid;
          grid-template-columns: minmax(280px, 380px) 1fr;
          gap: 0;
          flex: 1;
          min-height: 0;
        }
        @media (max-width: 760px) {
          .sd-body { grid-template-columns: 1fr; }
        }

        .intake {
          border-right: 1px solid rgba(255,255,255,0.08);
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .mode-toggle {
          display: flex;
          gap: 6px;
          background: rgba(255,255,255,0.04);
          border-radius: 8px;
          padding: 4px;
        }
        .mode-btn {
          flex: 1;
          border: none;
          background: transparent;
          color: #8B93A8;
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 12px;
          letter-spacing: 0.04em;
          padding: 8px 10px;
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: background 0.15s, color 0.15s;
        }
        .mode-btn.active {
          background: var(--ink-light);
          color: var(--accent);
        }

        .input-label {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #5C6479;
        }

        .link-input, .transcript-input {
          width: 100%;
          background: var(--ink-light);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 8px;
          color: #E8EAF0;
          padding: 12px 14px;
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 13px;
          resize: vertical;
        }
        .link-input { height: 44px; }
        .transcript-input { min-height: 220px; line-height: 1.6; }
        .link-input:focus, .transcript-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .link-input::placeholder, .transcript-input::placeholder {
          color: #4A5066;
        }

        .distill-btn {
          background: var(--accent);
          color: #1A1208;
          border: none;
          border-radius: 8px;
          padding: 12px 18px;
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.02em;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: filter 0.15s, transform 0.1s;
        }
        .distill-btn:hover:not(:disabled) { filter: brightness(1.08); }
        .distill-btn:active:not(:disabled) { transform: scale(0.98); }
        .distill-btn:disabled { opacity: 0.55; cursor: not-allowed; }

        .error-box {
          display: flex;
          gap: 8px;
          align-items: flex-start;
          background: rgba(217, 91, 67, 0.1);
          border: 1px solid rgba(217, 91, 67, 0.3);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 12.5px;
          color: #E8A98F;
          line-height: 1.5;
        }

        .hint {
          font-size: 12px;
          color: #5C6479;
          line-height: 1.5;
        }

        .preview-pane {
          padding: 24px;
          overflow-y: auto;
        }

        .pending-card {
          background: var(--paper);
          color: #2A2620;
          border-radius: 2px;
          padding: 28px 30px;
          position: relative;
        }
        .pending-flag {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--teal);
          margin: 0 0 10px;
        }
        .pending-name {
          font-size: 21px;
          font-weight: 700;
          margin: 0 0 14px;
          color: #1A1208;
        }
        .pending-actions {
          display: flex;
          gap: 10px;
          margin-top: 22px;
          padding-top: 18px;
          border-top: 1px dashed rgba(0,0,0,0.15);
        }
        .save-btn, .discard-btn {
          border: none;
          border-radius: 6px;
          padding: 9px 16px;
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .save-btn { background: #1A1208; color: var(--paper); }
        .discard-btn { background: transparent; color: #6B6452; border: 1px solid rgba(0,0,0,0.2); }

        .extracted-summary {
          font-size: 15px;
          line-height: 1.6;
          color: #3A3528;
          margin: 0 0 16px;
        }
        .meta-row { display: flex; gap: 8px; margin-bottom: 10px; }
        .meta-row.wrap { flex-wrap: wrap; }
        .meta-pill {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 10.5px;
          border: 1px solid;
          border-radius: 20px;
          padding: 3px 10px;
          text-transform: lowercase;
        }
        .indicator-tag {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 11px;
          background: rgba(74, 140, 130, 0.12);
          color: #2F6B62;
          border-radius: 4px;
          padding: 3px 8px;
        }
        .rule-section { margin-top: 18px; }
        .rule-section-title {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--accent);
          margin-bottom: 8px;
        }
        .rule-list { margin: 0; padding-left: 20px; }
        .rule-list li {
          font-size: 14px;
          line-height: 1.6;
          color: #3A3528;
          margin-bottom: 6px;
        }
        .rule-list.bulleted { list-style: disc; }

        .library {
          padding: 24px;
        }
        .library-title {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 11px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #5C6479;
          margin-bottom: 14px;
        }
        .empty-state {
          border: 1px dashed rgba(255,255,255,0.15);
          border-radius: 8px;
          padding: 32px 20px;
          text-align: center;
          color: #5C6479;
          font-size: 13.5px;
          line-height: 1.6;
        }

        .ticket {
          background: var(--paper);
          color: #2A2620;
          border-radius: 2px;
          margin-bottom: 14px;
          position: relative;
          padding: 18px 20px 18px 22px;
          cursor: pointer;
          transition: transform 0.12s;
          background-image:
            radial-gradient(circle, transparent 4px, var(--ink) 4.2px, var(--ink) 5px, transparent 5.2px);
          background-size: 100% 16px;
          background-position: -8px -4px;
        }
        .ticket-inner {
          background: var(--paper);
          padding: 0;
        }
        .ticket:hover { transform: translateX(2px); }
        .ticket-top {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }
        .ticket-num {
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 10.5px;
          color: var(--teal);
          letter-spacing: 0.05em;
        }
        .ticket-name {
          font-size: 17px;
          font-weight: 700;
          margin: 4px 0 6px;
          color: #1A1208;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .ticket-summary {
          font-size: 12.5px;
          color: #6B6452;
          line-height: 1.5;
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .ticket-actions {
          position: absolute;
          top: 14px;
          right: 14px;
          display: flex;
          gap: 4px;
        }
        .ticket-icon-btn {
          background: rgba(0,0,0,0.06);
          border: none;
          border-radius: 4px;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: #6B6452;
        }
        .ticket-icon-btn:hover { background: rgba(0,0,0,0.12); }

        .rename-input {
          font-size: 16px;
          font-weight: 700;
          font-family: inherit;
          border: none;
          border-bottom: 1px solid var(--accent);
          background: transparent;
          color: #1A1208;
          padding: 2px 0;
          width: 80%;
        }
        .rename-input:focus { outline: none; }

        .detail-overlay {
          padding: 24px;
        }
        .detail-back {
          background: transparent;
          border: none;
          color: var(--teal);
          font-family: 'SF Mono', Menlo, Consolas, monospace;
          font-size: 12px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          margin-bottom: 16px;
          padding: 0;
        }
        .detail-card {
          background: var(--paper);
          color: #2A2620;
          border-radius: 2px;
          padding: 28px 30px;
        }
        .detail-name {
          font-size: 23px;
          font-weight: 700;
          margin: 0 0 14px;
          color: #1A1208;
        }

        .spin { animation: sd-spin 0.9s linear infinite; }
        @keyframes sd-spin { to { transform: rotate(360deg); } }
      `}</style>

      <div className="sd-header">
        <p className="sd-eyebrow mono">Strategy Distiller</p>
        <h1 className="sd-title">Turn trading talk into a written ruleset</h1>
        <p className="sd-sub">
          Paste a YouTube link or a transcript. It gets read once and turned into entry rules,
          exit rules, and risk notes you can keep, rename, and come back to.
        </p>
      </div>

      <div className="sd-body">
        <div className="intake">
          <div className="mode-toggle">
            <button
              className={"mode-btn" + (mode === "link" ? " active" : "")}
              onClick={() => { setMode("link"); setErrorMsg(""); }}
            >
              <Link2 size={13} /> Link
            </button>
            <button
              className={"mode-btn" + (mode === "transcript" ? " active" : "")}
              onClick={() => { setMode("transcript"); setErrorMsg(""); }}
            >
              <ScrollText size={13} /> Transcript
            </button>
          </div>

          {mode === "link" ? (
            <>
              <div className="input-label mono">YouTube link</div>
              <input
                ref={inputRef}
                className="link-input"
                placeholder="https://www.youtube.com/watch?v=..."
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                disabled={busy}
              />
              <p className="hint">
                Tries to pull captions automatically. If YouTube blocks it, switch to the
                Transcript tab and paste the text instead.
              </p>
            </>
          ) : (
            <>
              <div className="input-label mono">Pasted transcript</div>
              <textarea
                className="transcript-input"
                placeholder="Paste the full transcript here..."
                value={transcriptValue}
                onChange={(e) => setTranscriptValue(e.target.value)}
                disabled={busy}
              />
            </>
          )}

          {errorMsg && (
            <div className="error-box">
              <AlertCircle size={15} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>{errorMsg}</span>
            </div>
          )}

          <button className="distill-btn" onClick={handleDistill} disabled={busy}>
            {busy ? (
              <>
                <Loader2 size={14} className="spin" />
                {status === "fetching" ? "Fetching captions..." : "Distilling strategy..."}
              </>
            ) : (
              <>
                <Wand2 size={14} /> Distill strategy
              </>
            )}
          </button>
        </div>

        <div className="preview-pane">
          {pendingResult ? (
            <div className="pending-card">
              <p className="pending-flag mono">Draft — not yet saved</p>
              <h2 className="pending-name">{pendingResult.name}</h2>
              <ExtractedView data={pendingResult} />
              <div className="pending-actions">
                <button className="save-btn" onClick={handleSave}>
                  <Save size={13} /> Save to library
                </button>
                <button className="discard-btn" onClick={handleDiscard}>
                  <X size={13} /> Discard
                </button>
              </div>
            </div>
          ) : selected ? (
            <div className="detail-overlay">
              <button className="detail-back mono" onClick={() => setSelectedId(null)}>
                <ChevronRight size={13} style={{ transform: "rotate(180deg)" }} /> Back to library
              </button>
              <div className="detail-card">
                <p className="pending-flag mono">{ticketNumber(selected.num)}</p>
                <h2 className="detail-name">{selected.name}</h2>
                <ExtractedView data={selected.data} />
              </div>
            </div>
          ) : (
            <div className="library">
              <p className="library-title mono">
                Your library {strategies.length > 0 ? `(${strategies.length})` : ""}
              </p>
              {!loaded ? (
                <p className="hint">Loading...</p>
              ) : strategies.length === 0 ? (
                <div className="empty-state">
                  Nothing saved yet. Distill a transcript on the left, then save it here.
                </div>
              ) : (
                strategies.map((s) => (
                  <div key={s.id} className="ticket" onClick={() => renamingId !== s.id && setSelectedId(s.id)}>
                    <div className="ticket-top">
                      <span className="ticket-num mono">{ticketNumber(s.num)}</span>
                    </div>
                    {renamingId === s.id ? (
                      <input
                        className="rename-input"
                        value={renameValue}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && commitRename()}
                        onBlur={commitRename}
                      />
                    ) : (
                      <div className="ticket-name">{s.name}</div>
                    )}
                    <p className="ticket-summary">{s.data.summary}</p>
                    <div className="ticket-actions">
                      <button
                        className="ticket-icon-btn"
                        onClick={(e) => { e.stopPropagation(); startRename(s); }}
                        title="Rename"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        className="ticket-icon-btn"
                        onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
