# Virtual Girlfriend AI Backend

![Video Thumbnail](https://img.youtube.com/vi/EzzcEL_1o9o/maxresdefault.jpg)

[Video tutorial](https://youtu.be/EzzcEL_1o9o)

The frontend is [here](https://github.com/wass08/r3f-virtual-girlfriend-frontend).

## Architecture Overview

This backend is built for scalability on Fly.io and consists of:

1. **API Service**: Express.js service for handling client requests
2. **Redis Queue**: BullMQ job queue for async processing 
3. **Worker Service**: Dedicated instances for CPU-intensive tasks
4. **Persistent Volume**: For audio file storage with user isolation

## Local Development Setup

1. Create a `.env` file at the root of the repository to add your **OpenAI** and **ElevenLabs API Keys**. Refer to `.env.example` for the environment variable names.

2. Download the **RhubarbLibrary** binary for your **OS** [here](https://github.com/DanielSWolf/rhubarb-lip-sync/releases) and put it in your `bin` folder. `rhubarb` executable should be accessible through `bin/rhubarb`.

3. Install Redis locally or use a Docker container:
   ```bash
   docker run -d --name lolly-redis -p 6379:6379 redis:6.2.6
   ```

4. Install dependencies and start both API and worker services:
   ```bash
   yarn
   yarn start:dev
   ```

## Fly.io Deployment

### 1. Install Fly CLI

```bash
curl -L https://fly.io/install.sh | sh
```

### 2. Login to Fly.io

```bash
fly auth login
```

### 3. Create Persistent Volumes

```bash
# Create volume for audio files
fly volumes create lolly_audio_data --size 10 --region sjc

# Create volume for Redis data
fly volumes create lolly_redis_data --size 5 --region sjc
```

### 4. Deploy Redis Instance

```bash
# Generate a strong password
REDIS_PASSWORD=$(openssl rand -hex 16)

# Create Redis app
fly secrets set REDIS_PASSWORD=$REDIS_PASSWORD --app lolly-redis

# Deploy Redis
fly deploy -c redis-fly.toml
```

### 5. Deploy API Service

```bash
# Set required secrets
fly secrets set OPENAI_API_KEY=your_openai_api_key --app lolly-backend
fly secrets set ELEVEN_LABS_API_KEY=your_elevenlabs_api_key --app lolly-backend
fly secrets set REDIS_PASSWORD=$REDIS_PASSWORD --app lolly-backend
fly secrets set REDIS_HOST=lolly-redis.internal --app lolly-backend

# Deploy API service
fly deploy -c fly.toml
```

### 6. Deploy Worker Service

```bash
# Set required secrets (same as API but for worker app)
fly secrets set OPENAI_API_KEY=your_openai_api_key --app lolly-worker
fly secrets set ELEVEN_LABS_API_KEY=your_elevenlabs_api_key --app lolly-worker
fly secrets set REDIS_PASSWORD=$REDIS_PASSWORD --app lolly-worker
fly secrets set REDIS_HOST=lolly-redis.internal --app lolly-worker

# Deploy worker service
fly deploy -c worker-fly.toml
```

## Scaling

### Scale Workers

```bash
# Scale workers based on workload
fly scale count 3 --app lolly-worker
```

### Scale API Instances

```bash
# Scale API instances based on traffic
fly scale count 2 --app lolly-backend
```

### Scale Redis (If Needed)

```bash
# Upgrade Redis to dedicated VM
fly scale vm dedicated-cpu-1x --app lolly-redis
```

## Monitoring

Monitor your application using Fly.io's built-in metrics:

```bash
fly metrics --app lolly-backend
fly metrics --app lolly-worker
fly metrics --app lolly-redis
```

## Frontend Integration

Update your frontend to work with the asynchronous workflow:

1. Send a message to the `/chat` endpoint
2. Receive a `jobId` and poll the `/status/:jobId` endpoint
3. Once the job is complete, display the results

## Cleanup Strategy

The system automatically manages audio files by:
- Organizing files by user ID
- Using unique session IDs for each conversation
- BullMQ's built-in job cleanup (completed jobs removed after 1 hour)
