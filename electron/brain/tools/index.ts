import { AGENTS } from '../agents';
import type { AgentId, ToolSpec } from '../types';
import { V2_TOOLS, workflow } from '../workflow';
import { appTools } from './apps';
import { d2lTools } from './d2l';
import { discordTools } from './discord';
import { addonTools } from './addons';
import { fsTools } from './fs';
import { memoryTools } from './memory';
import { systemTools } from './system';
import { taskTools } from './tasks';
import type { AgentTool } from './types';
import { webTools } from './web';

export const ALL_TOOLS: AgentTool[] = [...webTools, ...fsTools, ...systemTools, ...appTools, ...discordTools, ...addonTools, ...d2lTools, ...taskTools, ...memoryTools];

const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AgentTool | undefined {
  return byName.get(name);
}

export function toolsFor(agent: AgentId): AgentTool[] {
  const v2 = workflow().newTools;
  return AGENTS[agent].tools
    .filter((n) => v2 || !V2_TOOLS.has(n))
    .map((n) => byName.get(n))
    .filter((t): t is AgentTool => Boolean(t));
}

export function toSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export type { AgentTool, ToolContext } from './types';
