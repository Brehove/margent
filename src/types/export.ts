export type DocumentExportFormat = "html" | "docx";

export interface DocumentExportResult {
  documentRelativePath: string;
  format: DocumentExportFormat;
  googleDocUrl: string | null;
  outputPath: string | null;
}
