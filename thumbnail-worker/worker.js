import express from 'express'
import { createClient } from 'redis'

const app = express()

const PORT = Number(process.env.PORT || 3005)
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const QUEUE_NAME = process.env.THUMBNAIL_QUEUE_NAME || 'thumbnail-jobs'
const DEAD_LETTER_QUEUE_NAME =
  process.env.THUMBNAIL_DEAD_LETTER_QUEUE_NAME || 'thumbnail-dead-letter'
const LAST_SUCCESS_KEY =
  process.env.THUMBNAIL_LAST_SUCCESS_KEY ||
  'thumbnail-worker:last-successfully-processed-job-at'
const THUMBNAIL_COMPLETE_CHANNEL =
  process.env.THUMBNAIL_COMPLETE_CHANNEL || 'thumbnail.complete'
const PROCESSING_DELAY_MS = Number(process.env.THUMBNAIL_PROCESSING_DELAY_MS || 250)

const redis = createClient({ url: REDIS_URL })
const workerRedis = createClient({ url: REDIS_URL })