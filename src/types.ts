export type VideoJobStatus = "pending" | "processing" | "done" | "error"

// Transition types between hook and demo
export type TransitionType = "cut" | "crossfade" | "push-up" | "zoom-cut"

export interface Transition {
  type: TransitionType
  duration: number // milliseconds
}

// Hook effect types
export type HookEffectType = "none" | "zoom-in" | "punch-zoom" | "vertical-pan" | "center-crop"

export interface HookEffect {
  type: HookEffectType
  intensity: "subtle" | "medium" | "strong"
}

// Hook trimming
export interface HookTrim {
  startTime: number
  endTime: number
  useFullVideo: boolean
}

// Job configuration for video processing
export interface JobConfig {
  hookTrim?: HookTrim
  transition?: Transition
  hookEffect?: HookEffect
  textPosition?: { x: number; y: number }
}

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
  // Extended config
  config?: JobConfig | null
}

export interface ProcessResult {
  success: boolean
  outputUrl?: string
  error?: string
}
