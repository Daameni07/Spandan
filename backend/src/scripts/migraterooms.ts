// backend/src/scripts/migrateRooms.ts
// Run once to fix existing Room documents that are missing required fields
// Usage: npx ts-node src/scripts/migrateRooms.ts

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function migrate() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error('DB_URL not set in .env');
    process.exit(1);
  }

  await mongoose.connect(dbUrl);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const rooms = db.collection('rooms');

  // Fix 1: Add missing recordingLock field (null) to rooms that don't have it
  const r1 = await rooms.updateMany(
    { recordingLock: { $exists: false } },
    { $set: { recordingLock: null } }
  );
  console.log(`Fixed recordingLock on ${r1.modifiedCount} rooms`);

  // Fix 2: Add missing controls field
  const r2 = await rooms.updateMany(
    { controls: { $exists: false } },
    { $set: { controls: { micBlocked: false, pollRestricted: false, autoGenerationPaused: false } } }
  );
  console.log(`Fixed controls on ${r2.modifiedCount} rooms`);

  // Fix 3: Add missing autoGenerationPaused in existing controls
  const r3 = await rooms.updateMany(
    { 'controls.autoGenerationPaused': { $exists: false } },
    { $set: { 'controls.autoGenerationPaused': false } }
  );
  console.log(`Fixed autoGenerationPaused on ${r3.modifiedCount} rooms`);

  // Fix 4: Ensure coHosts array exists
  const r4 = await rooms.updateMany(
    { coHosts: { $exists: false } },
    { $set: { coHosts: [] } }
  );
  console.log(`Fixed coHosts on ${r4.modifiedCount} rooms`);

  await mongoose.disconnect();
  console.log('Migration complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});