export const AGENTS = [
  { id: "chief_of_staff", name: "Chief of Staff", role: "Central coordinator", domain: "Orchestration" },
  { id: "memory", name: "Memory", role: "Context and memory", domain: "Knowledge" },
  { id: "strategist", name: "Strategist", role: "Planning and strategy", domain: "Strategy" },
  { id: "researcher", name: "Researcher", role: "Research and discovery", domain: "Research" },
  { id: "finance", name: "Finance", role: "Financial analysis", domain: "Finance" },
  { id: "editor", name: "Editor", role: "Writing and editing", domain: "Content" },
  { id: "sales", name: "Sales", role: "Sales operations", domain: "Business" },
  { id: "marketing", name: "Marketing", role: "Marketing strategy", domain: "Business" },
  { id: "ops", name: "Operations", role: "Operational workflows", domain: "Operations" },
  { id: "social_media", name: "Social Media", role: "Social media operations", domain: "Marketing" },
  { id: "engineering", name: "Engineering", role: "Systems engineering", domain: "Technology" },
  { id: "design", name: "Design", role: "Design and UX", domain: "Creative" },
  { id: "developer", name: "Developer", role: "Software development", domain: "Technology" },
  { id: "analytics", name: "Analytics", role: "Data analysis", domain: "Analytics" },
  { id: "crm", name: "CRM", role: "Customer relationship management", domain: "Business" },
  { id: "calendar", name: "Calendar", role: "Calendar management", domain: "Productivity" },
  { id: "email", name: "Email", role: "Email operations", domain: "Productivity" },
  { id: "drive", name: "Drive", role: "File and document operations", domain: "Productivity" }
] as const;

export type AgentId = typeof AGENTS[number]["id"];

export type AgentStatus = "not_configured" | "ready" | "busy" | "error";

export type AgentRecord = {
  id: AgentId;
  name: string;
  role: string;
  domain: string;
  status: AgentStatus;
  configured: boolean;
  connected: boolean;
};

export function getAgentRegistry(): AgentRecord[] {
  return AGENTS.map((agent) => ({
    ...agent,
    status: "not_configured",
    configured: false,
    connected: false
  }));
}
