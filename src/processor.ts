import { spawn } from "child_process"
import { writeFile, unlink, readFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { VideoJob, ProcessResult, JobConfig, HookEffect, DemoEffect, Transition, FontSize } from "./types"

const TMP_DIR = process.env.TMP_DIR || "/tmp/hookly"

// Ensure temp directory exists
async function ensureTmpDir(): Promise<void> {
  if (!existsSync(TMP_DIR)) {
    await mkdir(TMP_DIR, { recursive: true })
  }
}

// Download file from URL
async function downloadFile(url: string, outputPath: string): Promise<void> {
  console.log(`   📥 Downloading: ${url.slice(0, 80)}...`)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(outputPath, buffer)

  console.log(`   ✓ Downloaded: ${outputPath} (${buffer.length} bytes)`)
}

// Get intensity multiplier for effects
function getIntensityMultiplier(intensity: "subtle" | "medium" | "strong"): number {
  switch (intensity) {
    case "subtle": return 0.5
    case "medium": return 1.0
    case "strong": return 1.5
    default: return 1.0
  }
}

// Get font size in pixels
function getFontSizePixels(fontSize: FontSize): number {
  switch (fontSize) {
    case "small": return 48
    case "medium": return 72
    case "large": return 96
    default: return 72
  }
}

// Build effect filter (used for both hook and demo)
// Note: These effects are applied AFTER scaling to 1080x1920, so we work with that size
function buildEffectFilter(effect: HookEffect | DemoEffect, durationFrames: number = 90): string {
  const intensity = getIntensityMultiplier(effect.intensity)
  // Use proper frame count for animations (default 3 seconds at 30fps = 90 frames)
  const d = Math.max(durationFrames, 30)

  switch (effect.type) {
    case "zoom-in":
      // Gradual zoom in effect (Ken Burns style)
      // Zoom from 1.0 to 1.0 + (0.15 * intensity) over the duration
      const zoomEnd = 1 + (0.15 * intensity)
      const zoomIncrement = (zoomEnd - 1) / d
      return `zoompan=z='min(1+on*${zoomIncrement},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=1080x1920:fps=30`

    case "punch-zoom":
      // Quick punch zoom - zoom in fast then settle
      // First 20% of frames: zoom from 1.0 to 1.0 + (0.2 * intensity)
      // Rest: hold at that zoom
      const punchZoom = 1 + (0.2 * intensity)
      const punchFrames = Math.floor(d * 0.2)
      return `zoompan=z='if(lt(on,${punchFrames}),1+on*${(punchZoom - 1) / punchFrames},${punchZoom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=1080x1920:fps=30`

    case "vertical-pan":
      // Slow vertical pan - uses zoompan with y movement
      // Start zoomed in slightly, pan from top to center
      const panZoom = 1.1
      const panAmount = Math.floor(1920 * 0.05 * intensity) // 5% of height * intensity
      return `zoompan=z='${panZoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-${panAmount}+on*${(panAmount * 2) / d}':d=${d}:s=1080x1920:fps=30`

    case "center-crop":
      // Center crop with slight zoom - scale up then crop back to 1080x1920
      const cropZoom = 1 + (0.1 * intensity)
      return `scale=${Math.round(1080 * cropZoom)}:${Math.round(1920 * cropZoom)},crop=1080:1920:(iw-1080)/2:(ih-1920)/2`

    default:
      return ""
  }
}

// Legacy alias for backwards compatibility
function buildHookEffectFilter(effect: HookEffect, durationFrames: number = 90): string {
  return buildEffectFilter(effect, durationFrames)
}

// Build transition filter between hook and demo
function buildTransitionFilter(transition: Transition, hookDuration: number): string {
  const durationSec = transition.duration / 1000
  const offset = Math.max(0, hookDuration - durationSec)

  switch (transition.type) {
    case "crossfade":
      return `xfade=transition=fade:duration=${durationSec}:offset=${offset}`

    case "push-up":
      return `xfade=transition=slideup:duration=${durationSec}:offset=${offset}`

    case "zoom-cut":
      // Zoom cut - quick zoom at the cut point
      return `xfade=transition=zoomin:duration=${Math.min(durationSec, 0.3)}:offset=${offset}`

    case "cut":
    default:
      // Simple concat, no transition filter needed
      return ""
  }
}

// Get video duration using ffprobe
async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath
    ])

    let output = ""
    ffprobe.stdout.on("data", (data) => {
      output += data.toString()
    })

    ffprobe.on("close", () => {
      const duration = parseFloat(output.trim())
      resolve(isNaN(duration) ? 5 : duration) // Default to 5 seconds if probe fails
    })

    ffprobe.on("error", () => {
      resolve(5) // Default to 5 seconds if ffprobe fails
    })
  })
}

// Build FFmpeg command for video concatenation with all effects (no audio)
async function buildFFmpegArgs(
  introPath: string,
  mainPath: string,
  outputPath: string,
  hookText: string | null,
  config: JobConfig | null | undefined
): Promise<string[]> {
  const args: string[] = ["-y"] // Overwrite output

  // Get video durations for effects and transitions
  const introDuration = await getVideoDuration(introPath)
  const mainDuration = await getVideoDuration(mainPath)

  // Calculate hook duration (after any trimming)
  let hookStartTime = 0
  let hookDuration: number
  if (config?.hookTrim && !config.hookTrim.useFullVideo) {
    hookStartTime = config.hookTrim.startTime
    hookDuration = config.hookTrim.endTime - config.hookTrim.startTime
  } else {
    hookDuration = introDuration
  }

  // Calculate demo duration (after any trimming)
  let demoStartTime = 0
  if (config?.demoTrim && !config.demoTrim.useFullVideo) {
    demoStartTime = config.demoTrim.startTime
  }

  // Calculate frames for effects (30fps)
  const hookFrames = Math.floor(hookDuration * 30)
  const demoFrames = Math.floor((config?.demoTrim && !config.demoTrim.useFullVideo
    ? config.demoTrim.endTime - config.demoTrim.startTime
    : mainDuration) * 30)

  // Add inputs
  args.push("-i", introPath)
  args.push("-i", mainPath)

  // Build filter complex (video only)
  let filterParts: string[] = []

  // === INTRO VIDEO PROCESSING ===
  let introFilter = "[0:v]"

  // Apply trimming first if needed
  if (config?.hookTrim && !config.hookTrim.useFullVideo) {
    introFilter += `trim=start=${hookStartTime}:end=${config.hookTrim.endTime},setpts=PTS-STARTPTS,`
  }

  // Scale to TikTok format
  introFilter += "scale=1080:1920:force_original_aspect_ratio=decrease,"
  introFilter += "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,"
  introFilter += "setsar=1,fps=30"

  // Apply hook effect if specified
  if (config?.hookEffect && config.hookEffect.type !== "none") {
    const effectFilter = buildHookEffectFilter(config.hookEffect, hookFrames)
    if (effectFilter) {
      introFilter += "," + effectFilter
    }
  }

  // Add text overlay with styling from config
  if (hookText) {
    const escapedText = hookText
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\\''")
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")

    // Get text styling from config or use defaults
    const fontSize = config?.textStyle?.fontSize ? getFontSizePixels(config.textStyle.fontSize) : 72
    const fontColor = config?.textStyle?.color || "white"
    const fontWeight = config?.textStyle?.fontWeight || "normal"

    // Use custom position if provided, otherwise center
    const textX = config?.textPosition ? `(w*${config.textPosition.x}/100)-(text_w/2)` : "(w-text_w)/2"
    const textY = config?.textPosition ? `(h*${config.textPosition.y}/100)-(text_h/2)` : "(h-text_h)/2"

    introFilter += `,drawtext=text='${escapedText}'`
    introFilter += `:fontsize=${fontSize}`
    introFilter += `:fontcolor=${fontColor}`
    introFilter += `:x=${textX}`
    introFilter += `:y=${textY}`
    introFilter += `:borderw=3`
    introFilter += `:bordercolor=black`
    introFilter += `:shadowcolor=black@0.6`
    introFilter += `:shadowx=4`
    introFilter += `:shadowy=4`
    introFilter += `:enable='between(t,0,${hookDuration})'`
    // Use bold font if specified
    if (fontWeight === "bold") {
      introFilter += `:font=DejaVu Sans Bold`
    }
  }

  introFilter += "[v0]"
  filterParts.push(introFilter)

  // === MAIN VIDEO PROCESSING ===
  let mainFilter = "[1:v]"

  // Apply demo trimming first if needed
  if (config?.demoTrim && !config.demoTrim.useFullVideo) {
    mainFilter += `trim=start=${demoStartTime}:end=${config.demoTrim.endTime},setpts=PTS-STARTPTS,`
  }

  mainFilter += "scale=1080:1920:force_original_aspect_ratio=decrease,"
  mainFilter += "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,"
  mainFilter += "setsar=1,fps=30"

  // Apply demo effect if specified
  if (config?.demoEffect && config.demoEffect.type !== "none") {
    const effectFilter = buildEffectFilter(config.demoEffect, demoFrames)
    if (effectFilter) {
      mainFilter += "," + effectFilter
    }
  }

  mainFilter += "[v1]"
  filterParts.push(mainFilter)

  // === COMBINE VIDEOS ===
  const transition = config?.transition

  if (transition && transition.type !== "cut" && transition.duration > 0) {
    const transitionFilter = buildTransitionFilter(transition, hookDuration)
    if (transitionFilter) {
      filterParts.push(`[v0][v1]${transitionFilter}[outv]`)
    } else {
      filterParts.push("[v0][v1]concat=n=2:v=1:a=0[outv]")
    }
  } else {
    filterParts.push("[v0][v1]concat=n=2:v=1:a=0[outv]")
  }

  args.push("-filter_complex", filterParts.join(";"))
  args.push("-map", "[outv]")

  // No audio output
  args.push("-an")

  // Output settings optimized for TikTok (balanced quality/speed)
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",      // Balanced speed/quality (slow was causing timeouts)
    "-crf", "22",             // Good quality (lower = better, 18-28 typical)
    "-profile:v", "high",     // Better compatibility
    "-level", "4.0",          // Good for mobile
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart"
  )

  args.push(outputPath)

  return args
}

// Run FFmpeg command with timeout
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function runFFmpeg(args: string[]): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`   🎬 Running FFmpeg...`)
    console.log(`   Command: ffmpeg ${args.join(" ").slice(0, 200)}...`)

    // Log the filter_complex for debugging
    const filterIdx = args.indexOf("-filter_complex")
    if (filterIdx !== -1 && args[filterIdx + 1]) {
      console.log(`   Filter: ${args[filterIdx + 1].slice(0, 500)}...`)
    }

    const ffmpeg = spawn("ffmpeg", args)
    let stderr = ""
    let resolved = false

    // Set timeout to kill hung processes
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        console.error(`   ❌ FFmpeg timeout after ${FFMPEG_TIMEOUT_MS / 1000}s - killing process`)
        ffmpeg.kill("SIGKILL")
        resolve({ success: false, error: `FFmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000} seconds` })
      }
    }, FFMPEG_TIMEOUT_MS)

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    ffmpeg.on("error", (error) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve({ success: false, error: `FFmpeg failed to start: ${error.message}` })
      }
    })

    ffmpeg.on("close", (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)

      if (code === 0) {
        console.log(`   ✓ FFmpeg completed successfully`)
        resolve({ success: true })
      } else {
        // Extract error from stderr - look for lines with error keywords
        const errorLines = stderr.split("\n").filter(
          (line) => line.includes("Error") || line.includes("error") || line.includes("Invalid") || line.includes("No such")
        )
        // If no specific error lines found, get the last few lines of stderr
        const lastLines = stderr.split("\n").filter(l => l.trim()).slice(-5)
        const errorMessage = errorLines.length > 0
          ? errorLines.slice(-3).join("; ")
          : lastLines.join("; ") || `FFmpeg exited with code ${code}`
        console.error(`   ❌ FFmpeg error: ${errorMessage}`)
        resolve({ success: false, error: errorMessage })
      }
    })
  })
}

// Upload file to Supabase Storage
async function uploadToStorage(
  supabase: SupabaseClient,
  filePath: string,
  userId: string,
  jobId: string
): Promise<string> {
  console.log(`   📤 Uploading to Supabase Storage...`)

  const fileBuffer = await readFile(filePath)
  const storagePath = `${userId}/output/${jobId}.mp4`

  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(storagePath, fileBuffer, {
      contentType: "video/mp4",
      upsert: true,
    })

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`)
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from("videos")
    .getPublicUrl(storagePath)

  console.log(`   ✓ Uploaded to: ${urlData.publicUrl}`)

  return urlData.publicUrl
}

// Cleanup temporary files
async function cleanup(files: string[]): Promise<void> {
  for (const file of files) {
    try {
      if (existsSync(file)) {
        await unlink(file)
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Main processing function
export async function processJob(
  job: VideoJob,
  supabase: SupabaseClient
): Promise<ProcessResult> {
  await ensureTmpDir()

  const introPath = path.join(TMP_DIR, `${job.id}-intro.mp4`)
  const mainPath = path.join(TMP_DIR, `${job.id}-main.mp4`)
  const outputPath = path.join(TMP_DIR, `${job.id}-output.mp4`)
  const filesToCleanup = [introPath, mainPath, outputPath]

  try {
    // Log config for debugging
    if (job.config) {
      console.log(`   📋 Job config:`)
      if (job.config.hookTrim && !job.config.hookTrim.useFullVideo) {
        console.log(`      - Hook trim: ${job.config.hookTrim.startTime}s - ${job.config.hookTrim.endTime}s`)
      }
      if (job.config.demoTrim && !job.config.demoTrim.useFullVideo) {
        console.log(`      - Demo trim: ${job.config.demoTrim.startTime}s - ${job.config.demoTrim.endTime}s`)
      }
      if (job.config.transition) {
        console.log(`      - Transition: ${job.config.transition.type} (${job.config.transition.duration}ms)`)
      }
      if (job.config.hookEffect && job.config.hookEffect.type !== "none") {
        console.log(`      - Hook effect: ${job.config.hookEffect.type} (${job.config.hookEffect.intensity})`)
      }
      if (job.config.demoEffect && job.config.demoEffect.type !== "none") {
        console.log(`      - Demo effect: ${job.config.demoEffect.type} (${job.config.demoEffect.intensity})`)
      }
      if (job.config.textPosition) {
        console.log(`      - Text position: (${job.config.textPosition.x}%, ${job.config.textPosition.y}%)`)
      }
      if (job.config.textStyle) {
        console.log(`      - Text style: ${job.config.textStyle.fontSize}, ${job.config.textStyle.color}`)
      }
    }

    // Download source videos
    console.log(`   📥 Downloading source videos...`)
    await Promise.all([
      downloadFile(job.intro_url, introPath),
      downloadFile(job.main_url, mainPath),
    ])

    // Build and run FFmpeg command
    const ffmpegArgs = await buildFFmpegArgs(introPath, mainPath, outputPath, job.hook_text, job.config)

    if (job.hook_text) {
      const posInfo = job.config?.textPosition
        ? `at (${job.config.textPosition.x}%, ${job.config.textPosition.y}%)`
        : "centered"
      console.log(`   📝 Text overlay: "${job.hook_text}" ${posInfo}`)
    }

    const ffmpegResult = await runFFmpeg(ffmpegArgs)

    if (!ffmpegResult.success) {
      return { success: false, error: ffmpegResult.error }
    }

    // Verify output exists
    if (!existsSync(outputPath)) {
      return { success: false, error: "Output file was not created" }
    }

    // Upload to Supabase Storage
    const outputUrl = await uploadToStorage(supabase, outputPath, job.user_id, job.id)

    // Also save to videos table for the user's library
    await supabase.from("videos").insert({
      user_id: job.user_id,
      url: outputUrl,
      filename: `hookly-${job.id.slice(0, 8)}.mp4`,
      type: "output",
      storage_path: `${job.user_id}/output/${job.id}.mp4`,
    })

    return { success: true, outputUrl }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: errorMessage }
  } finally {
    // Cleanup temp files
    await cleanup(filesToCleanup)
  }
}
