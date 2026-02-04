import type { Context } from 'hono';

// Define the variables we store in Hono context
export interface AppVariables {
  agentId: string;
  agentStatus: string;
  agent: {
    id: string;
    name: string;
    homeLocationId: string;
    [key: string]: unknown;
  };
}

// Helper type for authenticated routes
export type AuthContext = Context<{ Variables: AppVariables }>;
