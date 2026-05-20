// backend/src/shared/database/models/Room.ts
// FIXES:
//   1. coHostInvite default changed from () => ({}) to a proper factory with
//      all fields present — Mongoose was throwing a cast/validation error on save
//      because the empty object didn't satisfy the subdocument shape.
//   2. recordingLock marked as { type: RecordingLockSchema, default: null } with
//      explicit null so Mongoose never tries to coerce undefined → subdoc.
//   3. Added { strict: false } is NOT used — instead all fields are explicit so
//      there are no silent cast errors.
//   4. Removed `required: true` from RecordingLockSchema.userId because the field
//      is stored inside an optional parent; required on a child of a nullable parent
//      causes validation errors when the lock is null.

import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

export interface IRecordingLock {
  userId: string;
  userName?: string;
  lockedAt: Date;
  expiresAt: Date;
}

export interface ICoHost {
  userId: string;
  addedBy: string;
  isActive: boolean;
  addedAt: Date;
  isMicMuted: boolean;
}

export interface ICoHostInvite {
  inviteId?: string;
  createdAt?: Date;
  expiresAt?: Date;
  isActive: boolean;
}

export interface IRoomControls {
  micBlocked: boolean;
  pollRestricted: boolean;
  autoGenerationPaused: boolean;
}

export interface IPollAnswer {
  userId: string;
  answerIndex: number;
  answeredAt: Date;
  points?: number;
}

export interface IPoll {
  _id: string;
  question: string;
  options: string[];
  correctOptionIndex: number;
  timer?: number;
  maxPoints?: number;
  createdAt: Date;
  lockedActiveUsers?: string[];
  answers: IPollAnswer[];
}

export interface IGeneratedQuestion {
  question: string;
  options: string[];
  correctOptionIndex: number;
}

export interface IRoom extends Document {
  roomCode: string;
  name: string;
  teacherId: string;
  teacherName?: string;
  status: 'active' | 'ended';
  createdAt: Date;
  endedAt?: Date;
  students: mongoose.Types.ObjectId[];
  joinedStudents: string[];
  polls: IPoll[];
  generatedQuestions: IGeneratedQuestion[];
  coHosts: ICoHost[];
  coHostInvite: ICoHostInvite;
  recordingLock?: IRecordingLock | null;
  controls: IRoomControls;
}

const PollAnswerSchema = new Schema<IPollAnswer>(
  {
    userId: { type: String, required: true },
    answerIndex: { type: Number, required: true },
    answeredAt: { type: Date, default: Date.now },
    points: { type: Number, default: 0 },
  },
  { _id: false }
);

const PollSchema = new Schema<IPoll>({
  _id: { type: String, default: () => crypto.randomUUID() },
  question: { type: String, required: true },
  options: [{ type: String }],
  correctOptionIndex: { type: Number, required: true },
  timer: { type: Number, default: 30 },
  maxPoints: { type: Number, default: 20 },
  createdAt: { type: Date, default: Date.now },
  lockedActiveUsers: [{ type: String }],
  answers: [PollAnswerSchema],
});

const CoHostSchema = new Schema<ICoHost>(
  {
    userId: { type: String, required: true },
    addedBy: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    addedAt: { type: Date, default: Date.now },
    isMicMuted: { type: Boolean, default: false },
  },
  { _id: false }
);

const CoHostInviteSchema = new Schema<ICoHostInvite>(
  {
    // All fields optional — the invite may not exist yet when the room is created
    inviteId: { type: String, default: null },
    createdAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    isActive: { type: Boolean, default: false },
  },
  { _id: false }
);

// FIX: userId is NOT marked required here.
// When recordingLock is null (the normal idle state), Mongoose must not
// run required-field validation on the subdocument's children.
const RecordingLockSchema = new Schema<IRecordingLock>(
  {
    userId: { type: String },          // ← was required:true, caused validation errors
    userName: { type: String, default: '' },
    lockedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
  },
  { _id: false }
);

const RoomControlsSchema = new Schema<IRoomControls>(
  {
    micBlocked: { type: Boolean, default: false },
    pollRestricted: { type: Boolean, default: false },
    autoGenerationPaused: { type: Boolean, default: false },
  },
  { _id: false }
);

const RoomSchema = new Schema<IRoom>({
  roomCode: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  teacherId: { type: String, required: true },
  teacherName: { type: String, default: '' },
  status: { type: String, enum: ['active', 'ended'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  students: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  joinedStudents: [{ type: String }],
  polls: [PollSchema],
  generatedQuestions: {
    type: [
      new Schema<IGeneratedQuestion>(
        {
          question: { type: String, required: true },
          options: [{ type: String, required: true }],
          correctOptionIndex: { type: Number, required: true },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
  coHosts: { type: [CoHostSchema], default: [] },

  // FIX: default is a factory returning all fields with safe fallbacks.
  // Previously () => ({}) produced an empty object that failed Mongoose
  // subdocument coercion on .save(), causing a 500 on createRoom.
  coHostInvite: {
    type: CoHostInviteSchema,
    default: () => ({
      inviteId: null,
      createdAt: null,
      expiresAt: null,
      isActive: false,
    }),
  },

  // FIX: explicit null default + no required children = no validation error
  // when the room is created without a recording lock.
  recordingLock: {
    type: RecordingLockSchema,
    default: null,
  },

  controls: {
    type: RoomControlsSchema,
    default: () => ({
      micBlocked: false,
      pollRestricted: false,
      autoGenerationPaused: false,
    }),
  },
});

// Prevent OverwriteModelError in hot-reload / test environments
export const Room =
  (mongoose.models.Room as mongoose.Model<IRoom>) ||
  mongoose.model<IRoom>('Room', RoomSchema);