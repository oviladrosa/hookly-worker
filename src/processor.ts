import { spawn } from "child_process"
import { writeFile, unlink, readFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { VideoJob, ProcessResult } from "./types"

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

// Build FFmpeg command for video concatenation with text overlay
function buildFFmpegArgs(
  introPath: string,
  mainPath: string,
  outputPath: string,
  hookText: string | null
): string[] {
  const args: string[] = [
    "-y", // Overwrite output
    "-i", introPath,
    "-i", mainPath,
  ]

  // Build filter complex
  let filterComplex = ""

  // Scale intro video to TikTok format (1080x1920)
  filterComplex += "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
  filterComplex += "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,"
  filterComplex += "setsar=1,fps=30"

  // Add text overlay to intro (visible only during first 3 seconds)
  if (hookText) {
    const escapedText = hookText
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "'\\''")
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")

    // TikTok-style text: large, white, with semi-transparent black background
    filterComplex += `,drawtext=text='${escapedText}'`
    filterComplex += `:fontsize=72`
    filterComplex += `:fontcolor=white`
    filterComplex += `:x=(w-text_w)/2`
    filterComplex += `:y=(h-text_h)/2`
    filterComplex += `:shadowcolor=black@0.7`
    filterComplex += `:shadowx=3`
    filterComplex += `:shadowy=3`
    filterComplex += `:enable='between(t,0,3)'` // Show only for first 3 seconds
    filterComplex += `:box=1`
    filterComplex += `:boxcolor=black@0.5`
    filterComplex += `:boxborderw=15`
  }

  filterComplex += "[v0];"

  // Scale main video to TikTok format
  filterComplex += "[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
  filterComplex += "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,"
  filterComplex += "setsar=1,fps=30[v1];"

  // Concatenate videos
  filterComplex += "[v0][v1]concat=n=2:v=1:a=0[outv]"

  args.push("-filter_complex", filterComplex)
  args.push("-map", "[outv]")

  // Output settings optimized for TikTok
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath
  )

  return args
}

// Run FFmpeg command
function runFFmpeg(args: string[]): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`   🎬 Running FFmpeg...`)
    
    const ffmpeg = spawn("ffmpeg", args)
    let stderr = ""

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    ffmpeg.on("error", (error) => {
      resolve({ success: false, error: `FFmpeg failed to start: ${error.message}` })
    })

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log(`   ✓ FFmpeg completed successfully`)
        resolve({ success: true })
      } else {
        // Extract error from stderr
        const errorLines = stderr.split("\n").filter(
          (line) => line.includes("Error") || line.includes("error")
        )
        const errorMessage = errorLines.slice(-3).join("; ") || `FFmpeg exited with code ${code}`
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
    // Download source videos
    console.log(`   📥 Downloading source videos...`)
    await Promise.all([
      downloadFile(job.intro_url, introPath),
      downloadFile(job.main_url, mainPath),
    ])

    // Build and run FFmpeg command
    const ffmpegArgs = buildFFmpegArgs(introPath, mainPath, outputPath, job.hook_text)
    
    if (job.hook_text) {
      console.log(`   📝 Text overlay: "${job.hook_text}" (0-3 seconds)`)
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
