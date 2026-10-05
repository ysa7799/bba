// Response shapes of `/app/orgs/:orgId/files` (mirrors `@businessos/files`).

export type FileEntityType = 'contact' | 'company' | 'deal';

export interface FileSummary {
  id: string;
  name: string;
  contentType: string;
  /** Exact byte count as a decimal string. */
  sizeBytes: string;
  entityType: FileEntityType | null;
  entityId: string | null;
  uploadedBy: { id: string; name: string } | null;
  /** Images can be opened in the browser; everything else downloads. */
  inline: boolean;
  createdAt: string;
}
