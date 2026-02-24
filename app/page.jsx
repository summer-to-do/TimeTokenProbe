"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_DT = 120;
const TOKEN_REGEX = /\[(\d+(?:\.\d+)?)S\]/g;

function formatGap(ms, dtMs, quantize) {
  const gapMs = Math.max(ms, 0);
  if (!quantize) {
    return `[${(gapMs / 1000).toFixed(2)}S]`;
  }
  const ticks = Math.max(1, Math.round(gapMs / dtMs));
  return `[${((ticks * dtMs) / 1000).toFixed(2)}S]`;
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function trimSegmentsToRawLength(segments, rawLen) {
  const next = [];
  let consumed = 0;
  for (const segment of segments) {
    if (segment.type === "token") {
      if (consumed <= rawLen) {
        next.push(segment);
      }
      continue;
    }
    if (consumed >= rawLen) {
      break;
    }
    const keep = Math.min(segment.value.length, rawLen - consumed);
    if (keep > 0) {
      next.push({ type: "text", value: segment.value.slice(0, keep) });
      consumed += keep;
    }
    if (consumed >= rawLen) {
      break;
    }
  }
  return next;
}

function segmentsToString(segments) {
  return segments.map((segment) => segment.value).join("");
}

function appendSegments(segments, text, gapMs, dtMs, quantize) {
  if (!text) {
    return segments;
  }
  let next = segments;
  if (next.length && next[next.length - 1].type === "token") {
    next = next.slice(0, -1);
  }
  if (gapMs >= dtMs) {
    next = [
      ...next,
      { type: "token", value: formatGap(gapMs, dtMs, quantize) }
    ];
  }
  return [...next, { type: "text", value: text }];
}

function splitTemporal(text) {
  TOKEN_REGEX.lastIndex = 0;
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = TOKEN_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "pause", value: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

function sleep(ms, timersRef) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    timersRef.current.push(id);
  });
}

export default function Page() {
  const [rawInput, setRawInput] = useState("");
  const [temporalInput, setTemporalInput] = useState("");
  const [dtMs, setDtMs] = useState(DEFAULT_DT);
  const [quantize, setQuantize] = useState(true);
  const [responseRaw, setResponseRaw] = useState("");
  const [responsePlainRaw, setResponsePlainRaw] = useState("");
  const [responseRendered, setResponseRendered] = useState("");
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");

  const lastEditAtRef = useRef(null);
  const lastRawRef = useRef("");
  const segmentsRef = useRef([]);
  const cancelRef = useRef(null);
  const timersRef = useRef([]);
  const composingRef = useRef(false);
  const compositionBaseRef = useRef("");
  const lastCompositionValueRef = useRef(null);

  const tokenPreview = useMemo(() => {
    return formatGap(dtMs, dtMs, true);
  }, [dtMs]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current = [];
    };
  }, []);

  const clearTimers = () => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
  };

  const resetTemporal = () => {
    const segments = rawInput ? [{ type: "text", value: rawInput }] : [];
    segmentsRef.current = segments;
    setTemporalInput(segmentsToString(segments));
    lastEditAtRef.current = null;
    lastRawRef.current = rawInput;
  };

  const applyInputChange = (value, prevRawOverride) => {
    const now = performance.now();
    const prevRaw = prevRawOverride ?? lastRawRef.current;
    const gap =
      lastEditAtRef.current === null ? 0 : now - lastEditAtRef.current;

    let segments = segmentsRef.current;
    if (value.startsWith(prevRaw) && value.length >= prevRaw.length) {
      const inserted = value.slice(prevRaw.length);
      segments = appendSegments(segments, inserted, gap, dtMs, quantize);
    } else {
      const prefixLen = commonPrefixLength(prevRaw, value);
      segments = trimSegmentsToRawLength(segments, prefixLen);
      const inserted = value.slice(prefixLen);
      segments = appendSegments(segments, inserted, gap, dtMs, quantize);
    }

    segmentsRef.current = segments;
    setTemporalInput(segmentsToString(segments));
    setRawInput(value);
    lastRawRef.current = value;
    lastEditAtRef.current = now;
  };

  const handleChange = (event) => {
    const value = event.target.value;
    if (
      lastCompositionValueRef.current !== null &&
      value === lastCompositionValueRef.current
    ) {
      lastCompositionValueRef.current = null;
      return;
    }
    if (composingRef.current) {
      setRawInput(value);
      lastRawRef.current = value;
      return;
    }
    applyInputChange(value);
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
    compositionBaseRef.current = lastRawRef.current;
  };

  const handleCompositionEnd = (event) => {
    composingRef.current = false;
    applyInputChange(event.target.value, compositionBaseRef.current);
    lastCompositionValueRef.current = event.target.value;
    compositionBaseRef.current = "";
  };

  const playResponse = async (text) => {
    if (cancelRef.current) {
      cancelRef.current();
    }
    clearTimers();
    setResponseRendered("");
    setStatus("Rendering");

    const segments = splitTemporal(text);
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
      setStatus("Idle");
    };

    for (const segment of segments) {
      if (cancelled) {
        return;
      }
      if (segment.type === "pause") {
        const delay = Math.min(segment.value * 1000, 4000);
        if (delay > 0) {
          await sleep(delay, timersRef);
        }
      } else {
        setResponseRendered((prevText) => prevText + segment.value);
      }
    }

    setStatus("Idle");
  };

  const callApi = async (message, mode) => {
    const payload = {
      message,
      dtMs,
      mode
    };
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Request failed");
    }
    return data.text || "";
  };

  const handleGenerate = async () => {
    setError("");
    setStatus("Calling LLM");
    setResponseRaw("");
    setResponsePlainRaw("");
    setResponseRendered("");
    clearTimers();

    try {
      const text = await callApi(temporalInput || rawInput, "temporal");
      setResponseRaw(text);
      await playResponse(text);
    } catch (err) {
      setError(err.message || "Unexpected error");
      setStatus("Idle");
    }
  };

  const handleCompare = async () => {
    setError("");
    setStatus("Calling LLM (compare)");
    setResponseRaw("");
    setResponsePlainRaw("");
    setResponseRendered("");
    clearTimers();

    try {
      const [plainText, temporalText] = await Promise.all([
        callApi(rawInput, "plain"),
        callApi(temporalInput || rawInput, "temporal")
      ]);
      setResponsePlainRaw(plainText);
      setResponseRaw(temporalText);
      await playResponse(temporalText);
    } catch (err) {
      setError(err.message || "Unexpected error");
      setStatus("Idle");
    }
  };

  const handleStop = () => {
    if (cancelRef.current) {
      cancelRef.current();
    }
    clearTimers();
    setStatus("Idle");
  };

  return (
    <main className="page">
      <header className="hero">
        <h1>TimeToken Demo</h1>
        <p>
          Temporal tokens are injected while you type, then rendered as pauses
          in the response. The timing granularity is configurable.
        </p>
      </header>

      <section className="grid">
        <div className="card stack">
          <h2 className="section-title">Input</h2>
          <div className="stack">
            <label htmlFor="raw-input">Raw text</label>
            <textarea
              id="raw-input"
              placeholder="Type naturally. Pauses become tokens."
              value={rawInput}
              onChange={handleChange}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
            />

            <div className="controls">
              <div className="range">
                <label htmlFor="dt-range">
                  Delta t (ms) - current token {tokenPreview}
                </label>
                <input
                  id="dt-range"
                  type="range"
                  min="80"
                  max="600"
                  step="10"
                  value={dtMs}
                  onChange={(event) => setDtMs(Number(event.target.value))}
                />
              </div>
              <div className="range">
                <label htmlFor="dt-input">Delta t value</label>
                <input
                  id="dt-input"
                  type="number"
                  min="40"
                  max="1200"
                  value={dtMs}
                  onChange={(event) => setDtMs(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="row">
              <label className="pill">
                <input
                  type="checkbox"
                  checked={quantize}
                  onChange={(event) => setQuantize(event.target.checked)}
                />
                Quantize to delta t
              </label>
              <span className="pill">
                Token format <span className="highlight">[0.53S]</span>
              </span>
            </div>

            <div className="stack">
              <label>Temporalized input</label>
              <div className="panel mono">{temporalInput || "..."}</div>
              <div className="status">
                Tip: editing in the middle resets the timing history.
              </div>
              <div className="row">
                <button className="secondary" onClick={resetTemporal}>
                  Reset temporal history
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="card stack output">
          <h2 className="section-title">Output</h2>
          <div className="actions">
            <button
              className="primary"
              onClick={handleGenerate}
              disabled={!rawInput || status !== "Idle"}
            >
              Call LLM
            </button>
            <button
              className="secondary"
              onClick={handleCompare}
              disabled={!rawInput || status !== "Idle"}
            >
              Compare prompts
            </button>
            <button className="secondary" onClick={handleStop}>
              Stop render
            </button>
          </div>
          <div className="status">Status: {status}</div>
          {error ? <div className="status">Error: {error}</div> : null}

          <div className="compare-grid">
            <div className="stack">
              <label>Plain system (no time tokens)</label>
              <div className="panel mono">{responsePlainRaw || "..."}</div>
            </div>
            <div className="stack">
              <label>Temporal system (with [0.53S])</label>
              <div className="panel mono">{responseRaw || "..."}</div>
              <div className="stack">
                <label>Rendered response</label>
                <div className="panel">{responseRendered || "..."}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
