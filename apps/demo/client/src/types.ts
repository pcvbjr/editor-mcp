export interface DocumentIdentity {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentIncarnation: string;
  readonly collaborationField: string;
  readonly schemaId: 'editor-mcp/mvp';
  readonly schemaVersion: 1;
}

export interface DocumentSession {
  readonly identity: DocumentIdentity;
  readonly documentName: string;
  readonly collaborationUrl: string;
}

export interface ChangeMetadata {
  readonly id: string;
  readonly groupId?: string;
  readonly suggestionGroupId?: string;
  readonly suggestionGroupName?: string;
  readonly operationId?: string;
  readonly status: 'accepted' | 'pending' | 'rejected';
  readonly operation: 'delete' | 'format' | 'insert' | 'replace' | 'structure';
  readonly authorId: string;
  readonly authorType: 'agent' | 'human';
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly summary?: string;
  readonly baseBlockId?: string;
}
