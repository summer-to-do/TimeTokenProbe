"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DT = 120;

// Education scenario: copy-paste leaves a long gap before the pasted block
// (Ref: "Keystroke Dynamics Against Academic Dishonesty in the Age of LLMs", arXiv 2406.15335)
// then the pasted content has ZERO inter-character gaps — no temporal tokens at all.
const EDU_COPY_PASTE_PROMPT =
  "你是一位AI辅导老师。请仔细检查用户输入中的时间令牌。" +
  "真实的回复具有多样的词间间隔（0.1S–3S）。" +
  "复制粘贴的内容在词语之间没有时间令牌——所有字符同时到达。" +
  "如果你注意到一段长时间沉默之后紧跟着一段没有任何间隔的连续文字，学生可能是粘贴而非手动输入的。" +
  "请以同理心回应：先肯定话题的趣味性，然后邀请学生用自己的语言重新表述。" +
  "不要直接指责。在你的回复中使用 [X.XS] 时间令牌来模拟深思熟虑的节奏。";

// Education scenario: Socratic wait-time
// (Ref: Rowe, M. B. "Wait Time: Slowing Down May Be A Way of Speeding Up!", 1986)
// 3-5 second deliberate pauses before hints dramatically increase student engagement.
const EDU_SOCRATIC_PROMPT =
  "你是一位苏格拉底式导师。在给出任何提示或答案之前，先插入一段刻意的 [3.00S]–[4.00S] 停顿，" +
  "为学生留出思考空间，并可能让他们主动打断你。" +
  "这体现了 Rowe 的"候答时间"原则（1986年）：3-5 秒的停顿能显著提升学生的参与度和回答质量。" +
  "先提出一个引导性问题，然后停顿 [3.00S]，再给出一个小提示——永远不要直接给出完整答案。" +
  "在回复中全程使用时间令牌，以表达深思熟虑并邀请学生打断。";

const SCENARIOS = [
  {
    id: "IR",
    label: "信息检索",
    sublabel: "IR",
    temporal: "你能帮我查一下[0.30S]今年诺贝尔[0.20S]物理学奖[0.10S]是谁获得的吗",
  },
  {
    id: "LR",
    label: "学习获取",
    sublabel: "LR",
    temporal: "我不太理解[2.10S]为什么[3.50S]量子纠缠[1.80S]不能用来[2.40S]传递信息",
  },
  {
    id: "PS",
    label: "问题求解",
    sublabel: "PS",
    temporal: "帮我看看[0.80S]这段代码[1.50S]为什么[3.20S]一直报错[0.10S]TypeError",
  },
  {
    id: "CR",
    label: "内容创作",
    sublabel: "CR",
    temporal: "帮我写[0.50S]一段[1.80S]关于[4.20S]可持续发展的[0.30S]演讲开场白",
  },
  {
    id: "ES",
    label: "情感支持",
    sublabel: "ES",
    temporal: "最近[2.80S]工作压力[4.10S]真的[1.50S]有点大[6.00S]不知道该怎么办",
  },
  {
    id: "LS",
    label: "休闲娱乐",
    sublabel: "LS",
    temporal: "你觉得[0.30S]如果猫[0.20S]能说话[0.10S]它们第一句话会说什么",
  },
  // ─── Education scenarios ───────────────────────────────────────────────────
  {
    id: "CPD",
    label: "复制检测",
    sublabel: "Edu·1",
    isEdu: true,
    // Copy-paste signature: natural typing with gaps → long silence [11.88S] → pasted block with ZERO inter-word gaps
    temporal:
      "[2.64S]我觉得[0.48S]，[2.16S]这可能[0.48S]是[0.48S]一个[1.80S]答案[0.60S]？[11.88S]熵增原理是指在封闭系统中总熵只增不减热力学第二定律",
    promptA: EDU_COPY_PASTE_PROMPT,
  },
  {
    id: "SOC",
    label: "苏格拉底",
    sublabel: "Edu·2",
    isEdu: true,
    temporal: "老师我不太懂[2.50S]这道题应该[3.80S]怎么解",
    promptA: EDU_SOCRATIC_PROMPT,
  },
];

// ─── System Prompt Builders ───────────────────────────────────────────────────

function buildPromptA(dtMs) {
  const sec = (Number(dtMs) / 1000).toFixed(2);
  return [
    "你是一个使用时间令牌来表达刻意停顿的对话模型。",
    "时间令牌形如 [0.53S]，表示停顿的秒数。",
    `优先使用 ${sec}S 的倍数作为停顿。`,
    "仔细阅读用户输入中的时间令牌，感知其打字节奏和情绪状态。",
    "在你自己的回复中加入时间令牌，以表达刻意停顿和语气重点。",
    "将令牌嵌入文本中；不要解释它们。",
    "以自然、简洁的语气回复。",
  ].join(" ");
}

function buildPromptB() {
  return [
    "你是一个对话模型。用户的输入可能包含形如 [0.53S] 的时间令牌，代表词语之间的停顿。",
    "仔细阅读这些令牌，理解用户的打字节奏、犹豫和情绪状态。",
    "利用这种时间感知来调整你的同理心和回复风格。",
    "不要在输出中包含任何时间令牌——只用纯自然文字回复。",
    "以自然、简洁的语气回复。",
  ].join(" ");
}

function buildPromptC() {
  return "你是一个对话模型。以自然、简洁的语气回复。";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  if (next.length && next[next.length - 1].type === "token") next = next.slice(0, -1);
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
    segs.push({ type: "token", value: `[${parseFloat(match[1]).toFixed(2)}S]` });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < str.length)
    segs.push({ type: "text", value: str.slice(lastIndex) });
  return segs;
}

function rawFromSegments(segs) {
  return segs.filter((s) => s.type === "text").map((s) => s.value).join("");
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

// ─── useTemporalInput ─────────────────────────────────────────────────────────

function useTemporalInput(dtMs, quantize) {
  const [rawInput, setRawInput] = useState("");
  const [temporalInput, setTemporalInput] = useState("");
  const [segmentVersion, setSegmentVersion] = useState(0);
  const segmentsRef = useRef([]);
  const lastEditAtRef = useRef(null);
  const lastRawRef = useRef("");
  const composingRef = useRef(false);
  const compositionBaseRef = useRef("");
  const lastCompositionValueRef = useRef(null);

  const bumpSegments = useCallback(() => setSegmentVersion((v) => v + 1), []);

  const resetTemporal = useCallback(() => {
    const raw = lastRawRef.current;
    const segs = raw ? [{ type: "text", value: raw }] : [];
    segmentsRef.current = segs;
    setTemporalInput(segmentsToString(segs));
    lastEditAtRef.current = null;
    bumpSegments();
  }, [bumpSegments]);

  const clearInput = useCallback(() => {
    segmentsRef.current = [];
    setRawInput("");
    setTemporalInput("");
    lastEditAtRef.current = null;
    lastRawRef.current = "";
    bumpSegments();
  }, [bumpSegments]);

  const applyInputChange = useCallback(
    (value, prevRawOverride) => {
      const now = performance.now();
      const prevRaw = prevRawOverride ?? lastRawRef.current;
      const gap = lastEditAtRef.current === null ? 0 : now - lastEditAtRef.current;
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
    },
    [dtMs, quantize, bumpSegments]
  );

  const handleChange = useCallback(
    (e) => {
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
    },
    [applyInputChange]
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    compositionBaseRef.current = lastRawRef.current;
  }, []);

  const handleCompositionEnd = useCallback(
    (e) => {
      composingRef.current = false;
      applyInputChange(e.target.value, compositionBaseRef.current);
      lastCompositionValueRef.current = e.target.value;
      compositionBaseRef.current = "";
    },
    [applyInputChange]
  );

  const handleTokenDurationChange = useCallback(
    (index, newDur) => {
      const segs = segmentsRef.current.map((seg, i) => {
        if (i !== index || seg.type !== "token") return seg;
        return { type: "token", value: `[${newDur.toFixed(2)}S]` };
      });
      segmentsRef.current = segs;
      setTemporalInput(segmentsToString(segs));
      bumpSegments();
    },
    [bumpSegments]
  );

  const loadTemporal = useCallback(
    (temporalStr) => {
      const segs = parseTemporalString(temporalStr);
      const raw = rawFromSegments(segs);
      segmentsRef.current = segs;
      setRawInput(raw);
      setTemporalInput(segmentsToString(segs));
      lastRawRef.current = raw;
      lastEditAtRef.current = null;
      bumpSegments();
    },
    [bumpSegments]
  );

  const loadFromSegments = useCallback(
    (segments, raw) => {
      segmentsRef.current = segments;
      setRawInput(raw || "");
      setTemporalInput(segmentsToString(segments));
      lastRawRef.current = raw || "";
      lastEditAtRef.current = null;
      bumpSegments();
    },
    [bumpSegments]
  );

  return {
    rawInput,
    temporalInput,
    segmentsRef,
    segmentVersion,
    handleChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleTokenDurationChange,
    resetTemporal,
    clearInput,
    loadTemporal,
    loadFromSegments,
  };
}

// ─── usePlayback ─────────────────────────────────────────────────────────────
// Independent playback engine for each mode section (and input replay).

function usePlayback() {
  const [rendered, setRendered] = useState("");
  const [cursorState, setCursorState] = useState("idle");
  const [pauseDuration, setPauseDuration] = useState(null);
  const timersRef = useRef([]);
  const cancelRef = useRef(null);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  const play = useCallback(async (text) => {
    if (!text) return;
    if (cancelRef.current) cancelRef.current();
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    setRendered("");
    setCursorState("typing");
    setPauseDuration(null);

    const segs = splitTemporal(text);
    let cancelled = false;
    let accumulated = "";

    cancelRef.current = () => {
      cancelled = true;
      setCursorState("idle");
      setPauseDuration(null);
    };

    for (const seg of segs) {
      if (cancelled) return;
      if (seg.type === "pause") {
        const delay = Math.min(seg.value * 1000, 6000);
        if (delay > 50) {
          setPauseDuration(seg.value);
          setCursorState("pause");
          await sleep(delay, timersRef);
          if (cancelled) return;
          setPauseDuration(null);
          setCursorState("typing");
        }
      } else {
        accumulated += seg.value;
        setRendered(accumulated);
      }
    }

    setCursorState("idle");
    setPauseDuration(null);
    cancelRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (cancelRef.current) cancelRef.current();
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setCursorState("idle");
    setPauseDuration(null);
    cancelRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    setRendered("");
  }, [stop]);

  return { rendered, cursorState, pauseDuration, isActive: cursorState !== "idle", play, stop, reset };
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
      style={{ width, background: barColor, borderRight: `3px solid ${borderColor}` }}
      title={`${duration.toFixed(2)}s — 拖拽右边缘调整`}
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
            <TimeBar key={i} duration={dur} index={i} onDurationChange={onDurationChange} />
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

// ─── AICursor ─────────────────────────────────────────────────────────────────

function AICursor({ state }) {
  if (state === "idle") return null;
  return (
    <span
      className={state === "pause" ? "ai-cursor ai-cursor--breathe" : "ai-cursor ai-cursor--blink"}
      aria-hidden="true"
    />
  );
}

// ─── Temporal Presence Indicator ──────────────────────────────────────────────
// Design reference: "Social Presence" theory (Short, Williams & Christie, 1976)
// and "Workspace Awareness" (Gutwin & Greenberg, 2002) adapted for AI temporal states.
// Visually inspired by collaborative tool presence cursors (Notion, Figma, Feishu).

function TemporalPresenceIndicator({ cursorState, pauseDuration }) {
  if (cursorState === "idle") return null;

  if (cursorState === "typing") {
    return (
      <div className="tpi tpi--typing" aria-live="polite" aria-label="AI 正在回应">
        <span className="tpi-dots">
          <span className="tpi-dot" />
          <span className="tpi-dot" />
          <span className="tpi-dot" />
        </span>
        <span className="tpi-label">AI · 正在回应</span>
      </div>
    );
  }

  // pause state
  const hue = pauseDuration ? durationToHue(pauseDuration) : 200;
  const color = `hsl(${hue}, 80%, 62%)`;
  const glow = `hsl(${hue}, 70%, 30%)`;
  return (
    <div
      className="tpi tpi--pause"
      style={{ borderColor: `hsl(${hue}, 60%, 40%)`, boxShadow: `0 0 14px ${glow}` }}
      aria-live="polite"
      aria-label="AI 刻意停顿"
    >
      <span
        className="tpi-beacon"
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      <span className="tpi-label" style={{ color }}>
        AI · 刻意停顿
        {pauseDuration ? ` · ${pauseDuration.toFixed(1)}s` : ""}
      </span>
    </div>
  );
}

// ─── ModeRenderArea ───────────────────────────────────────────────────────────
// Inline rendering display for each mode section.
// For Mode A: shows rendered text + AICursor + collapsible raw temporal string.
// For Mode B/C: shows typed-out plain text + AICursor.

function ModeRenderArea({ rawOutput, playback, showRaw }) {
  const { rendered, cursorState, pauseDuration, isActive } = playback;

  // Display text: rendered while playing; stripped output when idle
  const displayText =
    rendered ||
    (isActive ? "" : rawOutput?.replace(/\[\d+(?:\.\d+)?S\]/gi, " ") || "");

  return (
    <div className={`mode-render-area${isActive ? " mode-render-area--active" : ""}`}>
      {/* Mini status badge */}
      {isActive && (
        <div
          className={`mode-render-status mode-render-status--${cursorState}`}
          style={
            cursorState === "pause" && pauseDuration
              ? {
                  borderColor: `hsl(${durationToHue(pauseDuration)}, 60%, 40%)`,
                  color: `hsl(${durationToHue(pauseDuration)}, 80%, 65%)`,
                }
              : {}
          }
        >
          {cursorState === "pause"
            ? `⏸ ${pauseDuration?.toFixed(1) ?? ""}s`
            : "▶ 渲染中"}
        </div>
      )}

      {/* Rendered / display text */}
      <div className="mode-render-text">
        {displayText || (!rawOutput && <span className="muted">…</span>)}
        {isActive && <AICursor state={cursorState} />}
      </div>

      {/* Raw temporal string — shown for Mode A when output contains time tokens */}
      {showRaw && rawOutput && (
        <div className="mode-render-raw">{rawOutput}</div>
      )}
    </div>
  );
}

// ─── ModePromptEditor ─────────────────────────────────────────────────────────

function ModePromptEditor({ prompt, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mode-prompt-wrap">
      <button className="mode-prompt-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="sysprompt-caret">{open ? "▲" : "▼"}</span>
        <span>提示词</span>
        {!open && <span className="sysprompt-preview">{prompt.slice(0, 55)}…</span>}
      </button>
      {open && (
        <textarea
          className="sysprompt-textarea"
          value={prompt}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          spellCheck={false}
        />
      )}
    </div>
  );
}

// ─── ConversationPanel ────────────────────────────────────────────────────────

function ConversationPanel({
  history,
  cursorState,
  renderingId,
  currentPauseDuration,
  status,
  onReplay,
  onSend,
  dtMs,
  quantize,
}) {
  const endRef = useRef(null);
  const convInput = useTemporalInput(dtMs, quantize);
  void convInput.segmentVersion;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, cursorState]);

  const isEmpty = history.length === 0 && cursorState === "idle";

  const handleSend = () => {
    if (!convInput.rawInput.trim()) return;
    onSend(convInput.rawInput, convInput.temporalInput);
    convInput.clearInput();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="conv-panel">
      <div className="conv-header">
        <span className="panel-badge badge-blue">对话面板</span>
        <span className="conv-status-pill">{status}</span>
      </div>

      {/* Temporal Presence Indicator — floats below header */}
      <div className="tpi-slot">
        <TemporalPresenceIndicator
          cursorState={cursorState}
          pauseDuration={currentPauseDuration}
        />
      </div>

      {/* Scrollable message body */}
      <div className="conv-body">
        {isEmpty && (
          <div className="conv-empty">
            <div className="conv-empty-icon">⏱</div>
            <div>在下方输入，或从调试面板（模式 A）生成。</div>
            <div className="conv-empty-sub">
              时间编码对话 · 时序渲染 · 打断重播
            </div>
          </div>
        )}

        {history.map((turn) => (
          <div key={turn.id} className="conv-turn">
            {/* User bubble */}
            <div className="bubble-row bubble-row--right">
              <div className="bubble bubble--user">
                <div className="bubble-label">
                  你
                  <span className="bubble-time">
                    {new Date(turn.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="bubble-text">{turn.userRaw}</div>
                {turn.userTemporal !== turn.userRaw && (
                  <div className="bubble-temporal-hint">{turn.userTemporal}</div>
                )}
              </div>
            </div>

            {/* AI bubble */}
            <div className="bubble-row bubble-row--left">
              <div className="bubble bubble--temporal">
                <div className="bubble-label">
                  时间感知 AI
                  {renderingId === turn.id && cursorState === "pause" && (
                    <span className="pause-indicator"> · 暂停中</span>
                  )}
                </div>
                <div className="bubble-text">
                  {turn.responseRendered ||
                    (renderingId === turn.id
                      ? ""
                      : turn.responseRaw?.replace(/\[\d+(?:\.\d+)?S\]/gi, " ") || "")}
                  {renderingId === turn.id && <AICursor state={cursorState} />}
                </div>
                {/* Replay button — below each AI response, not centered */}
                {turn.responseRaw && (
                  <div className="bubble-actions">
                    <button
                      className="replay-btn"
                      onClick={() => onReplay(turn)}
                      disabled={renderingId !== null}
                      title="重播时序渲染"
                    >
                      ⟳ 重播
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        <div ref={endRef} />
      </div>

      {/* Conversation input area */}
      <div className="conv-input-area">
        {convInput.segmentsRef.current.length > 0 && (
          <div className="conv-token-row">
            <TokenRow
              segments={convInput.segmentsRef.current}
              onDurationChange={convInput.handleTokenDurationChange}
            />
          </div>
        )}
        <div className="conv-input-row">
          <textarea
            className="conv-textarea"
            placeholder="继续对话…（Ctrl+Enter 发送）"
            value={convInput.rawInput}
            onChange={convInput.handleChange}
            onCompositionStart={convInput.handleCompositionStart}
            onCompositionEnd={convInput.handleCompositionEnd}
            onKeyDown={handleKeyDown}
            rows={2}
          />
          <button
            className="primary conv-send-btn"
            onClick={handleSend}
            disabled={!convInput.rawInput.trim() || cursorState !== "idle"}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ConfigDrawer ─────────────────────────────────────────────────────────────

function ConfigDrawer({ configs, onLoad, onDelete }) {
  const [open, setOpen] = useState(false);
  if (configs.length === 0) return null;
  return (
    <div className="config-drawer-wrap">
      <button className="secondary" onClick={() => setOpen((o) => !o)}>
        已保存 ({configs.length}) {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="config-drawer">
          {configs.map((cfg, i) => (
            <div key={i} className="config-item">
              <button
                className="config-item-btn"
                onClick={() => {
                  onLoad(cfg);
                  setOpen(false);
                }}
              >
                <span className="config-item-time">
                  {new Date(cfg.timestamp).toLocaleString()}
                </span>
                <span className="config-item-preview">
                  {cfg.rawInput?.slice(0, 48) || "（空输入）"}
                </span>
              </button>
              <button className="config-item-del" onClick={() => onDelete(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Page() {
  const [dtMs, setDtMs] = useState(DEFAULT_DT);
  const [quantize, setQuantize] = useState(true);

  // Debug panel input
  const debugInput = useTemporalInput(dtMs, quantize);
  void debugInput.segmentVersion;

  // Three independent prompts
  const [promptA, setPromptA] = useState(() => buildPromptA(DEFAULT_DT));
  const [promptB, setPromptB] = useState(() => buildPromptB());
  const [promptC, setPromptC] = useState(() => buildPromptC());

  // Three independent raw outputs (debug panel)
  const [outputA, setOutputA] = useState("");
  const [outputB, setOutputB] = useState("");
  const [outputC, setOutputC] = useState("");

  // Per-mode independent playback engines (debug panel)
  const playbackA = usePlayback();
  const playbackB = usePlayback();
  const playbackC = usePlayback();
  // Input replay — plays back the user's own temporal input timing
  const playbackInput = usePlayback();

  // Conversation history
  const [convHistory, setConvHistory] = useState([]);

  // Rendering state
  const [cursorState, setCursorState] = useState("idle");
  const [renderingId, setRenderingId] = useState(null);
  const [currentPauseDuration, setCurrentPauseDuration] = useState(null);
  const [status, setStatus] = useState("空闲");
  const [error, setError] = useState("");

  // Saved configs
  const [configs, setConfigs] = useState([]);

  const timersRef = useRef([]);
  const cancelRef = useRef(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("timetoken-configs");
      if (saved) setConfigs(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
    };
  }, []);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const isIdle = status === "空闲";

  // ─── Playback ───────────────────────────────────────────────────────────────

  const playResponse = async (text, turnId) => {
    if (cancelRef.current) cancelRef.current();
    clearTimers();
    setStatus("渲染中");
    setCursorState("typing");
    setRenderingId(turnId);
    setCurrentPauseDuration(null);

    // Reset rendered text for this turn
    setConvHistory((h) =>
      h.map((t) => (t.id === turnId ? { ...t, responseRendered: "" } : t))
    );

    const segs = splitTemporal(text);
    let cancelled = false;
    let accumulated = "";

    cancelRef.current = () => {
      cancelled = true;
      setCursorState("idle");
      setStatus("空闲");
      setRenderingId(null);
      setCurrentPauseDuration(null);
    };

    for (const seg of segs) {
      if (cancelled) return;
      if (seg.type === "pause") {
        const delay = Math.min(seg.value * 1000, 6000);
        if (delay > 50) {
          setCurrentPauseDuration(seg.value);
          setCursorState("pause");
          await sleep(delay, timersRef);
          if (cancelled) return;
          setCurrentPauseDuration(null);
          setCursorState("typing");
        }
      } else {
        accumulated += seg.value;
        const snap = accumulated;
        setConvHistory((h) =>
          h.map((t) => (t.id === turnId ? { ...t, responseRendered: snap } : t))
        );
      }
    }

    setConvHistory((h) =>
      h.map((t) => (t.id === turnId ? { ...t, rendered: true } : t))
    );
    setCursorState("idle");
    setStatus("空闲");
    setRenderingId(null);
    setCurrentPauseDuration(null);
  };

  // ─── API ────────────────────────────────────────────────────────────────────

  const callApi = async (message, customPrompt) => {
    const payload = { message, dtMs, systemPrompt: customPrompt };
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Request failed");
    return data.text || "";
  };

  const callApiMultiTurn = async (messages, systemPrompt) => {
    const payload = { messages, dtMs, systemPrompt };
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Request failed");
    return data.text || "";
  };

  // ─── Generate handlers ───────────────────────────────────────────────────────

  const addTurnAndPlay = async (rawMsg, temporalMsg, responseText) => {
    const turnId = Date.now();
    const newTurn = {
      id: turnId,
      userRaw: rawMsg,
      userTemporal: temporalMsg || rawMsg,
      responseRaw: responseText,
      responseRendered: "",
      rendered: false,
      timestamp: new Date().toISOString(),
    };
    setConvHistory((h) => [...h, newTurn]);
    await playResponse(responseText, turnId);
  };

  const handleGenerateA = async () => {
    if (!debugInput.rawInput) return;
    setError("");
    setStatus("调用 LLM (A)…");
    setOutputA("");
    clearTimers();
    try {
      const msg = debugInput.temporalInput || debugInput.rawInput;
      const text = await callApi(msg, promptA);
      setOutputA(text);
      // Play in debug panel (non-blocking) and conversation panel (blocking) concurrently
      playbackA.play(text);
      await addTurnAndPlay(debugInput.rawInput, debugInput.temporalInput, text);
    } catch (err) {
      setError(err.message || "发生意外错误");
      setStatus("空闲");
      setCursorState("idle");
    }
  };

  const handleGenerateB = async () => {
    if (!debugInput.rawInput) return;
    setError("");
    setStatus("调用 LLM (B)…");
    setOutputB("");
    clearTimers();
    try {
      const msg = debugInput.temporalInput || debugInput.rawInput;
      const text = await callApi(msg, promptB);
      setOutputB(text);
      playbackB.play(text);
      setStatus("空闲");
    } catch (err) {
      setError(err.message || "发生意外错误");
      setStatus("空闲");
    }
  };

  const handleGenerateC = async () => {
    if (!debugInput.rawInput) return;
    setError("");
    setStatus("调用 LLM (C)…");
    setOutputC("");
    clearTimers();
    try {
      const text = await callApi(debugInput.rawInput, promptC);
      setOutputC(text);
      playbackC.play(text);
      setStatus("空闲");
    } catch (err) {
      setError(err.message || "发生意外错误");
      setStatus("空闲");
    }
  };

  // ─── Conversation continue ───────────────────────────────────────────────────

  const handleConvSend = async (rawMsg, temporalMsg) => {
    setError("");
    setStatus("调用 LLM…");
    clearTimers();
    try {
      const messages = [
        ...convHistory.flatMap((t) => [
          { role: "user", content: t.userTemporal },
          { role: "assistant", content: t.responseRaw },
        ]),
        { role: "user", content: temporalMsg || rawMsg },
      ];
      const text = await callApiMultiTurn(messages, promptA);
      await addTurnAndPlay(rawMsg, temporalMsg, text);
    } catch (err) {
      setError(err.message || "发生意外错误");
      setStatus("空闲");
      setCursorState("idle");
    }
  };

  // ─── Replay ─────────────────────────────────────────────────────────────────

  const handleReplay = async (turn) => {
    await playResponse(turn.responseRaw, turn.id);
  };

  // ─── Output token editing (mode A only) ─────────────────────────────────────

  const handleOutputATokenChange = (index, newDur) => {
    const segs = splitTemporal(outputA).map((seg, i) => {
      if (i !== index || seg.type !== "pause") return seg;
      return { ...seg, value: newDur };
    });
    setOutputA(
      segs
        .map((s) => (s.type === "pause" ? `[${s.value.toFixed(2)}S]` : s.value))
        .join("")
    );
  };

  // ─── Scenario loading ────────────────────────────────────────────────────────

  const loadScenario = (scenario) => {
    debugInput.loadTemporal(scenario.temporal);
    setOutputA("");
    setOutputB("");
    setOutputC("");
    setCursorState("idle");
    playbackA.reset();
    playbackB.reset();
    playbackC.reset();
    playbackInput.reset();
    if (scenario.promptA) setPromptA(scenario.promptA);
  };

  // ─── Config ─────────────────────────────────────────────────────────────────

  const saveConfig = (modeLabel, savedOutput) => {
    const cfg = {
      dtMs,
      quantize,
      promptA,
      promptB,
      promptC,
      rawInput: debugInput.rawInput,
      temporalInput: debugInput.temporalInput,
      segments: debugInput.segmentsRef.current,
      savedMode: modeLabel,
      savedOutput,
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
    if (cfg.promptA) setPromptA(cfg.promptA);
    if (cfg.promptB) setPromptB(cfg.promptB);
    if (cfg.promptC) setPromptC(cfg.promptC);
    if (cfg.segments) {
      debugInput.loadFromSegments(cfg.segments, cfg.rawInput || "");
    }
  };

  const deleteConfig = (i) => {
    const next = configs.filter((_, idx) => idx !== i);
    setConfigs(next);
    try {
      localStorage.setItem("timetoken-configs", JSON.stringify(next));
    } catch {}
  };

  const handleStop = () => {
    if (cancelRef.current) cancelRef.current();
    clearTimers();
    setCursorState("idle");
    setStatus("空闲");
    setRenderingId(null);
    setCurrentPauseDuration(null);
    playbackA.stop();
    playbackB.stop();
    playbackC.stop();
    playbackInput.stop();
  };

  const handleReset = () => {
    handleStop();
    debugInput.clearInput();
    setOutputA("");
    setOutputB("");
    setOutputC("");
    playbackA.reset();
    playbackB.reset();
    playbackC.reset();
    playbackInput.reset();
    setConvHistory([]);
    setError("");
    setPromptA(buildPromptA(dtMs));
    setPromptB(buildPromptB());
    setPromptC(buildPromptC());
  };

  // ─── Export session ──────────────────────────────────────────────────────────

  const exportSession = () => {
    const sessionData = {
      exportedAt: new Date().toISOString(),
      config: { dtMs, quantize },
      trial: {
        input: {
          raw: debugInput.rawInput,
          temporal: debugInput.temporalInput,
          segments: debugInput.segmentsRef.current,
        },
        outputs: {
          A: { prompt: promptA, raw: outputA },
          B: { prompt: promptB, raw: outputB },
          C: { prompt: promptC, raw: outputC },
        },
      },
      conversation: convHistory.map((t, i) => ({
        turn: i + 1,
        userRaw: t.userRaw,
        userTemporal: t.userTemporal,
        responseRaw: t.responseRaw,
        timestamp: t.timestamp,
      })),
    };

    const blob = new Blob([JSON.stringify(sessionData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timetoken-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ─── Derived ─────────────────────────────────────────────────────────────────

  const tokenPreview = useMemo(() => formatGap(dtMs, dtMs, true), [dtMs]);
  const outputASegs = useMemo(() => splitTemporal(outputA), [outputA]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <main className="page">
      <header className="hero">
        <h1>
          TimeToken<span className="hero-accent">Probe</span>
        </h1>
        <p>
          探索人机对话中的时间性交互。打字节奏成为令牌，令牌化为停顿。
        </p>
      </header>

      <div className="dual-panel">
        {/* ──────────────── DEBUG PANEL ──────────────── */}
        <div className="debug-panel">
          <div className="panel-header">
            <span className="panel-badge badge-orange">调试面板</span>
            <span className="panel-subtitle">令牌级别 · 3 种独立模式</span>
          </div>

          {/* Scenario chips */}
          <div className="scenario-bar">
            <span className="scenario-label">场景：</span>
            <div className="scenario-chips">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  className={`chip${s.isEdu ? " chip--edu" : ""}`}
                  onClick={() => loadScenario(s)}
                  title={s.temporal}
                >
                  {s.label}
                  <span className="chip-sub">{s.sublabel}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── INPUT ── */}
          <section className="debug-section">
            <div className="debug-section-title">
              输入 — 词间时间条
              <span className="section-hint">拖拽条边缘以调整</span>
            </div>

            {debugInput.segmentsRef.current.length > 0 && (
              <TokenRow
                segments={debugInput.segmentsRef.current}
                onDurationChange={debugInput.handleTokenDurationChange}
              />
            )}

            <textarea
              className="debug-textarea"
              placeholder="自然打字——按键间隔成为时间令牌。"
              value={debugInput.rawInput}
              onChange={debugInput.handleChange}
              onCompositionStart={debugInput.handleCompositionStart}
              onCompositionEnd={debugInput.handleCompositionEnd}
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
                量化
              </label>
              <button className="chip chip--ghost" onClick={debugInput.resetTemporal}>
                重置时序
              </button>
            </div>

            {/* Input temporal string (raw) */}
            <div className="mono-preview">
              {debugInput.temporalInput || <span className="muted">…</span>}
            </div>

            {/* Input replay: plays back the user's own timing */}
            {debugInput.temporalInput && (
              <div className="input-replay-wrap">
                <div className="input-replay-actions">
                  <button
                    className="chip chip--ghost chip--play"
                    onClick={() => playbackInput.play(debugInput.temporalInput)}
                    disabled={playbackInput.isActive}
                    title="重播你的输入时序"
                  >
                    ▶ 回放输入时序
                  </button>
                  {playbackInput.isActive && (
                    <button className="chip chip--ghost" onClick={playbackInput.stop}>
                      ■ 停止
                    </button>
                  )}
                </div>
                {playbackInput.isActive && (
                  <div className="input-replay-display">
                    <span className="input-replay-label">↳ 回放中</span>
                    <span className="input-replay-text">
                      {playbackInput.rendered}
                      <AICursor state={playbackInput.cursorState} />
                    </span>
                    {playbackInput.cursorState === "pause" && playbackInput.pauseDuration && (
                      <span
                        className="input-replay-pause"
                        style={{
                          color: `hsl(${durationToHue(playbackInput.pauseDuration)}, 80%, 65%)`,
                        }}
                      >
                        ⏸ {playbackInput.pauseDuration.toFixed(1)}s
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ── MODE A: Input+time → Output+time ── */}
          <section className="debug-section mode-section mode-section--orange">
            <div className="debug-section-title">
              <span className="mode-badge mode-badge--orange">A</span>
              输入+时间 → 输出+时间
              <span className="section-hint">模型感知并表达时间</span>
            </div>
            <ModePromptEditor prompt={promptA} onChange={setPromptA} />
            {outputASegs.length > 0 && (
              <TokenRow segments={outputASegs} onDurationChange={handleOutputATokenChange} />
            )}
            {/* Rendered output with temporal playback */}
            <ModeRenderArea rawOutput={outputA} playback={playbackA} showRaw />
            <div className="mode-actions">
              <button
                className="primary"
                onClick={handleGenerateA}
                disabled={!debugInput.rawInput || !isIdle}
              >
                生成 A
              </button>
              {outputA && !playbackA.isActive && (
                <button
                  className="chip chip--ghost chip--play"
                  onClick={() => playbackA.play(outputA)}
                  title="重播时序渲染"
                >
                  ⟳ 重播
                </button>
              )}
              {playbackA.isActive && (
                <button className="chip chip--ghost" onClick={playbackA.stop}>
                  ■ 停止
                </button>
              )}
              {outputA && (
                <button
                  className="chip chip--ghost"
                  onClick={() => saveConfig("A", outputA)}
                >
                  ↓ 保存
                </button>
              )}
            </div>
          </section>

          {/* ── MODE B: Input+time → Output plain ── */}
          <section className="debug-section mode-section mode-section--blue">
            <div className="debug-section-title">
              <span className="mode-badge mode-badge--blue">B</span>
              输入+时间 → 纯文本输出
              <span className="section-hint">模型感知，但不表达</span>
            </div>
            <ModePromptEditor prompt={promptB} onChange={setPromptB} />
            <ModeRenderArea rawOutput={outputB} playback={playbackB} showRaw={false} />
            <div className="mode-actions">
              <button
                className="secondary"
                onClick={handleGenerateB}
                disabled={!debugInput.rawInput || !isIdle}
              >
                生成 B
              </button>
              {outputB && !playbackB.isActive && (
                <button
                  className="chip chip--ghost chip--play"
                  onClick={() => playbackB.play(outputB)}
                >
                  ⟳ 重播
                </button>
              )}
              {playbackB.isActive && (
                <button className="chip chip--ghost" onClick={playbackB.stop}>
                  ■ 停止
                </button>
              )}
              {outputB && (
                <button
                  className="chip chip--ghost"
                  onClick={() => saveConfig("B", outputB)}
                >
                  ↓ 保存
                </button>
              )}
            </div>
          </section>

          {/* ── MODE C: Input plain → Output plain (baseline) ── */}
          <section className="debug-section mode-section mode-section--gray">
            <div className="debug-section-title">
              <span className="mode-badge mode-badge--gray">C</span>
              纯文本输入 → 纯文本输出
              <span className="section-hint">基线 · 无时间感知</span>
            </div>
            <ModePromptEditor prompt={promptC} onChange={setPromptC} />
            <ModeRenderArea rawOutput={outputC} playback={playbackC} showRaw={false} />
            <div className="mode-actions">
              <button
                className="secondary"
                onClick={handleGenerateC}
                disabled={!debugInput.rawInput || !isIdle}
              >
                生成 C
              </button>
              {outputC && !playbackC.isActive && (
                <button
                  className="chip chip--ghost chip--play"
                  onClick={() => playbackC.play(outputC)}
                >
                  ⟳ 重播
                </button>
              )}
              {playbackC.isActive && (
                <button className="chip chip--ghost" onClick={playbackC.stop}>
                  ■ 停止
                </button>
              )}
              {outputC && (
                <button
                  className="chip chip--ghost"
                  onClick={() => saveConfig("C", outputC)}
                >
                  ↓ 保存
                </button>
              )}
            </div>
          </section>
        </div>

        {/* ──────────────── CONVERSATION PANEL ──────────────── */}
        <ConversationPanel
          history={convHistory}
          cursorState={cursorState}
          renderingId={renderingId}
          currentPauseDuration={currentPauseDuration}
          status={status}
          onReplay={handleReplay}
          onSend={handleConvSend}
          dtMs={dtMs}
          quantize={quantize}
        />
      </div>

      {/* Toolbar */}
      <footer className="toolbar">
        <div className="toolbar-left">
          <button className="secondary" onClick={handleStop} disabled={isIdle}>
            停止
          </button>
          {error && <span className="error-msg">⚠ {error}</span>}
        </div>
        <div className="toolbar-right">
          <ConfigDrawer configs={configs} onLoad={loadConfig} onDelete={deleteConfig} />
          <button
            className="secondary"
            onClick={exportSession}
            disabled={!debugInput.rawInput && convHistory.length === 0}
            title="将当前会话导出为 JSON 以供分析"
          >
            ↓ 导出 JSON
          </button>
          <button className="secondary" onClick={handleReset}>
            重置全部
          </button>
        </div>
      </footer>
    </main>
  );
}
