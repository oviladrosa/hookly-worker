import { createClient } from "@supabase/supabase-js"
import { processJob } from "./processor"
import type { VideoJob } from "./types"

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10)

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing required environment variables:")
  console.error("   - SUPABASE_URL")
  console.error("   - SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

// Initialize Supabase client with service role key (bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

console.log("🚀 Hookly Video Worker starting...")
console.log(`📊 Poll interval: ${POLL_INTERVAL_MS}ms`)

let isProcessing = false

async function pollForJobs(): Promise<void> {
  if (isProcessing) {
    return
  }

  try {
    // Fetch oldest pending job
    const { data: jobs, error } = await supabase
      .from("video_jobs")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)

    if (error) {
      console.error("❌ Error fetching jobs:", error.message)
      return
    }

    if (!jobs || jobs.length === 0) {
      return
    }

    const job = jobs[0] as VideoJob
    console.log(`\n📦 Found job: ${job.id}`)

    isProcessing = true

    try {
      // Update status to processing
      await supabase
        .from("video_jobs")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("id", job.id)

      console.log(`⚙️  Processing job ${job.id}...`)

      // Process the video
      const result = await processJob(job, supabase)

      if (result.success && result.outputUrl) {
        // Update job as done
        await supabase
          .from("video_jobs")
          .update({
            status: "done",
            output_url: result.outputUrl,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)

        console.log(`✅ Job ${job.id} completed successfully`)
        console.log(`   Output: ${result.outputUrl}`)
      } else {
        // Update job as error
        await supabase
          .from("video_jobs")
          .update({
            status: "error",
            error_message: result.error || "Unknown error",
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)

        console.error(`❌ Job ${job.id} failed: ${result.error}`)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      
      // Update job as error
      await supabase
        .from("video_jobs")
        .update({
          status: "error",
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)

      console.error(`❌ Job ${job.id} failed with exception: ${errorMessage}`)
    } finally {
      isProcessing = false
    }
  } catch (err) {
    console.error("❌ Unexpected error in poll loop:", err)
    isProcessing = false
  }
}

// Start polling
console.log("👀 Watching for pending jobs...")

setInterval(pollForJobs, POLL_INTERVAL_MS)

// Initial poll
pollForJobs()

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n🛑 Received SIGTERM, shutting down...")
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("\n🛑 Received SIGINT, shutting down...")
  process.exit(0)
})
