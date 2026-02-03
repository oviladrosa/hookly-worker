export type VideoJobStatus = "pending" | "processing" | "done" | "error"

// Transition types between hook and demo
export type TransitionType = "cut" | "crossfade" | "push-up" | "zoom-cut"

export interface Transition {
  type: TransitionType
  duration: number // milliseconds
}

// Effect types (used for both hook and demo)
export type EffectType = "none" | "zoom-in" | "punch-zoom" | "vertical-pan" | "center-crop"

// Keep HookEffectType as alias for backwards compatibility
export type HookEffectType = EffectType

export interface HookEffect {
  type: HookEffectType
  intensity: "subtle" | "medium" | "strong"
}

// Demo effect (same options as hook effect)
export interface DemoEffect {
  type: EffectType
  intensity: "subtle" | "medium" | "strong"
}

// Hook trimming
export interface HookTrim {
  startTime: number
  endTime: number
  useFullVideo: boolean
}

// Demo trimming
export interface DemoTrim {
  startTime: number
  endTime: number
  useFullVideo: boolean
}

// Text styling options
export type FontSize = "small" | "medium" | "large"

export interface TextStyle {
  fontSize: FontSize
  color: string
  fontWeight?: "normal" | "bold"
}

// Audio source options
export type AudioSource = "hook" | "demo" | "both" | "none"

// Job configuration for video processing
export interface JobConfig {
  hookTrim?: HookTrim
  demoTrim?: DemoTrim
  transition?: Transition
  hookEffect?: HookEffect
  demoEffect?: DemoEffect
  textStyle?: TextStyle
  textPosition?: { x: number; y: number }
  audioSource?: AudioSource
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
