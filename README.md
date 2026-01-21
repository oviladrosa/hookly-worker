# Hookly Video Worker

A Node.js worker that processes video generation jobs for Hookly using FFmpeg.

## Architecture

```
Next.js (Vercel)        Supabase              Railway Worker
    │                      │                       │
    │ ──create job──►      │                       │
    │                      │ ◄──poll pending───    │
    │                      │ ──return job──►       │
    │                      │                       │
    │                      │ ◄──update status──    │
    │ ◄──poll status──     │                       │
    │                      │                       │
    │                      │ ◄──upload output──    │
    │                      │ ◄──update done────    │
    │ ◄──get result──      │                       │
```

## Setup

### 1. Environment Variables

Create a `.env` file:

```bash
# Supabase (use service role key - NEVER expose to frontend)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Worker config
POLL_INTERVAL_MS=5000
TMP_DIR=/tmp/hookly
```

### 2. Local Development

```bash
# Install dependencies
npm install

# Run in development
npm run dev

# Build for production
npm run build
npm start
```

### 3. Deploy to Railway

1. Create a new Railway project
2. Connect this `worker` folder as a service
3. Add environment variables in Railway dashboard
4. Railway will auto-deploy using the Dockerfile

## FFmpeg Processing

The worker creates TikTok-optimized videos:

- **Resolution**: 1080x1920 (9:16 vertical)
- **Frame rate**: 30fps
- **Codec**: H.264 (libx264)
- **Text overlay**: 
  - Visible only during first 3 seconds
  - Large font (72px)
  - White text with black shadow
  - Semi-transparent black background box
  - Centered on screen

## Database Schema

The worker reads/writes to the `video_jobs` table:

```sql
CREATE TABLE video_jobs (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  intro_url TEXT NOT NULL,
  main_url TEXT NOT NULL,
  hook_text TEXT,
  status video_job_status DEFAULT 'pending',
  output_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Security

- Uses Supabase **service role key** (bypasses RLS)
- Never expose service role key to frontend
- Videos are stored in user-scoped paths
- Only processes jobs from the database

## Scaling

For higher throughput:
- Run multiple worker instances
- Implement job locking (claim jobs before processing)
- Add priority queues
- Use Redis for job coordination
