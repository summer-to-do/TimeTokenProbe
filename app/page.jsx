"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_DT = 120;

const SCENARIOS = [
  {
    id: "IR",
    label: "信息检索",
    sublabel: "IR",
    temporal:
      "你能帮我查一下[0.30S]今年诺贝尔[0.20S]物理学奖[0.10S]是谁获得的吗",
  },
  {
    id: "LR",
    label: "学习获取",
    sublabel: "LR",
    temporal:
      "我不太理解[2.10S]为什么[3.50S]量子纠缠[1.80S]不能用来[2.40S]传递信息",
  },
  {
    id: "PS",
    label: "问题求解",
    sublabel: "PS",
    temporal:
      "帮我看看[0.80S]这段代码[1.50S]为什么[3.20S]一直报错[0.10S]TypeError",
  },
  {
    id: "CR",
    label: "内容创作",
    sublabel: "CR",
    temporal:
      "帮我写[0.50S]一段[1.80S]关于[4.20S]可持续发展的[0.30S]演讲开场白",
  },
  {
    id: "ES",
    label: "情感支持",
    sublabel: "ES",
    temporal:
      "最近[2.80S]工作压力[4.10S]真的[1.50S]有点大[6.00S]不知道该怎么办",
  },
  {
    id: "LS",
    label: "休闲娱乐",
    sublabel: "LS",
    temporal:
      "你觉得[0.30S]如果猫[0.20S]能说话[0.10S]它们第一句话会说什么",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDefaultSystemPrompt(dtMs) {
  const sec = (Number(dtMs) / 1000).toFixed(2);
  return [
    "You are a conversational model that uses Time tokens to express pauses.",
    "Time tokens look like [0.53S] and represent a pause in seconds.",
    `Prefer pauses in multiples of ${sec}S when possible.`,
    "尽可能理解用户输入中的 time token，以感知用户的节奏与情绪状态。",
    "Keep temporal tokens inside the response text; do not explain them.",
    "Reply in a natural, compact tone.",
  ].join(" ");
}

function formatGap(ms, dtMs, quantize) {
  const gapMs = Math.max(ms, 0);
  if (!quantize) return `[${(gapMs / 1000).toFixed(2)}S]`;
  const ticks = Math.max(1, Math.round(gapMs / dtMs));
  return `[${((ticks * dtMs) / 1000).toFixed(2)}S]`;
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function trimSegmentsToRawLength(segments, rawLen) {
  const next = [];
  let consumed = 0;
  for (const seg of segments) {
    if (seg.type === "token") {
      if (consumed <= rawLen) next.push(seg);
      continue;
    }
    if (consumed >= rawLen) break;
    const keep = Math.min(seg.value.length, rawLen - consumed);
    if (keep > 0) {
      next.push({ type: "text", value: seg.value.slice(0, keep) });
      consumed += keep;
    }
    if (consumed >= rawLen) break;
  }
  return next;
}

function segmentsToString(segments) {
  return segments.map((s) => s.value).join("");
}

function appendSegments(segments, text, gapMs, dtMs, quantize) {
  if (!text) return segments;
  let next = segments;
  if (next.length && next[next.length - 1].type === "token")
    next = next.slice(0, -1);
  if (gapMs >= dtMs)
    next = [...next, { type: "token", value: formatGap(gapMs, dtMs, quantize) }];
  return [...next, { type: "text", value: text }];
}

function splitTemporal(text) {
  const re = /\[(\d+(?:\.\d+)?)S\]/gi;
  const segs = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex)
      segs.push({ type: "text", value: text.slice(lastIndex, match.index) });
    segs.push({ type: "pause", value: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length)
    segs.push({ type: "text", value: text.slice(lastIndex) });
  return segs;
}

function parseTemporalString(str) {
  const re = /\[(\d+(?:\.\d+)?)S\]/gi;
  const segs = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(str)) !== null) {
    if (match.index > lastIndex)
      segs.push({ type: "text", value: str.slice(lastIndex, match.index) });
    segs.push({
      type: "token",
      value: `[${parseFloat(match[1]).toFixed(2)}S]`,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < str.length)
    segs.push({ type: "text", value: str.slice(lastIndex) });
  return segs;
}

function rawFromSegments(segs) {
  return segs
    .filter((s) => s.type === "text")
    .map((s) => s.value)
    .join("");
}

function durationToHue(seconds) {
  const clamped = Math.max(0, Math.min(seconds, 5));
  return Math.round(200 - (clamped / 5) * 180);
}

function durationToWidth(seconds) {
  return Math.max(10, Math.min(seconds * 44, 180));
}

function sleep(ms, timersRef) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    timersRef.current.push(id);
  });
}

// ─── TimeBar ─────────────────────────────────────────────────────────────────

function TimeBar({ duration, index, onDurationChange }) {
  const startRef = useRef(null);
  const hue = durationToHue(duration);
  const width = durationToWidth(duration);
  const barColor = `hsl(${hue}, 70%, 42%)`;
  const borderColor = `hsl(${hue}, 90%, 62%)`;
  const labelColor = `hsl(${hue}, 90%, 72%)`;

  const handleMouseDown = (e) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, duration };
    const onMove = (ev) => {
      if (!startRef.current) return;
      const delta = ev.clientX - startRef.current.x;
      const newDur = Math.max(0.05, startRef.current.duration + delta / 44);
      onDurationChange(index, Math.round(newDur * 100) / 100);
    };
    const onUp = () => {
      startRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <span
      className="timebar"
      style={{
        width,
        background: barColor,
        borderRight: `3px solid ${borderColor}`,
      }}
      title={`${duration.toFixed(2)}s — drag right edge to resize`}
    >
      <span className="timebar-label" style={{ color: labelColor }}>
        {duration.toFixed(2)}s
      </span>
      <span className="timebar-handle" onMouseDown={handleMouseDown} />
    </span>
  );
}

// ─── TokenRow ─────────────────────────────────────────────────────────────────

function TokenRow({ segments, onDurationChange }) {
  if (!segments || segments.length === 0) return null;
  return (
    <div className="token-row">
      {segments.map((seg, i) => {
        if (seg.type === "token") {
          const m = seg.value.match(/\[(\d+(?:\.\d+)?)S\]/i);
          const dur = m ? parseFloat(m[1]) : 0;
          return (
            <TimeBar
              key={i}
              duration={dur}
              index={i}
              onDurationChange={onDurationChange}
            />
          );
        }
        if (seg.type === "pause") {
          return (
            <TimeBar
              key={i}
              duration={seg.value}
              index={i}
              onDurationChange={onDurationChange}
            />
          );
        }
        return (
          <span key={i} className="token-text">
            {seg.value}
          </span>
        );
      })}
    </div>
  );
}

// ─── AI Cursor ────────────────────────────────────────────────────────────────

function AICursor({ state }) {
  if (state === "idle") return null;
  return (
    <span
      className={
        state === "pause" ? "ai-cursor ai-cursor--breathe" : "ai-cursor ai-cursor--blink"
      }
      aria-hidden="true"
    />
  );
}

// ─── System Prompt Editor ─────────────────────────────────────────────────────

function SystemPromptEditor({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sysprompt-wrap">
      <button
        className="sysprompt-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="sysprompt-caret">{open ? "▲" : "▼"}</span>
        <span>System Prompt</span>
        {!open && (
          <span className="sysprompt-preview">
            {value.slice(0, 90)}…
          </span>
        )}
      </button>
      {open && (
        <textarea
          className="sysprompt-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={5}
          spellCheck={false}
        />
      )}
    </div>
  );
}

// ─── Conversation Panel ───────────────────────────────────────────────────────

function ConversationPanel({ renderedText, plainText, cursorState, status }) {
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [renderedText, plainText]);

  const isEmpty = !plainText && !renderedText && cursorState === "idle";

  return (
    <div className="conv-panel">
      <div className="conv-header">
        <span className="panel-badge badge-blue">Conversation Panel</span>
        <span className="conv-status-pill">{status}</span>
      </div>
      <div className="conv-body">
        {isEmpty && (
          <div className="conv-empty">
            <div className="conv-empty-icon">⏱</div>
            <div>Response will appear here with temporal pauses rendered as real delays.</div>
            <div className="conv-empty-sub">Use <strong>Compare Prompts</strong> to see both models side-by-side.</div>
          </div>
        )}

        {plainText && (
          <div className="bubble-row bubble-row--left">
            <div className="bubble bubble--plain">
              <div className="bubble-label">Standard Model (no time tokens)</div>
              <div className="bubble-text">{plainText}</div>
            </div>
          </div>
        )}

        {(renderedText || cursorState !== "idle") && (
          <div className="bubble-row bubble-row--right">
            <div className="bubble bubble--temporal">
              <div className="bubble-label">
                Time-Aware Model
                {cursorState === "pause" && (
                  <span className="pause-indicator"> · deliberate pause</span>
                )}
              </div>
              <div className="bubble-text">
                {renderedText}
                <AICursor state={cursorState} />
              </div>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── Config Panel ─────────────────────────────────────────────────────────────

function ConfigDrawer({ configs, onLoad, onDelete }) {
  const [open, setOpen] = useState(false);
  if (configs.length === 0) return null;
  return (
    <div className="config-drawer-wrap">
      <button className="secondary" onClick={() => setOpen((o) => !o)}>
        Saved ({configs.length}) {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="config-drawer">
          {configs.map((cfg, i) => (
            <div key={i} className="config-item">
              <button className="config-item-btn" onClick={() => { onLoad(cfg); setOpen(false); }}>
                <span className="config-item-time">
                  {new Date(cfg.timestamp).toLocaleString()}
                </span>
                <span className="config-item-preview">
                  {cfg.rawInput?.slice(0, 48) || "(empty input)"}
                </span>
              </button>
              <button className="config-item-del" onClick={() => onDelete(i)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Page() {
  // Input state
  const [rawInput, setRawInput] = useState("");
  const [temporalInput, setTemporalInput] = useState("");
  const [dtMs, setDtMs] = useState(DEFAULT_DT);
  const [quantize, setQuantize] = useState(true);

  // System prompt
  const [systemPrompt, setSystemPrompt] = useState(() =>
    buildDefaultSystemPrompt(DEFAULT_DT)
  );

  // Response state
  const [responseRaw, setResponseRaw] = useState("");
  const [responsePlainRaw, setResponsePlainRaw] = useState("");
  const [responseRendered, setResponseRendered] = useState("");

  // UI state
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [cursorState, setCursorState] = useState("idle"); // "idle"|"typing"|"pause"

  // Config
  const [configs, setConfigs] = useState([]);

  // Refs for timing/composition
  const lastEditAtRef = useRef(null);
  const lastRawRef = useRef("");
  const segmentsRef = useRef([]);
  const cancelRef = useRef(null);
  const timersRef = useRef([]);
  const composingRef = useRef(false);
  const compositionBaseRef = useRef("");
  const lastCompositionValueRef = useRef(null);

  // Force re-render of token row when segments change
  const [segmentVersion, setSegmentVersion] = useState(0);
  const bumpSegments = () => setSegmentVersion((v) => v + 1);

  // Load saved configs
  useEffect(() => {
    try {
      const saved = localStorage.getItem("timetoken-configs");
      if (saved) setConfigs(JSON.parse(saved));
    } catch {}
  }, []);

  // Cleanup timers
  useEffect(() => {
    return () => { timersRef.current.forEach(clearTimeout); };
  }, []);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  // ─── Input Handling ──────────────────────────────────────────────────────

  const resetTemporal = () => {
    const segs = rawInput ? [{ type: "text", value: rawInput }] : [];
    segmentsRef.current = segs;
    setTemporalInput(segmentsToString(segs));
    lastEditAtRef.current = null;
    lastRawRef.current = rawInput;
    bumpSegments();
  };

  const applyInputChange = (value, prevRawOverride) => {
    const now = performance.now();
    const prevRaw = prevRawOverride ?? lastRawRef.current;
    const gap =
      lastEditAtRef.current === null ? 0 : now - lastEditAtRef.current;
    let segs = segmentsRef.current;
    if (value.startsWith(prevRaw) && value.length >= prevRaw.length) {
      segs = appendSegments(segs, value.slice(prevRaw.length), gap, dtMs, quantize);
    } else {
      const prefixLen = commonPrefixLength(prevRaw, value);
      segs = trimSegmentsToRawLength(segs, prefixLen);
      segs = appendSegments(segs, value.slice(prefixLen), gap, dtMs, quantize);
    }
    segmentsRef.current = segs;
    setTemporalInput(segmentsToString(segs));
    setRawInput(value);
    lastRawRef.current = value;
    lastEditAtRef.current = now;
    bumpSegments();
  };

  const handleChange = (e) => {
    const value = e.target.value;
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

  const handleCompositionEnd = (e) => {
    composingRef.current = false;
    applyInputChange(e.target.value, compositionBaseRef.current);
    lastCompositionValueRef.current = e.target.value;
    compositionBaseRef.current = "";
  };

  // ─── Token Duration Editing ───────────────────────────────────────────────

  const handleInputTokenDurationChange = (index, newDur) => {
    const segs = segmentsRef.current.map((seg, i) => {
      if (i !== index || seg.type !== "token") return seg;
      return { type: "token", value: `[${newDur.toFixed(2)}S]` };
    });
    segmentsRef.current = segs;
    setTemporalInput(segmentsToString(segs));
    bumpSegments();
  };

  const handleOutputTokenDurationChange = (index, newDur) => {
    const segs = splitTemporal(responseRaw).map((seg, i) => {
      if (i !== index || seg.type !== "pause") return seg;
      return { ...seg, value: newDur };
    });
    const newRaw = segs
      .map((s) => (s.type === "pause" ? `[${s.value.toFixed(2)}S]` : s.value))
      .join("");
    setResponseRaw(newRaw);
  };

  // ─── Scenario Loading ─────────────────────────────────────────────────────

  const loadScenario = (scenario) => {
    const segs = parseTemporalString(scenario.temporal);
    const raw = rawFromSegments(segs);
    segmentsRef.current = segs;
    setRawInput(raw);
    setTemporalInput(segmentsToString(segs));
    lastRawRef.current = raw;
    lastEditAtRef.current = null;
    setResponseRaw("");
    setResponsePlainRaw("");
    setResponseRendered("");
    setCursorState("idle");
    bumpSegments();
  };

  // ─── Response Playback ────────────────────────────────────────────────────

  const playResponse = async (text) => {
    if (cancelRef.current) cancelRef.current();
    clearTimers();
    setResponseRendered("");
    setStatus("Rendering");
    setCursorState("typing");

    const segs = splitTemporal(text);
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
      setCursorState("idle");
      setStatus("Idle");
    };

    for (const seg of segs) {
      if (cancelled) return;
      if (seg.type === "pause") {
        const delay = Math.min(seg.value * 1000, 6000);
        if (delay > 50) {
          setCursorState("pause");
          await sleep(delay, timersRef);
          if (cancelled) return;
          setCursorState("typing");
        }
      } else {
        setResponseRendered((prev) => prev + seg.value);
      }
    }
    setCursorState("idle");
    setStatus("Idle");
  };

  // ─── API ─────────────────────────────────────────────────────────────────

  const callApi = async (message, mode, customPrompt) => {
    const payload = { message, dtMs, mode, systemPrompt: customPrompt || null };
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Request failed");
    return data.text || "";
  };

  const handleGenerate = async () => {
    setError("");
    setStatus("Calling LLM…");
    setResponseRaw("");
    setResponsePlainRaw("");
    setResponseRendered("");
    clearTimers();
    try {
      const text = await callApi(
        temporalInput || rawInput,
        "temporal",
        systemPrompt
      );
      setResponseRaw(text);
      await playResponse(text);
    } catch (err) {
      setError(err.message || "Unexpected error");
      setStatus("Idle");
      setCursorState("idle");
    }
  };

  const handleCompare = async () => {
    setError("");
    setStatus("Calling LLM (compare)…");
    setResponseRaw("");
    setResponsePlainRaw("");
    setResponseRendered("");
    clearTimers();
    try {
      const [plainText, temporalText] = await Promise.all([
        callApi(rawInput, "plain", null),
        callApi(temporalInput || rawInput, "temporal", systemPrompt),
      ]);
      setResponsePlainRaw(plainText);
      setResponseRaw(temporalText);
      await playResponse(temporalText);
    } catch (err) {
      setError(err.message || "Unexpected error");
      setStatus("Idle");
      setCursorState("idle");
    }
  };

  const handleStop = () => {
    if (cancelRef.current) cancelRef.current();
    clearTimers();
    setCursorState("idle");
    setStatus("Idle");
  };

  // ─── Configuration ────────────────────────────────────────────────────────

  const saveConfig = () => {
    const cfg = {
      dtMs,
      quantize,
      systemPrompt,
      rawInput,
      temporalInput,
      segments: segmentsRef.current,
      timestamp: new Date().toISOString(),
    };
    const next = [...configs, cfg];
    setConfigs(next);
    try {
      localStorage.setItem("timetoken-configs", JSON.stringify(next));
    } catch {}
  };

  const loadConfig = (cfg) => {
    setDtMs(cfg.dtMs ?? DEFAULT_DT);
    setQuantize(cfg.quantize ?? true);
    if (cfg.systemPrompt) setSystemPrompt(cfg.systemPrompt);
    if (cfg.segments) {
      segmentsRef.current = cfg.segments;
      setRawInput(cfg.rawInput || "");
      setTemporalInput(segmentsToString(cfg.segments));
      lastRawRef.current = cfg.rawInput || "";
      bumpSegments();
    }
  };

  const deleteConfig = (i) => {
    const next = configs.filter((_, idx) => idx !== i);
    setConfigs(next);
    try {
      localStorage.setItem("timetoken-configs", JSON.stringify(next));
    } catch {}
  };

  const handleReset = () => {
    if (cancelRef.current) cancelRef.current();
    clearTimers();
    setRawInput("");
    setTemporalInput("");
    setResponseRaw("");
    setResponsePlainRaw("");
    setResponseRendered("");
    setError("");
    setStatus("Idle");
    setCursorState("idle");
    segmentsRef.current = [];
    lastRawRef.current = "";
    lastEditAtRef.current = null;
    setSystemPrompt(buildDefaultSystemPrompt(dtMs));
    bumpSegments();
  };

  // ─── Derived ─────────────────────────────────────────────────────────────

  const tokenPreview = useMemo(() => formatGap(dtMs, dtMs, true), [dtMs]);
  const inputSegments = segmentsRef.current; // re-renders via segmentVersion
  const outputSegments = useMemo(() => splitTemporal(responseRaw), [responseRaw]);
  const isIdle = status === "Idle";

  // Suppress lint warning — segmentVersion is read to trigger re-renders
  void segmentVersion;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <main className="page">
      {/* Header */}
      <header className="hero">
        <h1>
          TimeToken<span className="hero-accent">Probe</span>
        </h1>
        <p>
          Explore temporal interaction in Human–LLM conversations. Typing rhythm
          becomes tokens; tokens become pauses.
        </p>
      </header>

      {/* System Prompt Editor */}
      <SystemPromptEditor value={systemPrompt} onChange={setSystemPrompt} />

      {/* Dual-panel body */}
      <div className="dual-panel">
        {/* ──────────── DEBUG PANEL (left) ──────────── */}
        <div className="debug-panel">
          <div className="panel-header">
            <span className="panel-badge badge-orange">Debug Panel</span>
            <span className="panel-subtitle">Token-level view · editable</span>
          </div>

          {/* Scenario chips */}
          <div className="scenario-bar">
            <span className="scenario-label">Preloaded scenarios:</span>
            <div className="scenario-chips">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  className="chip"
                  onClick={() => loadScenario(s)}
                  title={s.temporal}
                >
                  {s.label}
                  <span className="chip-sub">{s.sublabel}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Input section ── */}
          <section className="debug-section">
            <div className="debug-section-title">
              INPUT — Inter-word Time Bars
              <span className="section-hint">drag bar edges to adjust</span>
            </div>

            {inputSegments.length > 0 && (
              <TokenRow
                segments={inputSegments}
                onDurationChange={handleInputTokenDurationChange}
              />
            )}

            <textarea
              className="debug-textarea"
              placeholder="Type naturally — pauses between keystrokes become temporal tokens."
              value={rawInput}
              onChange={handleChange}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
            />

            <div className="controls-row">
              <div className="range-group">
                <label className="range-label">
                  Δt <strong>{dtMs}ms</strong> → {tokenPreview}
                </label>
                <input
                  type="range"
                  min="80"
                  max="600"
                  step="10"
                  value={dtMs}
                  onChange={(e) => setDtMs(Number(e.target.value))}
                />
              </div>
              <label className="pill">
                <input
                  type="checkbox"
                  checked={quantize}
                  onChange={(e) => setQuantize(e.target.checked)}
                />
                Quantize
              </label>
              <button className="chip chip--ghost" onClick={resetTemporal}>
                Reset Timing
              </button>
            </div>

            <div className="mono-preview">
              {temporalInput || <span className="muted">…</span>}
            </div>
          </section>

          {/* ── Output standard section ── */}
          <section className="debug-section">
            <div className="debug-section-title">
              OUTPUT — Standard Model
              <span className="section-hint badge-plain">no time tokens</span>
            </div>
            <div className="mono-preview mono-preview--plain">
              {responsePlainRaw || <span className="muted">…</span>}
            </div>
          </section>

          {/* ── Output temporal section ── */}
          <section className="debug-section">
            <div className="debug-section-title">
              OUTPUT — Time-Aware Model
              <span className="section-hint">drag bars to re-render</span>
            </div>
            {outputSegments.length > 0 && (
              <TokenRow
                segments={outputSegments}
                onDurationChange={handleOutputTokenDurationChange}
              />
            )}
            <div className="mono-preview">
              {responseRaw || <span className="muted">…</span>}
            </div>
            {responseRaw && (
              <button
                className="chip chip--ghost"
                onClick={() => playResponse(responseRaw)}
                disabled={!isIdle}
              >
                Re-render with edited timings
              </button>
            )}
          </section>
        </div>

        {/* ──────────── CONVERSATION PANEL (right) ──────────── */}
        <ConversationPanel
          renderedText={responseRendered}
          plainText={responsePlainRaw}
          cursorState={cursorState}
          status={status}
        />
      </div>

      {/* Bottom toolbar */}
      <footer className="toolbar">
        <div className="toolbar-left">
          <button
            className="primary"
            onClick={handleGenerate}
            disabled={!rawInput || !isIdle}
          >
            Call LLM
          </button>
          <button
            className="secondary"
            onClick={handleCompare}
            disabled={!rawInput || !isIdle}
          >
            Compare Prompts
          </button>
          <button className="secondary" onClick={handleStop} disabled={isIdle}>
            Stop
          </button>
          {error && <span className="error-msg">⚠ {error}</span>}
        </div>

        <div className="toolbar-right">
          <button className="secondary" onClick={saveConfig}>
            Save Config
          </button>
          <ConfigDrawer
            configs={configs}
            onLoad={loadConfig}
            onDelete={deleteConfig}
          />
          <button className="secondary" onClick={handleReset}>
            Reset All
          </button>
        </div>
      </footer>
    </main>
  );
}
