export type MemoryCategory =
  | "decision"
  | "architecture"
  | "preference"
  | "progress"
  | "bug"
  | "conversation"
  | "general";

export type MemorySource = "auto" | "manual";
export type MemoryScope = "global" | "project" | "shared" | "both";

export interface Memory {
  id: number;
  content: string;
  category: MemoryCategory;
  tags: string | null;
  importance: number;
  source: MemorySource;
  created_at: string;
  updated_at: string;
  access_count: number;
  context: string | null;
  archived: number;
  session_id: string | null;
}

export interface AddMemoryInput {
  content: string;
  category?: MemoryCategory;
  tags?: string;
  importance?: number;
  scope?: MemoryScope;
  context?: string;
}

export interface SearchMemoryInput {
  query: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  limit?: number;
}

export interface ListMemoryInput {
  category?: MemoryCategory;
  scope?: MemoryScope;
  limit?: number;
}

export interface UpdateMemoryInput {
  id: number;
  content?: string;
  category?: MemoryCategory;
  tags?: string;
  importance?: number;
  scope?: MemoryScope;
  context?: string;
}

export interface DeleteMemoryInput {
  id: number;
  scope?: MemoryScope;
}

export interface GetContextInput {
  project_name: string;
  limit?: number;
}
