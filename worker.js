import { Worker } from 'bullmq';
import dotenv from 'dotenv';
import voice from 'elevenlabs-node';
import express from 'express';
import { promises as fs, existsSync, mkdirSync } from 'fs';
import OpenAI from 'openai';
import { exec } from 'child_process';
import { nanoid } from 'nanoid';
import path from 'path';
import pino from 'pino';

dotenv.config();

// Create logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "-",
});

// Initialize ElevenLabs
const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
const voiceID = process.env.ELEVEN_LABS_VOICE_ID || "4tRn1lSkEn13EVTuqb0g";

// Setup Redis connection
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';

// Create audios directory if it doesn't exist
const AUDIO_DIR = process.env.AUDIO_DIR || 'audios';
if (!existsSync(AUDIO_DIR)) {
  mkdirSync(AUDIO_DIR, { recursive: true });
}

// Create directories for users if needed
function ensureUserDir(userId) {
  const userDir = path.join(AUDIO_DIR, userId);
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

// Helper function to execute shell commands
const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        logger.error({ error, command, stderr }, 'Command execution failed');
        reject(error);
      }
      resolve(stdout);
    });
  });
};

// Process message to generate audio and lip sync data
async function processMessage(userId, messageIndex, text, facialExpression, animation) {
  const sessionId = nanoid(10);
  const userDir = ensureUserDir(userId);
  const basePath = path.join(userDir, `message_${sessionId}_${messageIndex}`);
  const mp3Path = `${basePath}.mp3`;
  const wavPath = `${basePath}.wav`;
  const jsonPath = `${basePath}.json`;
  
  logger.info({ userId, sessionId, messageIndex }, 'Processing message');
  
  try {
    // Generate audio with ElevenLabs
    await voice.textToSpeech(elevenLabsApiKey, voiceID, mp3Path, text);
    
    // Convert MP3 to WAV
    await execCommand(`ffmpeg -y -i ${mp3Path} ${wavPath}`);
    
    // Generate lip sync data
    await execCommand(`./bin/rhubarb -f json -o ${jsonPath} ${wavPath} -r phonetic`);
    
    // Read results
    const audioBase64 = await audioFileToBase64(mp3Path);
    const lipsyncData = await readJsonTranscript(jsonPath);
    
    return {
      text,
      audio: audioBase64,
      lipsync: lipsyncData,
      facialExpression,
      animation,
      audioPath: mp3Path,
      sessionId
    };
  } catch (error) {
    logger.error({ error, userId, sessionId, messageIndex }, 'Failed to process message');
    throw error;
  }
}

// Read JSON lip sync data
const readJsonTranscript = async (file) => {
  try {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error({ error, file }, 'Failed to read JSON transcript');
    throw error;
  }
};

// Convert audio file to base64
const audioFileToBase64 = async (file) => {
  try {
    const data = await fs.readFile(file);
    return data.toString('base64');
  } catch (error) {
    logger.error({ error, file }, 'Failed to convert audio to base64');
    throw error;
  }
};

// Initialize worker for chat processing
const worker = new Worker('chat-processing', async job => {
  const { userId, userMessage } = job.data;
  
  logger.info({ userId, jobId: job.id }, 'Processing chat job');
  
  try {
    // OpenAI API call to generate response
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-1106",
      max_tokens: 1000,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
          You are a virtual girlfriend.
          You will always reply with a JSON array of messages. With a maximum of 3 messages.
          Each message has a text, facialExpression, and animation property.
          The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
          The different animations are: Talking_0, Talking_1, Talking_2, Crying, Laughing, Rumba, Idle, Terrified, and Angry. 
          `
        },
        {
          role: "user",
          content: userMessage || "Hello"
        }
      ]
    });
    
    // Parse OpenAI response
    let messages = JSON.parse(completion.choices[0].message.content);
    if (messages.messages) {
      messages = messages.messages;
    }
    
    // Process each message
    const processedMessages = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const processedMessage = await processMessage(
        userId,
        i,
        message.text,
        message.facialExpression,
        message.animation
      );
      processedMessages.push(processedMessage);
      
      // Update job progress
      await job.updateProgress(((i + 1) / messages.length) * 100);
    }
    
    return { messages: processedMessages };
  } catch (error) {
    logger.error({ error, userId, jobId: job.id }, 'Chat processing failed');
    throw error;
  }
}, {
  connection: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
  },
  concurrency: 2, // Process 2 jobs concurrently
  removeOnComplete: {
    age: 3600, // Keep completed jobs for 1 hour
    count: 100, // Keep last 100 completed jobs
  },
  removeOnFail: {
    age: 24 * 3600, // Keep failed jobs for 24 hours
  },
});

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id }, 'Job completed successfully');
});

worker.on('failed', (job, error) => {
  logger.error({ jobId: job.id, error: error.message }, 'Job failed');
});

// Health check endpoint
const app = express();
const PORT = process.env.PORT || 8081;

app.get('/health', (req, res) => {
  res.status(200).send({ status: 'healthy', worker: 'running' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Worker service started');
}); 