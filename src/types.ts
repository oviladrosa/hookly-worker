export type VideoJobStatus = "pending" | "processing" | "done" | "error"

export interface VideoJob {
  id: string
  user_id: string
  intro_url: string
  main_url: string
  hook_text: string | null
  status: VideoJobStatus
  output_url: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface ProcessResult {
  success: boolean
  outputUrl?: string
  error?: string
}
