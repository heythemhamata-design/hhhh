"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

type AgentOption = {
  id: string;
  name?: string;
  role?: string;
  enabled?: boolean | null;
};

type TaskRow = {
  id: string;
  agent_id: string;
  task_type?: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  error?: string | null;
  result?: unknown;
  metadata?: Record<string, unknown>;
  created_at: string;
  completed_at?: string | null;
};

type TaskDetail = TaskRow & {
  input?: string;
  events?: Array<{
    id: string;
    event_type: string;
    severity: string;
    success: boolean | null;
    created_at: string;
    details?: Record<string, unknown>;
  }>;
};

type OrchestrationView = {
  executionStatus: string;
  plan: {
    id: string;
    summary: string;
    taskCount: number;
    finalizerStatus?: string | null;
    finalReport?: string | null;
    finalReportTruncated?: boolean;
    finalizationError?: string | null;
  };
  tasks: TaskRow[];
  dependencies: Array<{
    task_id: string;
    depends_on_task_id: string;
  }>;
};

function resultText(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return resultText(parsed);
      }
    } catch {
      return value;
    }
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (typeof record.content === "string") {
      return record.content;
    }

    if (record.result !== undefined) {
      return resultText(record.result);
    }

    return JSON.stringify(value, null, 2);
  }

  return "";
}

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "#34d399";
    case "running": return "#60a5fa";
    case "queued": return "#fbbf24";
    case "blocked": return "#a78bfa";
    case "failed": return "#fb7185";
    case "cancelled": return "#94a3b8";
    default: return "#cbd5e1";
  }
}

function shortDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString();
}

export default function TaskConsole() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("strategist");
  const [prompt, setPrompt] = useState("");
  const [enableTools, setEnableTools] = useState(false);
  const [executionMode, setExecutionMode] = useState<"agent" | "orchestrated">("agent");

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [planDetail, setPlanDetail] = useState<OrchestrationView | null>(null);
  const detailRequestRef = useRef(0);

  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const refreshAgents = useCallback(async () => {
    const response = await fetch("/api/agents", {
      credentials: "same-origin",
      cache: "no-store",
    });

    const data = await response.json();

    if (!response.ok || !Array.isArray(data.agents)) {
      throw new Error(data.error || "Unable to load agents.");
    }

    const available = (data.agents as AgentOption[])
      .filter((agent) => agent.enabled === true);

    setAgents(available);

    setAgentId((current) => {
      if (available.some((agent) => agent.id === current)) return current;
      if (available.some((agent) => agent.id === "strategist")) return "strategist";
      return available[0]?.id || "";
    });
  }, []);

  const refreshTasks = useCallback(async () => {
    const response = await fetch("/api/tasks?limit=30", {
      credentials: "same-origin",
      cache: "no-store",
    });

    const data = await response.json();

    if (!response.ok || !Array.isArray(data.tasks)) {
      throw new Error(data.error || "Unable to load task queue.");
    }

    const nextTasks = data.tasks as TaskRow[];
    setTasks(nextTasks);

    setSelectedId((current) => {
      if (current && nextTasks.some((task) => task.id === current)) return current;
      return nextTasks[0]?.id || null;
    });
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    const requestId = ++detailRequestRef.current;

    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });

    const data = await response.json();
    if (requestId !== detailRequestRef.current) return;

    if (!response.ok || !data.task) {
      throw new Error(data.error || "Unable to load task details.");
    }

    const nextDetail = data.task as TaskDetail;

    if (nextDetail.task_type === "orchestration_plan") {
      const planResponse = await fetch(
        `/api/orchestrator/${encodeURIComponent(id)}`,
        {
          credentials: "same-origin",
          cache: "no-store",
        },
      );

      const planData = await planResponse.json();
      if (requestId !== detailRequestRef.current) return;

      if (!planResponse.ok || !planData.plan) {
        throw new Error(planData.error || "Unable to load orchestration plan.");
      }

      setDetail(nextDetail);
      setPlanDetail(planData as OrchestrationView);
    } else {
      setDetail(nextDetail);
      setPlanDetail(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;

    async function initialLoad() {
      setLoading(true);
      try {
        await Promise.all([refreshAgents(), refreshTasks()]);
      } catch (loadError) {
        if (alive) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Initial load failed.",
          );
        }
      } finally {
        if (alive) setLoading(false);
      }
    }

    void initialLoad();

    return () => {
      alive = false;
    };
  }, [refreshAgents, refreshTasks]);

  useEffect(() => {
    if (!selectedId) {
      detailRequestRef.current += 1;
      setDetail(null);
      setPlanDetail(null);
      return;
    }

    let alive = true;
    detailRequestRef.current += 1;
    setDetail(null);
    setPlanDetail(null);

    refreshDetail(selectedId).catch((loadError) => {
      if (alive) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load task.",
        );
      }
    });

    return () => {
      alive = false;
      detailRequestRef.current += 1;
    };
  }, [selectedId, refreshDetail]);

  const hasActiveTasks = useMemo(
    () => tasks.some((task) =>
      ["queued", "blocked", "running"].includes(task.status),
    ),
    [tasks],
  );

  useEffect(() => {
    if (!hasActiveTasks) return;

    const timer = window.setInterval(() => {
      refreshTasks().catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "Refresh failed.");
      });

      if (selectedId) {
        refreshDetail(selectedId).catch(() => undefined);
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [hasActiveTasks, selectedId, refreshTasks, refreshDetail]);

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || !agentId || sending) return;

    setSending(true);
    setError("");

    try {
      const orchestrated = executionMode === "orchestrated";

      const response = await fetch(
        orchestrated ? "/api/orchestrator" : "/api/tasks",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            orchestrated
              ? {
                  goal: cleanPrompt,
                  allowTools: enableTools,
                  maxAttempts: 2,
                }
              : {
                  agentId,
                  task: cleanPrompt,
                  enableTools,
                },
          ),
        },
      );

      const data = await response.json();

      const newId = orchestrated
        ? data.plan?.planId
        : data.task?.id;

      if (!response.ok || typeof newId !== "string") {
        throw new Error(data.error || "Task submission failed.");
      }

      setPrompt("");
      setSelectedId(newId);

      await Promise.all([
        refreshTasks(),
        refreshDetail(newId),
      ]);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Task submission failed.",
      );
    } finally {
      setSending(false);
    }
  }

  const output = resultText(detail?.result);

  return (
    <aside
      aria-label="APEX Task Console"
      style={{
        position: "fixed",
        left: 18,
        bottom: 18,
        zIndex: 80,
        width: "min(440px, calc(100vw - 36px))",
        maxHeight: "min(78vh, 760px)",
        display: "flex",
        flexDirection: "column",
        color: "#e5edf8",
        background: "rgba(5, 12, 23, 0.96)",
        border: "1px solid rgba(96, 165, 250, 0.30)",
        borderRadius: 15,
        boxShadow: "0 18px 60px rgba(0,0,0,.48)",
        backdropFilter: "blur(18px)",
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "13px 15px",
          borderBottom: open ? "1px solid rgba(148,163,184,.16)" : "none",
        }}
      >
        <div>
          <div style={{
            color: "#60a5fa",
            fontSize: 9,
            letterSpacing: "0.2em",
            marginBottom: 4,
          }}>
            MONSTER AI / EXECUTION ENGINE
          </div>
          <div style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.12em",
          }}>
            TASK CONSOLE
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>
            {tasks.length} TASKS
          </span>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            style={{
              color: "#dbeafe",
              background: "rgba(96,165,250,.12)",
              border: "1px solid rgba(96,165,250,.25)",
              borderRadius: 7,
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            {open ? "—" : "+"}
          </button>
        </div>
      </header>

      {open && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 14,
          overflowY: "auto",
          minHeight: 0,
        }}>
          <form onSubmit={submitTask} style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}>
            <label style={{
              fontSize: 9,
              color: "#94a3b8",
              letterSpacing: "0.16em",
            }}>
              EXECUTION MODE
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <button
                type="button"
                disabled={sending}
                onClick={() => setExecutionMode("agent")}
                style={{
                  padding: "9px 6px",
                  borderRadius: 7,
                  border: executionMode === "agent"
                    ? "1px solid rgba(96,165,250,.65)"
                    : "1px solid rgba(148,163,184,.18)",
                  color: executionMode === "agent" ? "#eff6ff" : "#94a3b8",
                  background: executionMode === "agent"
                    ? "rgba(37,99,235,.25)"
                    : "rgba(148,163,184,.05)",
                  fontSize: 9,
                  letterSpacing: ".08em",
                  cursor: "pointer",
                }}
              >
                DIRECT AGENT
              </button>

              <button
                type="button"
                disabled={sending}
                onClick={() => setExecutionMode("orchestrated")}
                style={{
                  padding: "9px 6px",
                  borderRadius: 7,
                  border: executionMode === "orchestrated"
                    ? "1px solid rgba(52,211,153,.60)"
                    : "1px solid rgba(148,163,184,.18)",
                  color: executionMode === "orchestrated" ? "#d1fae5" : "#94a3b8",
                  background: executionMode === "orchestrated"
                    ? "rgba(5,150,105,.17)"
                    : "rgba(148,163,184,.05)",
                  fontSize: 9,
                  letterSpacing: ".08em",
                  cursor: "pointer",
                }}
              >
                AUTO ORCHESTRATION
              </button>
            </div>
            {executionMode === "agent" && (
              <>
                <label style={{
                  fontSize: 9,
                  color: "#94a3b8",
                  letterSpacing: "0.16em",
                }}>
                  ASSIGNED AGENT
                </label>

                <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={sending || agents.length === 0}
              style={{
                width: "100%",
                color: "#e5edf8",
                background: "#101c2e",
                border: "1px solid rgba(148,163,184,.25)",
                borderRadius: 8,
                padding: "10px 11px",
                outline: "none",
              }}
            >
              {agents.length === 0 && <option value="">No agents available</option>}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name || agent.id} — {agent.id}
                </option>
              ))}
                </select>
              </>
            )}

            {executionMode === "orchestrated" && (
              <div style={{
                color: "#a7f3d0",
                background: "rgba(5,150,105,.09)",
                border: "1px solid rgba(52,211,153,.18)",
                borderRadius: 7,
                padding: 9,
                fontSize: 10,
                lineHeight: 1.6,
              }}>
                Chief of Staff will create a dependency-aware plan and distribute
                subtasks to the current pilot agents: Researcher, Developer and Memory.
              </div>
            )}

            <label style={{
              fontSize: 9,
              color: "#94a3b8",
              letterSpacing: "0.16em",
            }}>
              TASK INSTRUCTION
            </label>

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={12000}
              rows={4}
              placeholder="Describe the task you want MONSTER AI to execute..."
              disabled={sending}
              style={{
                resize: "vertical",
                minHeight: 84,
                width: "100%",
                boxSizing: "border-box",
                color: "#e5edf8",
                background: "#0b1626",
                border: "1px solid rgba(148,163,184,.25)",
                borderRadius: 8,
                padding: 11,
                fontSize: 12,
                lineHeight: 1.6,
                outline: "none",
              }}
            />

            <label style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 10,
              color: "#cbd5e1",
              cursor: "pointer",
            }}>
              <input
                type="checkbox"
                checked={enableTools}
                onChange={(event) => setEnableTools(event.target.checked)}
                disabled={sending}
              />
              {executionMode === "orchestrated" ? "Allow server-approved tools for specialist subtasks" : "Enable server-approved tools for this task"}
            </label>

            <button
              type="submit"
              disabled={sending || loading || (executionMode === "agent" && !agentId) || !prompt.trim()}
              style={{
                border: "1px solid rgba(96,165,250,.45)",
                borderRadius: 8,
                padding: "11px 14px",
                color: "#eff6ff",
                background: sending
                  ? "rgba(59,130,246,.18)"
                  : "linear-gradient(100deg, #1d4ed8, #2563eb)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                cursor: sending ? "wait" : "pointer",
                opacity: loading || (executionMode === "agent" && !agentId) || !prompt.trim() ? 0.55 : 1,
              }}
            >
              {sending ? "SUBMITTING..." : executionMode === "orchestrated" ? "PLAN & DISTRIBUTE TASKS" : "ENQUEUE TASK"}
            </button>
          </form>

          {error && (
            <div role="alert" style={{
              color: "#fecaca",
              background: "rgba(127,29,29,.24)",
              border: "1px solid rgba(248,113,113,.25)",
              borderRadius: 7,
              padding: 9,
              fontSize: 10,
              lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <span style={{
              fontSize: 9,
              color: "#94a3b8",
              letterSpacing: "0.16em",
            }}>
              RECENT EXECUTIONS
            </span>
            <button
              type="button"
              onClick={() => {
                refreshTasks().catch((e) => setError(String(e)));
              }}
              style={{
                color: "#93c5fd",
                border: "none",
                background: "transparent",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              REFRESH
            </button>
          </div>

          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            maxHeight: 150,
            overflowY: "auto",
          }}>
            {tasks.length === 0 && (
              <div style={{ color: "#64748b", fontSize: 11, padding: 10 }}>
                {loading ? "Loading task queue..." : "No tasks submitted yet."}
              </div>
            )}

            {tasks.slice(0, 20).map((task) => (
              <button
                type="button"
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  textAlign: "left",
                  padding: "9px 10px",
                  color: "#dbeafe",
                  background: selectedId === task.id
                    ? "rgba(37,99,235,.20)"
                    : "rgba(148,163,184,.055)",
                  border: selectedId === task.id
                    ? "1px solid rgba(96,165,250,.38)"
                    : "1px solid rgba(148,163,184,.10)",
                  borderRadius: 7,
                  cursor: "pointer",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 10,
                  }}>
                    {task.task_type === "orchestration_plan" ? "CHIEF OF STAFF PLAN" : task.agent_id} · {task.id.slice(0, 8)}
                  </span>
                  <span style={{ color: "#64748b", fontSize: 9 }}>
                    Attempt {task.attempt_count}/{task.max_attempts}
                  </span>
                </span>

                <span style={{
                  flexShrink: 0,
                  color: statusColor(task.status),
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: ".06em",
                }}>
                  {task.task_type === "orchestration_plan" ? "PLAN" : task.status.toUpperCase()}
                </span>
              </button>
            ))}
          </div>

          {detail && (
            <section style={{
              borderTop: "1px solid rgba(148,163,184,.16)",
              paddingTop: 11,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
              }}>
                <span style={{
                  color: "#93c5fd",
                  fontSize: 9,
                  letterSpacing: ".14em",
                }}>
                  SELECTED TASK
                </span>
                <span style={{
                  color: statusColor(planDetail?.executionStatus || detail.status),
                  fontSize: 9,
                  fontWeight: 700,
                }}>
                  {(planDetail?.executionStatus || detail.status).toUpperCase()}
                </span>
              </div>

              <div style={{
                fontSize: 9,
                color: "#64748b",
                overflowWrap: "anywhere",
              }}>
                {detail.id}
              </div>

              {planDetail && (
                <section style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: 10,
                  background: "rgba(5,150,105,.07)",
                  border: "1px solid rgba(52,211,153,.16)",
                  borderRadius: 8,
                }}>
                  <div style={{
                    color: "#6ee7b7",
                    fontSize: 9,
                    letterSpacing: ".12em",
                  }}>
                    ORCHESTRATION PLAN · {planDetail.tasks.length} SUBTASKS
                  </div>

                  <div style={{
                    color: "#d1fae5",
                    fontSize: 10,
                    lineHeight: 1.6,
                  }}>
                    {planDetail.plan.summary}
                  </div>

                  {planDetail.plan.finalizerStatus && (
                    <div style={{
                      color: "#94a3b8",
                      fontSize: 9,
                      letterSpacing: ".08em",
                    }}>
                      FINALIZER: {planDetail.plan.finalizerStatus.toUpperCase()}
                    </div>
                  )}

                  {typeof planDetail.plan.finalReport === "string" && planDetail.plan.finalReport.trim() ? (
                    <div style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: 9,
                      background: "rgba(6,78,59,.20)",
                      border: "1px solid rgba(52,211,153,.28)",
                      borderRadius: 7,
                    }}>
                      <div style={{
                        color: "#6ee7b7",
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: ".12em",
                      }}>
                        FINAL REPORT{planDetail.plan.finalReportTruncated ? " Â· TRUNCATED" : ""}
                      </div>
                      <pre style={{
                        margin: 0,
                        color: "#d1fae5",
                        fontFamily: "inherit",
                        fontSize: 10,
                        lineHeight: 1.65,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        maxHeight: 260,
                        overflowY: "auto",
                      }}>
                        {planDetail.plan.finalReport}
                      </pre>
                    </div>
                  ) : planDetail.plan.finalizationError ? (
                    <div role="alert" style={{
                      color: "#fecaca",
                      background: "rgba(127,29,29,.20)",
                      border: "1px solid rgba(248,113,113,.25)",
                      borderRadius: 7,
                      padding: 9,
                      fontSize: 10,
                      lineHeight: 1.5,
                    }}>
                      FINALIZATION ERROR: {planDetail.plan.finalizationError}
                    </div>
                  ) : (
                    <div style={{
                      color: "#94a3b8",
                      fontSize: 9,
                      lineHeight: 1.5,
                    }}>
                      Final report will appear here after the specialist tasks are completed and reviewed.
                    </div>
                  )}

                  {planDetail.tasks.map((child) => (
                    <button
                      type="button"
                      key={child.id}
                      onClick={() => setSelectedId(child.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "8px",
                        borderRadius: 6,
                        border: "1px solid rgba(148,163,184,.15)",
                        background: "rgba(15,23,42,.55)",
                        color: "#dbeafe",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span style={{
                          display: "block",
                          fontSize: 10,
                        }}>
                          {typeof child.metadata?.title === "string"
                            ? child.metadata.title
                            : child.agent_id}
                        </span>
                        <span style={{
                          display: "block",
                          color: "#64748b",
                          fontSize: 8,
                        }}>
                          {child.agent_id} · Attempt {child.attempt_count}/{child.max_attempts}
                        </span>
                      </span>
                      <span style={{
                        color: statusColor(child.status),
                        fontSize: 8,
                        fontWeight: 700,
                      }}>
                        {child.status.toUpperCase()}
                      </span>
                    </button>
                  ))}
                </section>
              )}

              {detail.input && (
                <div style={{
                  fontSize: 10,
                  color: "#cbd5e1",
                  lineHeight: 1.5,
                  maxHeight: 65,
                  overflowY: "auto",
                }}>
                  {detail.input}
                </div>
              )}

              {detail.error && (
                <div style={{
                  color: "#fca5a5",
                  fontSize: 10,
                  lineHeight: 1.5,
                }}>
                  ERROR: {detail.error}
                </div>
              )}

              {output && !planDetail && (
                <pre style={{
                  margin: 0,
                  padding: 10,
                  color: "#d1fae5",
                  background: "rgba(6,78,59,.18)",
                  border: "1px solid rgba(52,211,153,.18)",
                  borderRadius: 7,
                  fontFamily: "inherit",
                  fontSize: 10,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: 190,
                  overflowY: "auto",
                }}>
                  {output}
                </pre>
              )}

              {detail.events && detail.events.length > 0 && (
                <div style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 5,
                }}>
                  {detail.events.slice(-5).map((event) => (
                    <span
                      key={event.id}
                      title={shortDate(event.created_at)}
                      style={{
                        color: event.success === false ? "#fca5a5" : "#94a3b8",
                        background: "rgba(148,163,184,.08)",
                        borderRadius: 5,
                        padding: "4px 6px",
                        fontSize: 8,
                      }}
                    >
                      {event.event_type}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ color: "#64748b", fontSize: 8 }}>
                Created: {shortDate(detail.created_at)}
                {detail.completed_at
                  ? ` · Completed: ${shortDate(detail.completed_at)}`
                  : ""}
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}