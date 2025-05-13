import cors from "cors";
import dotenv from "dotenv";
import voice from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import OpenAI from "openai";
import { Queue } from "bullmq";
import Redis from 'ioredis';
import { nanoid } from "nanoid";
import pinoHttp from "pino-http";
import path from "path";
import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';

dotenv.config();

const lookupPromise = promisify(dns.lookup);

// Initialize logger
const logger = pinoHttp({
  level: process.env.LOG_LEVEL || "info",
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "-",
});

// Initialize ElevenLabs
const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
const voiceID = process.env.ELEVEN_LABS_VOICE_ID || "4tRn1lSkEn13EVTuqb0g";

// Setup Redis connection using the full URL
const UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_URL;

// Function to create Redis connection
async function createRedisClient() {
  if (UPSTASH_REDIS_URL) {
    try {
      const parsedUrl = new URL(UPSTASH_REDIS_URL);
      const hostname = parsedUrl.hostname;
      const password = parsedUrl.password;
      const port = parsedUrl.port || "6379";

      console.log(`[index.js] Attempting to resolve hostname: ${hostname}`);
      const { address: resolvedIpAddress } = await lookupPromise(hostname, { family: 6 });
      console.log(`[index.js] Successfully resolved ${hostname} to ${resolvedIpAddress}`);

      const client = new Redis({
        host: resolvedIpAddress,  // Use the resolved IP directly, not the hostname
        port: parseInt(port, 10),
        password: password,
        family: 6, // IP is v6
        maxRetriesPerRequest: null, // Recommended for BullMQ
        enableReadyCheck: true,
        retryStrategy(times) {
          const delay = Math.min(times * 100, 3000); // Increased delay slightly
          console.error(`[index.js] Redis connection retry attempt ${times}, delaying for ${delay}ms`);
          return delay;
        },
      });
      return client;
    } catch (err) {
      console.error(`[index.js] DNS lookup or manual Redis client creation failed for ${UPSTASH_REDIS_URL}: ${err.message}`, err);
      console.warn("[index.js] Falling back to direct URL Redis connection method for BullMQ.");
      // Fallback to original method if manual resolution fails, to see if original error persists
      return new Redis(UPSTASH_REDIS_URL, {
        family: 6,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        retryStrategy(times) {
          const delay = Math.min(times * 100, 3000);
          console.error(`[index.js] Redis (fallback URL) connection retry attempt ${times}, delaying for ${delay}ms`);
          return delay;
        },
      });
    }
  } else {
    // Fallback for local development
    console.log("[index.js] Using local Redis configuration.");
    return new Redis({
      host: 'localhost',
      port: 6379,
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        console.error(`[index.js] Redis (local) connection retry attempt ${times}, delaying for ${delay}ms`);
        return delay;
      },
    });
  }
}

async function main() {
  const redisClient = await createRedisClient();

  redisClient.on('connect', () => {
    console.log('[index.js] Redis client connected.');
  });
  redisClient.on('ready', () => {
    console.log('[index.js] Redis client ready.');
  });
  redisClient.on('error', (err) => {
    console.error('[index.js] Redis Client Error:', err.message);
  });
  redisClient.on('close', () => {
    console.log('[index.js] Redis client connection closed.');
  });
  redisClient.on('reconnecting', () => {
    console.log('[index.js] Redis client reconnecting...');
  });

  // Initialize BullMQ Queue
  const chatQueue = new Queue('chat-processing', {
    connection: UPSTASH_REDIS_URL ? new Redis({
      host: 'fdaa:18:f855:0:1::2',  // Direct IPv6 address - bypasses DNS resolution
      port: 6379,
      password: new URL(UPSTASH_REDIS_URL).password,
      family: 6, // Explicitly use IPv6
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    }) : { 
      host: 'localhost', // Fallback for local dev if URL not set
      port: 6379,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        age: 3600, // 1 hour
        count: 100,
      },
      removeOnFail: {
        age: 24 * 3600, // 24 hours
      },
    },
  });

  chatQueue.on('error', (error) => {
    console.error('[index.js] BullMQ Queue Error:', error.message);
  });
  
  chatQueue.on('waiting', (jobId) => {
    // A job is waiting for a worker to process it.
    console.log(`[index.js] Job ${jobId} is waiting in BullMQ.`);
  });

  // Create Express app
  const app = express();
  app.use(express.json());
  app.use(cors());
  app.use(logger);

  const port = process.env.PORT || 8080;

  // Basic health check
  app.get("/", (req, res) => {
    res.send({ status: "ok", version: "1.0.0" });
  });

  // Get available ElevenLabs voices
  app.get("/voices", async (req, res) => {
    try {
      const voices = await voice.getVoices(elevenLabsApiKey);
      res.send(voices);
    } catch (error) {
      req.log.error({ error }, "Failed to get voices");
      res.status(500).send({ error: "Failed to get voices" });
    }
  });

  // Main chat endpoint
  app.post("/chat", async (req, res) => {
    // Get user message and generate a userId if not provided
    const userMessage = req.body.message;
    const userId = req.body.userId || nanoid(10);

    // Handle case when no message is provided - return demo intro
    if (!userMessage) {
      try {
        res.send({
          messages: [
            {
              text: "Hey dear... How was your day?",
              audio: await audioFileToBase64("audios/intro_0.wav"),
              lipsync: await readJsonTranscript("audios/intro_0.json"),
              facialExpression: "smile",
              animation: "Talking_1",
            },
            {
              text: "I missed you so much... Please don't go for so long!",
              audio: await audioFileToBase64("audios/intro_1.wav"),
              lipsync: await readJsonTranscript("audios/intro_1.json"),
              facialExpression: "sad",
              animation: "Crying",
            },
          ],
          userId,
        });
        return;
      } catch (error) {
        req.log.error({ error }, "Failed to process intro message");
        res.status(500).send({ error: "Failed to process intro message" });
        return;
      }
    }

    // Handle case when API keys aren't configured
    if (!elevenLabsApiKey || openai.apiKey === "-") {
      try {
        res.send({
          messages: [
            {
              text: "Please my dear, don't forget to add your API keys!",
              audio: await audioFileToBase64("audios/api_0.wav"),
              lipsync: await readJsonTranscript("audios/api_0.json"),
              facialExpression: "angry",
              animation: "Angry",
            },
            {
              text: "You don't want to ruin Wawa Sensei with a crazy ChatGPT and ElevenLabs bill, right?",
              audio: await audioFileToBase64("audios/api_1.wav"),
              lipsync: await readJsonTranscript("audios/api_1.json"),
              facialExpression: "smile",
              animation: "Laughing",
            },
          ],
          userId,
        });
        return;
      } catch (error) {
        req.log.error({ error }, "Failed to process API key warning message");
        res.status(500).send({ error: "Failed to process API key warning message" });
        return;
      }
    }

    try {
      // Create a new job in the queue
      const job = await chatQueue.add('process-chat', {
        userId,
        userMessage,
      });

      req.log.info({ jobId: job.id, userId }, 'Chat job created');

      // Send immediate response with job ID
      res.status(202).send({
        status: 'processing',
        jobId: job.id,
        userId,
      });
    } catch (error) {
      req.log.error({ error, userId }, "Failed to create chat job");
      res.status(500).send({ error: "Failed to create chat job" });
    }
  });

  // Endpoint to check job status
  app.get("/status/:jobId", async (req, res) => {
    const { jobId } = req.params;
    
    try {
      const job = await chatQueue.getJob(jobId);
      
      if (!job) {
        return res.status(404).send({ error: "Job not found" });
      }
      
      const state = await job.getState();
      const progress = job.progress;
      
      if (state === 'completed') {
        const result = job.returnvalue;
        return res.send({ 
          status: 'completed',
          result 
        });
      }
      
      if (state === 'failed') {
        const failedReason = job.failedReason;
        return res.status(500).send({ 
          status: 'failed',
          error: failedReason
        });
      }
      
      res.send({
        status: state,
        progress,
      });
    } catch (error) {
      req.log.error({ error, jobId }, "Failed to get job status");
      res.status(500).send({ error: "Failed to get job status" });
    }
  });

  // Helper to read JSON files
  const readJsonTranscript = async (file) => {
    try {
      const data = await fs.readFile(file, "utf8");
      return JSON.parse(data);
    } catch (error) {
      console.error(`Error reading JSON file ${file}:`, error);
      throw error;
    }
  };

  // Helper to convert audio to base64
  const audioFileToBase64 = async (file) => {
    try {
      const data = await fs.readFile(file);
      return data.toString("base64");
    } catch (error) {
      console.error(`Error converting audio file ${file} to base64:`, error);
      throw error;
    }
  };

  // Start the server
  app.listen(port, () => {
    console.log(`Virtual Girlfriend API listening on port ${port}`);
  });
}

main().catch(err => {
  console.error("[index.js] Application startup failed:", err.message, err.stack);
  process.exit(1);
});
