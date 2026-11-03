/**
 * The parts of ACP and Kiro's `_meta.kiro` payloads that the server reads.
 * Everything else passes through as unknown JSON; unknown fields never fail.
 */

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface KiroCapabilities {
  extensionMethods?: string[];
  sessionSources?: string[];
  sessionListScopes?: string[];
  executionTargets?: string[];
  autoCompactionThreshold?: { min?: number; max?: number; default?: number };
  logging?: { logDir?: string; channels?: { name?: string; filePath?: string }[] };
  [key: string]: unknown;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: Record<string, unknown>;
  sessionCapabilities?: Record<string, unknown>;
  _meta?: { kiro?: KiroCapabilities };
}

export interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: { id: string; name?: string }[];
}

export interface ModeInfo {
  id: string;
  name?: string;
  description?: string;
  _meta?: { kiro?: { source?: string } };
}

export interface ConfigOptionValue {
  value: string;
  name?: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name?: string;
  type?: string;
  category?: string;
  currentValue?: unknown;
  options?: ConfigOptionValue[];
}

export interface CommandInfo {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
  _meta?: { kiro?: { type?: string } };
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown };
  options: PermissionOption[];
  _meta?: {
    kiro?: {
      toolId?: string;
      command?: string;
      consent?: {
        capability?: string;
        resource?: string;
        askType?: string;
        triggeringResource?: string;
        workspaceRoot?: string;
        persistableConsent?: boolean;
      };
      consentRound?: number;
      mcpTool?: { serverName?: string; toolName?: string; annotations?: Record<string, boolean> };
      [key: string]: unknown;
    };
  };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; size?: number }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } };
