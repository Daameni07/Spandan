import { env } from '../utils/env.js';
import mongoose from 'mongoose';

export const dbConfig = {
  url: env('DB_URL'),
  dbName: env('DB_NAME') || 'PollDB',
};

export async function connectToDatabase() {
  const isDevelopment = env('NODE_ENV') !== 'production';
  const databaseUrl = dbConfig.url;

  // Skip database connection in development if no DB_URL is set
  if (!databaseUrl || !databaseUrl.trim()) {
    if (isDevelopment) {
      console.warn('⚠️ No DB_URL configured. Running in mock mode (DB operations will be stubbed).');
      return;
    }
    console.error('❌ DB_URL required in production');
    process.exit(1);
  }

  try {
    await mongoose.connect(databaseUrl, {
      dbName: dbConfig.dbName,
    });
    console.log('✅ Connected to MongoDB:', dbConfig.dbName);
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    if (!isDevelopment) {
      process.exit(1);
    }
    console.warn('⚠️ Continuing in development mode without database.');
  }
}
